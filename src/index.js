/**
 * Cloudflare Worker 入口
 * ------------------------------------------------------------------
 * 路由：
 *   GET  /             前端页面（iOS 液态玻璃）
 *   GET  /api/data     最新榜单快照 JSON（缺失/过期时后台自愈抓取）
 *   POST /api/refresh  手动触发抓取（可选 REFRESH_TOKEN 保护）
 *   GET  /healthz      健康检查
 *
 * 定时：
 *   wrangler.toml 中 crons = ["0 * * * *"]，每小时整点抓取一次，
 *   结果写入 KV（data:latest 最新 + data:YYYY-MM-DD 每日归档，保留 90 天）。
 */

import { refreshAll, buildFallbackSnapshot, fetchWithTimeout, AA_API, probeHf } from './sources.js';
import { renderPage } from './frontend.js';

const KV_LATEST = 'data:latest';
const STALE_MS = 25 * 60 * 60 * 1000; // 超过 25 小时视为过期
const ARCHIVE_TTL = 90 * 24 * 60 * 60; // 归档保留 90 天

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

async function readSnapshot(env) {
  if (!env.LEADERBOARD_KV) return null;
  try {
    return (await env.LEADERBOARD_KV.get(KV_LATEST, 'json')) || null;
  } catch (_) {
    return null;
  }
}

async function saveSnapshot(env, snap) {
  if (!env.LEADERBOARD_KV) return;
  await env.LEADERBOARD_KV.put(KV_LATEST, JSON.stringify(snap));
  const day = (snap.generatedAt || new Date().toISOString()).slice(0, 10);
  await env.LEADERBOARD_KV.put(`data:${day}`, JSON.stringify(snap), {
    expirationTtl: ARCHIVE_TTL,
  });
}

/**
 * 合并旧快照：本次抓取失败的源，若旧快照有成功数据则复用（标 stale），
 * 避免偶发故障/限流（如 AA 429）导致整个榜单从页面上消失。
 */
function mergeStaleSources(prev, snap) {
  if (!prev) return snap;
  for (const s of snap.sources) {
    if (s.status !== 'unavailable') continue;
    const old = (prev.sources || []).find((x) => x.id === s.id);
    if (old && old.entries && old.entries.length) {
      s.status = 'stale';
      s.entries = old.entries;
      s.error = String(s.error || '抓取失败') + '（本次抓取失败，展示上次成功的数据）';
    }
  }
  return snap;
}

async function refreshAndSave(env) {
  try {
    const prev = await readSnapshot(env);
    const snap = mergeStaleSources(prev, await refreshAll(env));
    await saveSnapshot(env, snap);
  } catch (_) {
    // 定时抓取整体失败时不抛出，等下一次 cron
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ---- 前端页面 ----
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(renderPage(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // 不缓存 HTML：旧版页面 JS 会在新数据格式下出问题（曾出现缓存页加载失败）
          'cache-control': 'no-store',
        },
      });
    }

    // ---- 榜单数据 JSON ----
    if (pathname === '/api/data') {
      const snap = await readSnapshot(env);
      if (!snap) {
        // KV 里还没有数据：立即返回内置快照，同时后台抓取，下次访问即是实时数据
        ctx.waitUntil(refreshAndSave(env));
        return jsonResponse(buildFallbackSnapshot());
      }
      const age = Date.now() - new Date(snap.generatedAt).getTime();
      if (age > STALE_MS) {
        ctx.waitUntil(refreshAndSave(env)); // 过期了先返回旧的，后台更新
      }
      return jsonResponse(snap);
    }

    // ---- 手动刷新 ----
    if (pathname === '/api/refresh') {
      const token = env.REFRESH_TOKEN;
      if (token) {
        const provided = url.searchParams.get('token') || request.headers.get('x-refresh-token') || '';
        if (provided !== token) {
          return jsonResponse({ error: '未授权：需要正确的 REFRESH_TOKEN' }, { status: 401 });
        }
      }
      const prev = await readSnapshot(env);
      const snap = mergeStaleSources(prev, await refreshAll(env));
      await saveSnapshot(env, snap);
      return jsonResponse(snap);
    }

    // ---- 健康检查（含数据源诊断：每个源的失败原因一眼可见） ----
    if (pathname === '/healthz') {
      const snap = await readSnapshot(env);
      const key = env && env.AA_API_KEY;
      // 实时探测一次 AA 接口：用于区分「key 问题」与「Worker 出口被 AA 拦截」
      let aaProbe = null;
      if (key) {
        try {
          const res = await fetchWithTimeout(`${AA_API}?page=1`, {
            headers: { 'x-api-key': key },
          }, 15000);
          if (res.ok) {
            const j = await res.json();
            aaProbe = { reachable: true, http: res.status, items: (j.data || []).length };
          } else {
            aaProbe = { reachable: false, http: res.status };
          }
        } catch (err) {
          aaProbe = { reachable: false, http: null, error: String((err && err.message) || err) };
        }
      }
      // 实时探测 HF datasets-server：区分「Worker 出口被 HF 拦截」与「代码/数据问题」
      const hfProbe = await probeHf();
      // 完整 dry-run 抓取一次（不写 KV）：直接暴露生产环境的真实抓取行为
      let dryRun = null;
      try {
        const t0 = Date.now();
        const dry = await refreshAll(env);
        dryRun = {
          ms: Date.now() - t0,
          sources: dry.sources.map((s) => ({
            id: s.id,
            status: s.status,
            count: (s.entries || []).length,
            error: s.error ? String(s.error).slice(0, 200) : null,
          })),
        };
      } catch (err) {
        dryRun = { error: String((err && err.message) || err).slice(0, 300) };
      }
      return jsonResponse({
        ok: true,
        kvBound: Boolean(env.LEADERBOARD_KV),
        lastGeneratedAt: snap ? snap.generatedAt : null,
        now: new Date().toISOString(),
        aaKeyPresent: Boolean(key),
        aaKeyPrefix: key ? String(key).slice(0, 4) + '…' : null,
        aaProbe,
        hfProbe,
        dryRun,
        sources: ((snap && snap.sources) || []).map((s) => ({
          id: s.id,
          status: s.status,
          count: (s.entries || []).length,
          error: s.error || null,
        })),
      });
    }

    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  /** cron 触发：每日抓取并归档 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAndSave(env));
  },
};

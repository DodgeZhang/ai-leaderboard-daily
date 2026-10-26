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

import { refreshAll, buildFallbackSnapshot, fetchWithTimeout, AA_API, probeHf, aaKeys } from './sources.js';
import { renderPage } from './frontend.js';

const KV_LATEST = 'data:latest';
const KV_AA_LAST_OK = 'meta:aa-last-ok'; // 上次 AA 成功抓取时间（配额节流依据）
const STALE_MS = 25 * 60 * 60 * 1000; // 超过 25 小时视为过期
const ARCHIVE_TTL = 90 * 24 * 60 * 60; // 归档保留 90 天
/* AA 配额节流：免费额度仅 100 次/24h，且同一账户下所有 key 共享配额；
   一次全量抓取要 6 页 ≈ 6 次请求——每小时 cron 不节流会烧 144 请求/天，必然超限。
   距上次成功不足 20h 就跳过抓取，直接复用旧数据（标 stale），一天最多抓 1-2 次。 */
const AA_FETCH_TTL_MS = 20 * 60 * 60 * 1000;

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
      // 文案去重：节流跳过等原因里已说明"展示上次成功数据"就不再追加后缀
      const base = String(s.error || '抓取失败');
      s.error = /跳过|上次成功/.test(base) ? base : base + '（本次抓取失败，展示上次成功的数据）';
    }
  }
  return snap;
}

async function readAaLastOk(env) {
  if (!env.LEADERBOARD_KV) return null;
  try {
    return (await env.LEADERBOARD_KV.get(KV_AA_LAST_OK)) || null;
  } catch (_) {
    return null;
  }
}

async function writeAaLastOk(env) {
  if (!env.LEADERBOARD_KV) return;
  try {
    await env.LEADERBOARD_KV.put(KV_AA_LAST_OK, new Date().toISOString());
  } catch (_) {
    // 写不进去也不影响主流程（下次多抓一次而已）
  }
}

/**
 * AA 配额节流：距上次成功抓取不足 AA_FETCH_TTL_MS 时，给 env 打上
 * __aaSkipReason 标记——fetchArtificialAnalysis 会直接抛错（不发请求），
 * 随后 mergeStaleSources 复用旧数据标 stale。force=true 时跳过（手动强刷）。
 */
async function throttleAa(env, force) {
  if (force || !aaKeys(env).length) return env;
  const lastOk = await readAaLastOk(env);
  if (!lastOk) return env;
  const age = Date.now() - new Date(lastOk).getTime();
  if (Number.isFinite(age) && age >= 0 && age < AA_FETCH_TTL_MS) {
    const hours = (age / 3600e3).toFixed(1);
    return {
      ...env,
      __aaSkipReason: `AA 免费配额有限（100 次/24h，同账户所有 key 共享），${hours}h 前刚成功抓取过，本次跳过（展示上次成功数据）`,
    };
  }
  return env;
}

async function refreshAndSave(env, opts = {}) {
  try {
    const prev = await readSnapshot(env);
    const throttled = await throttleAa(env, opts.force);
    const snap = mergeStaleSources(prev, await refreshAll(throttled));
    await saveSnapshot(env, snap);
    // 只有本次真的抓成功了才刷新时间戳（被节流跳过/抓取失败都不算）
    const aa = snap.sources.find((s) => s.id === 'aa-llm');
    if (aa && aa.status === 'live') await writeAaLastOk(env);
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
      // 默认同样受 AA 配额节流保护（防止连点刷新烧光 100 次/24h 额度）；
      // ?force=1 可强制抓取 AA（给真正需要立即更新 AA 的场景）
      const force = url.searchParams.get('force') === '1';
      const prev = await readSnapshot(env);
      const throttled = await throttleAa(env, force);
      const snap = mergeStaleSources(prev, await refreshAll(throttled));
      await saveSnapshot(env, snap);
      const aa = snap.sources.find((s) => s.id === 'aa-llm');
      if (aa && aa.status === 'live') await writeAaLastOk(env);
      return jsonResponse(snap);
    }

    // ---- 健康检查（含数据源诊断：每个源的失败原因一眼可见） ----
    if (pathname === '/healthz') {
      const snap = await readSnapshot(env);
      const keys = aaKeys(env);
      // 实时探测一次 AA 接口：用于区分「key 问题」与「Worker 出口被 AA 拦截」
      let aaProbe = null;
      if (keys.length) {
        try {
          const res = await fetchWithTimeout(`${AA_API}?page=1`, {
            headers: { 'x-api-key': keys[0] },
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
      // （同样应用 AA 配额节流——否则每次看 healthz 都白烧 6 次请求）
      let dryRun = null;
      try {
        const t0 = Date.now();
        const dry = await refreshAll(await throttleAa(env, false));
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
        aaKeyPresent: keys.length > 0,
        aaKeyCount: keys.length,
        aaKeyPrefix: keys[0] ? String(keys[0]).slice(0, 4) + '…' : null,
        aaLastOkAt: await readAaLastOk(env),
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

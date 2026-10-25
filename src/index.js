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
 *   wrangler.toml 中 crons = ["0 8 * * *"]，每天 16:00（北京时间）抓取，
 *   结果写入 KV（data:latest 最新 + data:YYYY-MM-DD 每日归档，保留 90 天）。
 */

import { refreshAll, buildFallbackSnapshot } from './sources.js';
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

async function refreshAndSave(env) {
  try {
    const snap = await refreshAll(env);
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
          'cache-control': 'public, max-age=120',
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
      const snap = await refreshAll(env);
      await saveSnapshot(env, snap);
      return jsonResponse(snap);
    }

    // ---- 健康检查 ----
    if (pathname === '/healthz') {
      const snap = await readSnapshot(env);
      return jsonResponse({
        ok: true,
        kvBound: Boolean(env.LEADERBOARD_KV),
        lastGeneratedAt: snap ? snap.generatedAt : null,
        now: new Date().toISOString(),
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

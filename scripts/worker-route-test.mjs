/**
 * Worker 路由级端到端测试（mock KV + mock fetch，无网络依赖）
 * 直接调用 index.js 默认导出的 fetch / scheduled 处理器。
 * 运行：node scripts/worker-route-test.mjs
 */

import assert from 'node:assert/strict';
import worker from '../src/index.js';

/* ---------- mock KV ---------- */
const store = new Map();
const env = {
  LEADERBOARD_KV: {
    get: async (k, type) => {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
  },
};
const pending = [];
const ctx = {
  waitUntil: (p) => { pending.push(Promise.resolve(p)); },
};
/** 模拟运行时：等待所有 waitUntil 注册的后台任务完成 */
async function flush() {
  while (pending.length) await pending.shift();
}

/* ---------- mock fetch（HF datasets-server filter/rows + AA） ---------- */
const LICENSES = ['Proprietary', 'MIT', 'Apache 2.0'];
const mkRow = (i, patch) => Object.assign({
  model_name: 'model-' + (i + 1),
  organization: ['Anthropic', 'OpenAI', 'Google'][i % 3],
  license: LICENSES[i % LICENSES.length],
  rank: i + 1,
  category: 'overall',
  leaderboard_publish_date: '2026-10-24',
}, patch);

const HF = {
  text_style_control: Array.from({ length: 30 }, (_, i) => ({
    row_idx: i,
    row: mkRow(i, { rating: 1450 - i, rating_lower: 1448 - i, rating_upper: 1452 - i }),
  })),
  agent: Array.from({ length: 10 }, (_, i) => ({
    row_idx: i,
    row: mkRow(i, {
      model_name: 'agent-model-' + (i + 1),
      score: 0.2 - i * 0.01, score_ci_lower: 0.19 - i * 0.01, score_ci_upper: 0.21 - i * 0.01,
    }),
  })),
  search_style_control: Array.from({ length: 10 }, (_, i) => ({
    row_idx: i,
    row: mkRow(i, {
      model_name: 'search-model-' + (i + 1),
      rating: 1200 - i, rating_lower: 1197 - i, rating_upper: 1203 - i,
    }),
  })),
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const respond = (body, ct = 'application/json; charset=utf-8', status = 200) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': ct } });
  if (u.startsWith('https://datasets-server.huggingface.co/filter')) {
    const cfg = new URL(u).searchParams.get('config');
    const offset = Number(new URL(u).searchParams.get('offset') || 0);
    const all = (HF[cfg] || []).map((r) => r.row).filter((r) => r.category === 'overall');
    const page = all.slice(offset, offset + 100);
    return respond({ features: [], rows: page.map((row, i) => ({ row_idx: offset + i, row })), num_rows_total: all.length, num_rows_per_page: 100 });
  }
  if (u.startsWith('https://datasets-server.huggingface.co/rows')) {
    const cfg = new URL(u).searchParams.get('config');
    const offset = Number(new URL(u).searchParams.get('offset') || 0);
    const all = HF[cfg] || [];
    return respond({ features: [], rows: all.slice(offset, offset + 100), num_rows_total: all.length, num_rows_per_page: 100 });
  }
  if (u.includes('artificialanalysis.ai')) {
    return respond({ status: 200, data: [], pagination: { has_more: false } });
  }
  return respond('<html>spa</html>', 'text/html; charset=utf-8');
};

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('worker route test\n');

await t('GET / 返回液态玻璃 HTML 页面', async () => {
  const res = await worker.fetch(new Request('http://localhost/'), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.ok(body.includes('AI 排行榜'));
  assert.ok(body.includes('backdrop-filter'));
});

await t('GET /api/data（KV 为空）返回空快照并触发后台抓取', async () => {
  const res = await worker.fetch(new Request('http://localhost/api/data'), env, ctx);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.sources.length, 0);
  assert.ok(data.generatedAt);
  // 后台抓取已由 waitUntil 调度，flush 后 KV 应已写入
  await flush();
  assert.ok(store.has('data:latest'));
});

await t('GET /api/data（KV 有数据）返回实时快照', async () => {
  const res = await worker.fetch(new Request('http://localhost/api/data'), env, ctx);
  const data = await res.json();
  const text = data.sources.find((s) => s.id === 'arena-text');
  assert.equal(text.status, 'live');
  assert.equal(text.entries.length, 30); // mock 30 行全部返回（不截断）
  assert.equal(text.entries[0].model, 'model-1');
  assert.equal(text.entries[0].rank, 1);
  assert.equal(text.entries[0].open, false); // Proprietary
  assert.equal(text.entries[1].open, true);  // MIT
});

await t('POST /api/refresh 手动刷新并写入 KV', async () => {
  const res = await worker.fetch(new Request('http://localhost/api/refresh', { method: 'POST' }), env, ctx);
  assert.equal(res.status, 200);
  const data = await res.json();
  const live = data.sources.filter((s) => s.status === 'live');
  assert.equal(live.length, 3); // 三个 Arena 分榜
  assert.ok(store.has('data:latest'));
});

await t('scheduled 定时任务写入 KV', async () => {
  await worker.scheduled({ scheduled: true, cron: '0 8 * * *' }, env, ctx);
  assert.ok(store.has('data:latest'));
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(store.has('data:' + day), '每日归档缺失');
});

await t('GET /healthz 健康检查', async () => {
  const res = await worker.fetch(new Request('http://localhost/healthz'), env, ctx);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.kvBound, true);
  assert.ok(data.lastGeneratedAt);
});

await t('未知路径返回 404', async () => {
  const res = await worker.fetch(new Request('http://localhost/nope'), env, ctx);
  assert.equal(res.status, 404);
});

await t('REFRESH_TOKEN 保护生效', async () => {
  const env2 = { ...env, REFRESH_TOKEN: 'secret123' };
  const bad = await worker.fetch(new Request('http://localhost/api/refresh', { method: 'POST' }), env2, ctx);
  assert.equal(bad.status, 401);
  const good = await worker.fetch(
    new Request('http://localhost/api/refresh?token=secret123', { method: 'POST' }), env2, ctx);
  assert.equal(good.status, 200);
});

console.log(`\n全部通过：${passed} 项 ✓`);

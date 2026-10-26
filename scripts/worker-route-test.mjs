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

globalThis.fetch = async (url, opts = {}) => {
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
    // aa_bad → 401；aa_exhausted → 429（配额耗尽）；其余 key 正常返回数据
    const k = opts && opts.headers && opts.headers['x-api-key'];
    if (k === 'aa_bad') return respond({ error: 'Unauthorized' }, 'application/json', 401);
    if (k === 'aa_exhausted') return respond({ error: 'rate limited' }, 'application/json', 429);
    return respond({
      status: 200,
      data: [
        {
          name: 'AA-Model-1', model_creator: { name: 'OpenAI' },
          evaluations: { artificial_analysis_intelligence_index: 70.5 },
          pricing: { price_1m_input_tokens: 3, price_1m_output_tokens: 5 },
          performance: { median_output_tokens_per_second: 96.3 },
        },
        {
          name: 'GLM-5.3', model_creator: { name: 'Z AI' },
          evaluations: { artificial_analysis_intelligence_index: 60 },
        },
      ],
      pagination: { has_more: false },
    });
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

await t('抓取失败的源复用旧快照数据（stale），榜单不消失', async () => {
  // 预置旧快照：aa-llm 上次成功的数据
  const prevSnap = {
    generatedAt: new Date(Date.now() - 3600e3).toISOString(),
    sources: [{ id: 'aa-llm', name: 'Artificial Analysis', status: 'live', entries: [{ rank: 1, model: 'OldModel', org: 'OpenAI', score: 70 }] }],
  };
  store.set('data:latest', JSON.stringify(prevSnap));
  // mock AA 429：本次抓取 aa-llm 失败
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('artificialanalysis.ai')) {
      return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  const res = await worker.fetch(new Request('http://localhost/api/refresh', { method: 'POST' }), env, ctx);
  const data = await res.json();
  globalThis.fetch = realFetch;
  const aa = data.sources.find((s) => s.id === 'aa-llm');
  assert.equal(aa.status, 'stale');          // 标记为「上次数据」
  assert.equal(aa.entries.length, 1);        // 复用旧条目
  assert.equal(aa.entries[0].model, 'OldModel');
  assert.match(aa.error, /上次成功/);
  // KV 里落盘的也应是合并后的快照
  const saved = JSON.parse(store.get('data:latest'));
  assert.equal(saved.sources.find((s) => s.id === 'aa-llm').status, 'stale');
  // 清理：恢复 KV 空状态，避免影响后续用例（scheduled 会重新写入完整快照）
  store.delete('data:latest');
});

await t('AA 配额节流：20h 内抓过则跳过，?force=1 可强抓', async () => {
  const envK = { ...env, AA_API_KEY: 'aa_valid' };
  // 第一次：force 强抓 → AA live → 记录 meta:aa-last-ok
  const r1 = await worker.fetch(new Request('http://localhost/api/refresh?force=1', { method: 'POST' }), envK, ctx);
  const d1 = await r1.json();
  const aa1 = d1.sources.find((s) => s.id === 'aa-llm');
  assert.equal(aa1.status, 'live');
  assert.equal(aa1.entries.length, 2);
  assert.ok(store.has('meta:aa-last-ok'), 'AA 抓成功后应记录 meta:aa-last-ok');
  // 第二次（TTL 内、不带 force）：不发请求跳过 → unavailable → 复用旧数据标 stale
  const r2 = await worker.fetch(new Request('http://localhost/api/refresh', { method: 'POST' }), envK, ctx);
  const d2 = await r2.json();
  const aa2 = d2.sources.find((s) => s.id === 'aa-llm');
  assert.equal(aa2.status, 'stale');
  assert.match(aa2.error, /配额有限/);
  assert.equal(aa2.entries.length, 2); // 复用上次成功数据，榜单不消失
  // 第三次：force=1 绕过节流，真的再抓一次
  const r3 = await worker.fetch(new Request('http://localhost/api/refresh?force=1', { method: 'POST' }), envK, ctx);
  const d3 = await r3.json();
  assert.equal(d3.sources.find((s) => s.id === 'aa-llm').status, 'live');
  // 清理：避免影响后续用例
  store.delete('meta:aa-last-ok');
  store.delete('data:latest');
});

await t('scheduled 定时任务写入 KV', async () => {
  await worker.scheduled({ scheduled: true, cron: '0 * * * *' }, env, ctx);
  await flush(); // waitUntil 的后台抓取完成后再断言
  assert.ok(store.has('data:latest'));
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(store.has('data:' + day), '每日归档缺失');
});

await t('GET /healthz 健康检查（含数据源诊断）', async () => {
  const res = await worker.fetch(new Request('http://localhost/healthz'), env, ctx);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.kvBound, true);
  assert.ok(data.lastGeneratedAt);
  // 每个源的 status/count/error 摘要（诊断 AA 失败原因用）
  assert.equal(data.aaKeyPresent, false); // 本测试未配置 key
  assert.equal(data.aaProbe, null);       // 无 key 时不做探测
  assert.ok(Array.isArray(data.sources));
  assert.ok(data.sources.length >= 4);
  for (const s of data.sources) {
    assert.ok(['live', 'empty', 'unavailable', 'stale'].includes(s.status), s.status);
    assert.ok(Number.isInteger(s.count));
  }
  const aa = data.sources.find((s) => s.id === 'aa-llm');
  assert.equal(aa.status, 'unavailable'); // 无 key → 未配置错误
  assert.match(aa.error, /AA_API_KEY/);
  // HF 出口探测（区分「Worker 出口被 HF 拦截」与代码问题）
  assert.ok(data.hfProbe);
  assert.equal(data.hfProbe.reachable, true);
  // dry-run 完整抓取（不写 KV，暴露生产真实抓取行为）
  assert.ok(data.dryRun);
  assert.ok(!data.dryRun.error);
  assert.ok(Number.isInteger(data.dryRun.ms));
  assert.ok(data.dryRun.sources.length >= 4);
});

await t('GET /healthz（配置了有效 AA key）实时探测接口可达', async () => {
  const envWithKey = { ...env, AA_API_KEY: 'aa_test_key' };
  const res = await worker.fetch(new Request('http://localhost/healthz'), envWithKey, ctx);
  const data = await res.json();
  assert.equal(data.aaKeyPresent, true);
  assert.equal(data.aaKeyPrefix, 'aa_t…');
  assert.ok(data.aaProbe);
  assert.equal(data.aaProbe.reachable, true);
  assert.equal(data.aaProbe.http, 200);
  assert.ok(Number.isInteger(data.aaProbe.items));
});

await t('GET /healthz（key 无效）探测返回 401', async () => {
  const envBadKey = { ...env, AA_API_KEY: 'aa_bad' };
  const res = await worker.fetch(new Request('http://localhost/healthz'), envBadKey, ctx);
  const data = await res.json();
  assert.equal(data.aaKeyPresent, true);
  assert.equal(data.aaProbe.reachable, false);
  assert.equal(data.aaProbe.http, 401);
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

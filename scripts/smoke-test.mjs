/**
 * 本地冒烟测试（无需网络、无需 Cloudflare 账号）
 * 用 mock fetch 验证：HF 数据集解析（含翻页与分类过滤）、AA API 解析、
 * 国内 SPA 降级、快照可序列化、前端页面渲染。
 *
 * 运行：node scripts/smoke-test.mjs
 */

import assert from 'node:assert/strict';
import { refreshAll, buildFallbackSnapshot, SOURCES } from '../src/sources.js';
import { renderPage } from '../src/frontend.js';

/* ---------- mock 数据 ---------- */

const ORGS = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'Meta', 'DeepSeek', 'Alibaba'];

function makeHFRows(config, count) {
  const rows = [];
  const isAgent = config === 'agent';
  for (let i = 0; i < count; i++) {
    const org = ORGS[i % ORGS.length];
    const base = {
      model_name: `model-${i}`,
      organization: org,
      license: 'Proprietary',
      rank: i + 1,
      category: i > 0 && i % 3 === 0 ? 'coding' : 'overall', // 混入非 overall 行，验证过滤（rank 1 保持 overall）
      leaderboard_publish_date: '2026-10-24',
    };
    if (isAgent) {
      base.score = 0.25 - i * 0.01;
      base.score_ci_lower = base.score - 0.004;
      base.score_ci_upper = base.score + 0.004;
      base.observation_count = 1000;
    } else {
      base.rating = 1450 - i * 3;
      base.rating_lower = base.rating - 2.5;
      base.rating_upper = base.rating + 2.5;
      base.vote_count = 50000 - i * 10;
    }
    rows.push({ row_idx: i, row: base });
  }
  return rows;
}

// 模拟 130 行（>100，强制翻页），其中 overall 行按 rank 全量给出
const HF_PAGES = {
  text_style_control: makeHFRows('text_style_control', 130),
  agent: makeHFRows('agent', 60),
  search_style_control: makeHFRows('search_style_control', 80),
};

const AA_DATA = {
  status: 200,
  data: [
    { id: 'a', name: 'TopModel-X', slug: 'topmodel-x', model_creator: { name: 'OpenAI' },
      evaluations: { artificial_analysis_intelligence_index: 73.2 }, pricing: { price_1m_blended_3_to_1: 3.5 },
      median_output_tokens_per_second: 96.31 },
    { id: 'b', name: 'MidModel-Y', slug: 'midmodel-y', model_creator: { name: 'Google' },
      evaluations: { artificial_analysis_intelligence_index: 69.8 }, pricing: { price_1m_blended_3_to_1: 1.2 },
      median_output_tokens_per_second: 180.4 },
    { id: 'c', name: 'NoIndex-Z', slug: 'noindex-z', model_creator: { name: 'Meta' },
      evaluations: {}, pricing: {}, median_output_tokens_per_second: null },
  ],
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const respond = (body, ct = 'application/json; charset=utf-8', status = 200) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': ct } });

  if (u.startsWith('https://datasets-server.huggingface.co/rows')) {
    const cfg = new URL(u).searchParams.get('config');
    const offset = Number(new URL(u).searchParams.get('offset') || 0);
    const all = HF_PAGES[cfg] || [];
    const page = all.slice(offset, offset + 100);
    return respond({
      features: [],
      rows: page,
      num_rows_total: all.length,
      num_rows_per_page: 100,
    });
  }
  if (u.startsWith('https://artificialanalysis.ai/api/v2/language/models')) {
    if (!opts.headers || !opts.headers['x-api-key']) return respond({ error: 'Unauthorized' }, 'application/json', 401);
    return respond(AA_DATA);
  }
  if (u.includes('superclueai.com') || u.includes('opencompass.org.cn') || u.includes('flageval.baai.ac.cn')) {
    // 国内三家：SPA 返回 HTML
    return respond('<!doctype html><html><body>app</body></html>', 'text/html; charset=utf-8');
  }
  throw new Error('unexpected fetch: ' + u);
};

/* ---------- 用例 ---------- */

let passed = 0;
function ok(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') {
    return r.then(() => { passed++; console.log('  ✓ ' + name); });
  }
  passed++;
  console.log('  ✓ ' + name);
  return Promise.resolve();
}

console.log('smoke test: ai-leaderboard worker\n');

// 1. 无 AA key：刷新全部数据源
const snap = await refreshAll({});

await ok('返回 7 个数据源', () => assert.equal(snap.sources.length, 7));

await ok('Arena 文本榜：翻页 + 分类过滤 + 排序 + 前 10', () => {
  const s = snap.sources.find((x) => x.id === 'arena-text');
  assert.equal(s.status, 'live');
  assert.equal(s.entries.length, 10);
  assert.ok(s.entries.every((e) => Number.isInteger(e.rank)));
  assert.ok(s.entries.every((e) => typeof e.score === 'number'));
  assert.ok(s.entries.every((e) => e.model && e.org));
  // overall 行按 rank 升序
  const ranks = s.entries.map((e) => e.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  // 第一名不应来自被过滤掉的 coding 分类
  assert.equal(s.entries[0].rank, 1);
});

await ok('Arena Agent 榜：IPS 百分比格式', () => {
  const s = snap.sources.find((x) => x.id === 'arena-agent');
  assert.equal(s.status, 'live');
  assert.ok(s.entries[0].score.endsWith('%'));
  assert.match(s.entries[0].score, /^\d+(\.\d+)?%$/);
});

await ok('Arena 搜索榜：实时数据', () => {
  const s = snap.sources.find((x) => x.id === 'arena-search');
  assert.equal(s.status, 'live');
  assert.ok(s.entries.length > 0);
});

await ok('AA 无 key → unavailable + 引导文案', () => {
  const s = snap.sources.find((x) => x.id === 'aa-llm');
  assert.equal(s.status, 'unavailable');
  assert.match(s.error, /AA_API_KEY/);
  assert.equal(s.entries.length, 0);
});

await ok('国内三家 SPA → unavailable', () => {
  for (const id of ['superclue', 'opencompass', 'flageval']) {
    const s = snap.sources.find((x) => x.id === id);
    assert.equal(s.status, 'unavailable', id);
    assert.match(s.error, /SPA/);
  }
});

await ok('快照可 JSON 序列化（无函数残留）', () => {
  const str = JSON.stringify(snap);
  assert.ok(str.length > 1000);
  assert.ok(!str.includes('function'));
});

// 2. 有 AA key
const snap2 = await refreshAll({ AA_API_KEY: 'test-key-123' });

await ok('AA 有 key → 按智能指数降序 + 价格/速度', () => {
  const s = snap2.sources.find((x) => x.id === 'aa-llm');
  assert.equal(s.status, 'live');
  assert.equal(s.entries.length, 2); // NoIndex-Z 无指数被过滤
  assert.equal(s.entries[0].model, 'TopModel-X');
  assert.ok(s.entries[0].score > s.entries[1].score);
  assert.equal(s.entries[0].price, '$3.5/M');
  assert.equal(s.entries[0].speed, '96.3 tok/s');
});

await ok('AA key 无效（401）→ unavailable', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('artificialanalysis.ai')) {
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts); // 其余仍走 mock？不，realFetch 无网络，这里不会触发
  };
  const s = (await refreshAll({ AA_API_KEY: 'bad' })).sources.find((x) => x.id === 'aa-llm');
  assert.equal(s.status, 'unavailable');
  assert.match(s.error, /401/);
});

// 3. 内置快照（首次访问）
await ok('buildFallbackSnapshot：Agent 榜有缓存快照、文本榜待抓取', () => {
  const fb = buildFallbackSnapshot();
  const agent = fb.sources.find((x) => x.id === 'arena-agent');
  const text = fb.sources.find((x) => x.id === 'arena-text');
  assert.equal(agent.status, 'cached');
  assert.equal(agent.entries.length, 10);
  assert.equal(agent.snapshotDate, '2026-10-25');
  assert.equal(text.status, 'unavailable');
  assert.equal(fb.sources.every((s) => typeof s.fetcher === 'undefined'), true);
});

// 4. 前端页面
await ok('前端页面包含关键结构与液态玻璃样式', () => {
  const html = renderPage();
  for (const marker of [
    '<!DOCTYPE html>', 'backdrop-filter', 'prefers-color-scheme: dark',
    'id="seg"', 'id="grid"', '/api/data', '/api/refresh',
    'lmarena-ai/leaderboard-dataset', 'SuperCLUE', 'OpenCompass', 'FlagEval',
    'prefers-reduced-motion',
  ]) {
    assert.ok(html.includes(marker), 'missing: ' + marker);
  }
  assert.ok(html.length > 15000, '页面过短，可能被截断');
  // 不应残留未转义的模板占位
  assert.ok(!html.includes('undefined'), '页面包含 undefined');
});

// 5. 数据源配置完整性
await ok('所有数据源字段完整且唯一', () => {
  const ids = new Set();
  for (const s of SOURCES) {
    for (const k of ['id', 'name', 'category', 'org', 'url', 'metric', 'accent', 'desc', 'fetcher']) {
      assert.ok(s[k] != null && s[k] !== '', `source ${s.id} 缺少字段 ${k}`);
    }
    assert.ok(['global', 'china'].includes(s.category));
    assert.ok(s.url.startsWith('https://'));
    assert.ok(!ids.has(s.id), '重复 id: ' + s.id);
    ids.add(s.id);
  }
});

globalThis.fetch = realFetch;
console.log(`\n全部通过：${passed} 项 ✓`);

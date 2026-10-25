/**
 * 本地冒烟测试（无需网络、无需 Cloudflare 账号）
 * 用 mock fetch 验证：HF 数据集解析（含翻页与分类过滤）、AA API 解析
 * （分页 + 字段路径 + 开源启发式）、开源判定、快照可序列化、前端页面渲染。
 *
 * 运行：node scripts/smoke-test.mjs
 */

import assert from 'node:assert/strict';
import { refreshAll, buildFallbackSnapshot, SOURCES, isOpenLicense, isOpenModelName } from '../src/sources.js';
import { renderPage, applyEntryFilters } from '../src/frontend.js';

/* ---------- mock 数据 ---------- */

const ORGS = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'Meta', 'DeepSeek', 'Alibaba'];
const LICENSES = ['Proprietary', 'MIT', 'Apache 2.0', 'Llama 3.1 Community', 'CC-BY-NC-4.0'];

function makeHFRows(config, count) {
  const rows = [];
  const isAgent = config === 'agent';
  for (let i = 0; i < count; i++) {
    const org = ORGS[i % ORGS.length];
    const base = {
      model_name: `model-${i}`,
      organization: org,
      license: LICENSES[i % LICENSES.length], // 混入开源/闭源 license，验证 open 判定
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
      evaluations: { artificial_analysis_intelligence_index: 73.2 },
      pricing: { price_1m_input_tokens: 3.0, price_1m_output_tokens: 5.0 },
      performance: { median_output_tokens_per_second: 96.31 } },
    { id: 'b', name: 'GLM-5.3 (Max)', slug: 'glm-5-3', model_creator: { name: 'Z AI' },
      evaluations: { artificial_analysis_intelligence_index: 69.8 },
      pricing: { price_1m_input_tokens: 0.6, price_1m_output_tokens: 1.8 },
      performance: { median_output_tokens_per_second: 180.4 } },
    { id: 'c', name: 'NoIndex-Z', slug: 'noindex-z', model_creator: { name: 'Meta' },
      evaluations: {}, pricing: {}, performance: {} },
  ],
  pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
};

const realFetch = globalThis.fetch;
const mockFetch = async (url, opts = {}) => {
  const u = String(url);
  const respond = (body, ct = 'application/json; charset=utf-8', status = 200) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': ct } });

  if (u.startsWith('https://datasets-server.huggingface.co/filter')) {
    // 首选路径：服务端按 category 过滤，直接返回 overall 行
    const cfg = new URL(u).searchParams.get('config');
    const offset = Number(new URL(u).searchParams.get('offset') || 0);
    const all = (HF_PAGES[cfg] || []).map((r) => r.row).filter((r) => r.category === 'overall');
    const page = all.slice(offset, offset + 100);
    return respond({
      features: [],
      rows: page.map((row, i) => ({ row_idx: offset + i, row })),
      num_rows_total: all.length,
      num_rows_per_page: 100,
    });
  }
  if (u.startsWith('https://datasets-server.huggingface.co/rows')) {
    // 回退路径：全表翻页 + 客户端过滤
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
  throw new Error('unexpected fetch: ' + u);
};
globalThis.fetch = mockFetch;

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

await ok('返回 4 个数据源（仅收录可自动获取的榜单）', () => assert.equal(snap.sources.length, 4));

await ok('Arena 文本榜：翻页 + 分类过滤 + 排序 + 全部条目（不截断）', () => {
  const s = snap.sources.find((x) => x.id === 'arena-text');
  assert.equal(s.status, 'live');
  // mock 共 130 行，其中 43 行 category=coding 被过滤，应剩 87 行全部返回
  assert.equal(s.entries.length, 87);
  assert.ok(s.entries.every((e) => Number.isInteger(e.rank)));
  assert.ok(s.entries.every((e) => typeof e.score === 'number'));
  assert.ok(s.entries.every((e) => e.model && e.org));
  // overall 行按 rank 升序
  const ranks = s.entries.map((e) => e.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  // 第一名不应来自被过滤掉的 coding 分类
  assert.equal(s.entries[0].rank, 1);
  // 开源 / 闭源判定（rank1=Proprietary 闭源；rank2=MIT 开源）
  assert.equal(s.entries[0].open, false);
  assert.equal(s.entries[1].open, true);
  assert.ok(s.entries.some((e) => e.open) && s.entries.some((e) => !e.open));
});

await ok('Arena Agent 榜：IPS 百分比格式 + 全部条目', () => {
  const s = snap.sources.find((x) => x.id === 'arena-agent');
  assert.equal(s.status, 'live');
  assert.ok(s.entries.length > 10, '不应截断为前 10');
  assert.ok(s.entries[0].score.endsWith('%'));
  assert.match(s.entries[0].score, /^\d+(\.\d+)?%$/);
});

await ok('Arena 搜索榜：实时数据 + 全部条目', () => {
  const s = snap.sources.find((x) => x.id === 'arena-search');
  assert.equal(s.status, 'live');
  assert.ok(s.entries.length > 10, '不应截断为前 10');
});

await ok('AA 无 key → unavailable + 引导文案', () => {
  const s = snap.sources.find((x) => x.id === 'aa-llm');
  assert.equal(s.status, 'unavailable');
  assert.match(s.error, /AA_API_KEY/);
  assert.equal(s.entries.length, 0);
});

await ok('快照可 JSON 序列化（无函数残留）', () => {
  const str = JSON.stringify(snap);
  assert.ok(str.length > 1000);
  assert.ok(!str.includes('function'));
});

// 2. 有 AA key
const snap2 = await refreshAll({ AA_API_KEY: 'test-key-123' });

await ok('AA 有 key → 按智能指数降序 + 价格/速度 + 开源启发式', () => {
  const s = snap2.sources.find((x) => x.id === 'aa-llm');
  assert.equal(s.status, 'live');
  assert.equal(s.entries.length, 2); // NoIndex-Z 无指数被过滤
  assert.equal(s.entries[0].model, 'TopModel-X');
  assert.ok(s.entries[0].score > s.entries[1].score);
  // 混合价 = (3×3.0 + 5.0)/4 = 3.5
  assert.equal(s.entries[0].price, '$3.5/M');
  assert.equal(s.entries[0].speed, '96.3 tok/s');
  // 开源启发式：TopModel-X 闭源，GLM-5.3 开源
  assert.equal(s.entries[0].open, false);
  assert.equal(s.entries[1].open, true);
});

await ok('isOpenLicense：主流 license 判定', () => {
  assert.equal(isOpenLicense('MIT'), true);
  assert.equal(isOpenLicense('Apache 2.0'), true);
  assert.equal(isOpenLicense('Apache-2.0'), true);
  assert.equal(isOpenLicense('Llama 3.1 Community'), true);
  assert.equal(isOpenLicense('Qwen'), true);
  assert.equal(isOpenLicense('Gemma'), true);
  assert.equal(isOpenLicense('CC-BY-NC-4.0'), true);
  assert.equal(isOpenLicense('Proprietary'), false);
  assert.equal(isOpenLicense('Other'), false);
  assert.equal(isOpenLicense('Non-commercial'), false);
  assert.equal(isOpenLicense(null), false);
  assert.equal(isOpenLicense(''), false);
});

await ok('isOpenModelName：AA 名称启发式（无 license 字段的替代方案）', () => {
  const mk = (name, creator) => ({ name, model_creator: { name: creator } });
  assert.equal(isOpenModelName(mk('GLM-5.3 (Max)', 'Z AI')), true);
  assert.equal(isOpenModelName(mk('Kimi K3.1 Pro', 'Kimi')), true);
  assert.equal(isOpenModelName(mk('DeepSeek V4.1 Flash 1017 (Max)', 'DeepSeek')), true);
  assert.equal(isOpenModelName(mk('MiMo-V2.6-Pro', 'Xiaomi')), true);
  assert.equal(isOpenModelName(mk('Qwen3-235B-A22B-Instruct', 'Alibaba')), true);
  assert.equal(isOpenModelName(mk('Qwen3.8 Max (0902)', 'Alibaba')), false); // Max 旗舰版闭源
  assert.equal(isOpenModelName(mk('Gemma 3 27B', 'Google')), true);
  assert.equal(isOpenModelName(mk('Claude Opus 5.5 (Max)', 'Anthropic')), false);
  assert.equal(isOpenModelName(mk('GPT-6 Astra (Max)', 'OpenAI')), false);
  assert.equal(isOpenModelName(mk('Gemini 4 Argon (High)', 'Google')), false);
  assert.equal(isOpenModelName(mk('Grok 4.7 (Xhigh)', 'SpaceXAI')), false);
  assert.equal(isOpenModelName(null), false);
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
  globalThis.fetch = mockFetch; // 恢复主 mock
});

await ok('filter 接口不可用时自动回退 rows 全表翻页', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://datasets-server.huggingface.co/filter')) {
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return mockFetch(u, opts);
  };
  const s = (await refreshAll({})).sources.find((x) => x.id === 'arena-text');
  assert.equal(s.status, 'live');
  assert.equal(s.entries.length, 87); // rows 路径同样拿全 overall 行
  globalThis.fetch = mockFetch; // 恢复主 mock
});

// 3. 内置快照（首次访问）：空 sources，前端进入“抓取中”状态
await ok('buildFallbackSnapshot：sources 为空、含时间戳', () => {
  const fb = buildFallbackSnapshot();
  assert.equal(fb.sources.length, 0);
  assert.ok(fb.generatedAt);
  assert.ok(!Number.isNaN(new Date(fb.generatedAt).getTime()));
});

// 4. 前端页面
await ok('前端页面包含关键结构与液态玻璃样式', () => {
  const html = renderPage();
  for (const marker of [
    '<!DOCTYPE html>', 'backdrop-filter', 'prefers-color-scheme: dark',
    'id="grid"', 'id="boardCount"', '/api/data', '/api/refresh',
    'lmarena-ai/leaderboard-dataset',
    'grid-template-columns: repeat(2, 1fr)',   // 宽屏 2×2 布局
    'max-height: min(58vh, 620px)',            // 卡片内滚动
    'data-lic="open"', '仅开源', '仅闭源',       // 开源/闭源筛选
    'prefers-reduced-motion',
    '获取最权威榜单 · 每日自动抓取',            // 副标题
    'id="diag"', 'updateDiag', 'shortErr',     // 数据源诊断区
    'id="searchInput"', 'id="searchClear"',    // 搜索框
    'id="orgFilter"', 'id="orgToggle"', 'id="orgPanel"', // 厂商多选下拉
    'BOARD_ORDER',                             // 固定展示顺序
    '[hidden] { display: none !important; }',  // hidden 显隐兜底（否则面板/✕/诊断区被 display 强制显示）
    'z-index: 40',                             // header 抬升堆叠层级（下拉面板不被榜单卡片盖住）
  ]) {
    assert.ok(html.includes(marker), 'missing: ' + marker);
  }
  assert.ok(html.length > 15000, '页面过短，可能被截断');
  // 不应残留未转义的模板占位
  assert.ok(!html.includes('undefined'), '页面包含 undefined');
  // 注入页面的筛选函数必须是真实函数体（不是 [object Object] 或空串）
  assert.ok(html.includes('function applyEntryFilters(entries, opts)'), '筛选函数未正确注入页面');
  // 已移除的数据源与降级文案不应再出现（seg 控件已恢复，用于开源/闭源筛选）
  for (const gone of ['SuperCLUE', 'OpenCompass', 'FlagEval', '暂无法自动获取', '国内外最权威']) {
    assert.ok(!html.includes(gone), '不应残留: ' + gone);
  }
});

// 5. 组合筛选（开源/闭源 + 关键字 + 厂商多选，可叠加）
await ok('applyEntryFilters：关键字 / 厂商 / 开源闭源组合筛选', () => {
  const entries = [
    { rank: 1, model: 'Claude Opus 4.5', org: 'Anthropic', score: 1480, open: false },
    { rank: 2, model: 'DeepSeek V4', org: 'DeepSeek', score: 1450, open: true },
    { rank: 3, model: 'Kimi K2', org: 'Moonshot', score: 1440, open: true },
    { rank: 4, model: 'GPT-5.2', org: 'OpenAI', score: 1430, open: false },
  ];
  const ids = (r) => r.map((e) => e.rank);
  // 无筛选 → 原样返回
  assert.deepEqual(ids(applyEntryFilters(entries, {})), [1, 2, 3, 4]);
  // 关键字：匹配模型名（大小写不敏感）
  assert.deepEqual(ids(applyEntryFilters(entries, { kw: 'deepseek' })), [2]);
  assert.deepEqual(ids(applyEntryFilters(entries, { kw: 'KIMI' })), [3]);
  // 关键字也匹配厂商名
  assert.deepEqual(ids(applyEntryFilters(entries, { kw: 'openai' })), [4]);
  // 厂商多选
  assert.deepEqual(ids(applyEntryFilters(entries, { orgs: ['Anthropic', 'OpenAI'] })), [1, 4]);
  // 仅开源 / 仅闭源
  assert.deepEqual(ids(applyEntryFilters(entries, { lic: 'open' })), [2, 3]);
  assert.deepEqual(ids(applyEntryFilters(entries, { lic: 'closed' })), [1, 4]);
  // 组合：仅开源 + 厂商 DeepSeek + 关键字 v4
  assert.deepEqual(ids(applyEntryFilters(entries, { lic: 'open', orgs: ['DeepSeek'], kw: 'v4' })), [2]);
  // 组合无交集 → 空数组
  assert.deepEqual(applyEntryFilters(entries, { lic: 'open', kw: 'gpt' }), []);
  // 边界：空数组 / null / 空关键字（trim 后忽略）
  assert.deepEqual(applyEntryFilters([], { lic: 'open' }), []);
  assert.deepEqual(applyEntryFilters(null, {}), []);
  assert.equal(applyEntryFilters(entries, { kw: '   ' }).length, 4);
  // 不过滤原数组
  assert.equal(entries.length, 4);
});

// 6. 数据源配置完整性（含展示顺序：Agent 第一、AA 第二）
await ok('所有数据源字段完整且唯一', () => {
  const ids = new Set();
  for (const s of SOURCES) {
    for (const k of ['id', 'name', 'category', 'org', 'url', 'metric', 'accent', 'desc', 'fetcher']) {
      assert.ok(s[k] != null && s[k] !== '', `source ${s.id} 缺少字段 ${k}`);
    }
    assert.equal(typeof s.category, 'string');
    assert.ok(s.url.startsWith('https://'));
    assert.ok(!ids.has(s.id), '重复 id: ' + s.id);
    ids.add(s.id);
  }
});
await ok('数据源展示顺序：arena-agent → aa-llm → arena-text → arena-search', () => {
  assert.deepEqual(SOURCES.map((s) => s.id), ['arena-agent', 'aa-llm', 'arena-text', 'arena-search']);
});

globalThis.fetch = realFetch;
console.log(`\n全部通过：${passed} 项 ✓`);

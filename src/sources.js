/**
 * 数据源定义与每日抓取逻辑
 * ------------------------------------------------------------------
 * 每个抓取器返回统一格式的数组：
 *   { rank, model, org, score, ci, license, open, price?, priceUsd?, speed? }
 *   open = true 表示开源（开放权重），false 表示闭源。
 *   price = "$3.5/M" 展示串；priceUsd = 混合价数值（美元/百万 tokens），
 *   供前端价格筛选做数值比较（仅 AA 榜有价格数据）。
 *
 * 收录原则（2026-10-26 修订）：只保留「真能自动拿到数据」的榜单，
 * 拿不到的一律不进页面。当前收录 4 个数据源：
 *
 *  - Arena（文本 / Agent / 搜索榜）：官方 Hugging Face 数据集
 *      lmarena-ai/leaderboard-dataset，经 datasets-server REST API 读取，
 *      免密钥、结构化 JSON，是 Arena 官方自己发布的一手数据。
 *      行内含官方 license 字段，开源/闭源判定以它为准（准确）。
 *  - Artificial Analysis：官方免费 API /api/v2/language/models/free，
 *      需要免费 API Key（配置 AA_API_KEY 后启用；未配置时该榜单不显示）。
 *      注意：该接口不返回 license 字段（Pro 订阅才有），开源判定改用
 *      模型名称/发布方的启发式规则，见 isOpenModelName。
 *
 * 已移除：SuperCLUE / OpenCompass 司南 / FlagEval 天秤。
 * 三家官网均为前端动态渲染的 SPA，2026-10-26 再次全量探测其候选接口
 * （含 JS bundle 分析）均只返回 HTML，没有任何公开数据接口，
 * 无法自动获取，故从产品中移除。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HF_DATASET = 'lmarena-ai%2Fleaderboard-dataset';
const HF_FILTER_BASE = 'https://datasets-server.huggingface.co/filter';
const HF_ROWS_BASE = 'https://datasets-server.huggingface.co/rows';
const AA_API = 'https://artificialanalysis.ai/api/v2/language/models/free';
const AA_IDX = 'artificial_analysis_intelligence_index';
export { AA_API };

const MAX_ROWS = 2000; // 单个榜单的翻页安全上限（10 页 filter / 20 页 rows）
const AA_MAX_PAGES = 6; // AA 分页安全上限（每页 200 条）
const ROWS_PAGE = 100; // /rows 单页行数
const ROWS_CONCURRENCY = 5; // /rows 翻页并发度（控制 subrequest 总量 <50）
const ROWS_MIN_PAGES = 3; // 至少翻这么多页才允许提前终止
const ROWS_EMPTY_STREAK = 2; // 连续这么多页没有目标 category 行即判定翻完

/**
 * /filter 接口健康缓存：HF 侧 filter 故障时（如 2026-10-26 的持续 500），
 * 避免每个榜单都白等一次超时。10 分钟有效期内直接走 /rows。
 */
let filterBrokenUntil = 0;

/** 测试专用：重置 filter 健康缓存 */
export function __resetFilterHealth() {
  filterBrokenUntil = 0;
}

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

/** 带超时的 fetch（Workers 与 Node 18+ 均可用） */
export async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 开源 / 闭源判定                                                      */
/* ------------------------------------------------------------------ */

// 闭源特征（优先判定）
const CLOSED_LICENSE = /proprietary|closed source|restricted|^other$|commercial use only/i;
// 开源特征：常见开源许可证 + 主流开放权重模型许可证
const OPEN_LICENSE =
  /mit|apache|bsd|isc|mpl|gemma|llama|qwen|qianwen|deepseek|kimi|minimax|hunyuan|openmdw|nvidia|mistral|jamba|dbrx|yi license|ai2|impact|falcon|nexusflow|community|^open|open |cc-by|unlicense|artistic|zlib|mrl|openrail/i;

/**
 * 根据 license 字符串判断是否开源（开放权重）。
 * 无法识别的一律按闭源处理（保守）。
 */
export function isOpenLicense(lic) {
  if (!lic) return false;
  const l = String(lic).trim().toLowerCase();
  if (!l || CLOSED_LICENSE.test(l)) return false;
  return OPEN_LICENSE.test(l);
}

/**
 * Artificial Analysis 的接口不返回 license 字段，这里用模型名称/发布方
 * 的启发式规则判断开源（开放权重家族）。识别不了按闭源处理。
 */
const AA_OPEN_NAME =
  /(^|[^a-z])(glm|deepseek|kimi|mimo|gemma|phi[\s-]?\d|llama|gpt-oss|granite|nemotron|olmo|internlm|minicpm|baichuan|yi[\s-]?\d|hunyuan|marco[\s-]o|seed-oss|dots[\s.]?llm|open-?(weights|source)|mistral[\s-](small|nemo|7b|8x|ministral|mixtral)|qwen(?!.*max))([^a-z]|$)/i;

export function isOpenModelName(model) {
  if (!model) return false;
  const name = String(model.name || '');
  const creator = String((model.model_creator && model.model_creator.name) || '');
  return AA_OPEN_NAME.test(name) || AA_OPEN_NAME.test(creator);
}

/* ------------------------------------------------------------------ */
/* 厂商名归一化                                                        */
/* ------------------------------------------------------------------ */

/**
 * 厂商别名表：Arena 数据集用小写组织名（openai/anthropic），
 * Artificial Analysis 用规范名（OpenAI/Anthropic），直接渲染会在厂商
 * 筛选里分裂成两个选项。这里统一成规范展示名；未收录的保留原样。
 */
const ORG_ALIASES = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'google deepmind': 'Google',
  meta: 'Meta',
  'meta-llama': 'Meta',
  'meta llama': 'Meta',
  mistral: 'Mistral',
  'mistral ai': 'Mistral',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
  qwen: 'Alibaba',
  'alibaba cloud': 'Alibaba',
  moonshot: 'Moonshot',
  'moonshot ai': 'Moonshot',
  kimi: 'Moonshot',
  zhipu: 'Z AI',
  'z ai': 'Z AI',
  'z-ai': 'Z AI',
  glm: 'Z AI',
  chatglm: 'Z AI',
  microsoft: 'Microsoft',
  xai: 'xAI',
  'x.ai': 'xAI',
  nvidia: 'NVIDIA',
  amazon: 'Amazon',
  aws: 'Amazon',
  ibm: 'IBM',
  baidu: 'Baidu',
  tencent: 'Tencent',
  bytedance: 'ByteDance',
  'byte dance': 'ByteDance',
  '01.ai': '01.AI',
  '01ai': '01.AI',
  cohere: 'Cohere',
  ai21: 'AI21',
  perplexity: 'Perplexity',
  together: 'Together',
  'together ai': 'Together',
  salesforce: 'Salesforce',
  apple: 'Apple',
  reka: 'Reka',
  'reka ai': 'Reka',
  inflection: 'Inflection',
  stability: 'Stability AI',
  'stability ai': 'Stability AI',
  nous: 'Nous Research',
  'nous research': 'Nous Research',
  ai2: 'Allen Institute',
  'allen institute': 'Allen Institute',
  'allenai': 'Allen Institute',
  internlm: 'Shanghai AI Lab',
  'shanghai ai lab': 'Shanghai AI Lab',
  'shanghai ai laboratory': 'Shanghai AI Lab',
};

/** 厂商名归一化为规范展示名（大小写/别名合并） */
export function normalizeOrg(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return ORG_ALIASES[s.toLowerCase()] || s;
}

/* ------------------------------------------------------------------ */
/* Arena 抓取（Hugging Face 官方数据集）                                */
/* ------------------------------------------------------------------ */

/**
 * 首选 /filter 接口：服务端按 category 过滤，只翻 overall 行。
 * 实测（2026-10-26）：text 榜 overall 共 418 行（5 页）、agent 50 行、
 * search 42 行，合计 7 次请求即可拿全，远比全表翻页高效。
 */
async function fetchArenaViaFilter(config, category, kind) {
  const base =
    `${HF_FILTER_BASE}?dataset=${HF_DATASET}` +
    `&config=${encodeURIComponent(config)}&split=latest`;
  const where = encodeURIComponent(`"category"='${category}'`);
  const collected = [];
  for (let offset = 0; offset < MAX_ROWS; offset += 100) {
    // filter 故障时 HF 可能 10s+ 才返回 500，超时收紧到 6s 快速回退 rows
    const res = await fetchWithTimeout(`${base}&where=${where}&limit=100&offset=${offset}`, {}, 6000);
    if (!res.ok) throw new Error(`Hugging Face filter 接口返回 HTTP ${res.status}`);
    const json = await res.json();
    collected.push(...(json.rows || []).map((r) => r.row).filter(Boolean));
    const total = Number(json.num_rows_total) || 0;
    if (total === 0 || offset + 100 >= total) break; // 已翻完
  }
  return collected;
}

/**
 * 回退方案：/rows 全表翻页 + 客户端过滤 category 行。
 *
 * 两个关键优化（2026-10-26，HF filter 故障期间实测）：
 *  1) 提前终止：实测 overall 行集中在表头部（text 榜 418 个 overall 分布在前
 *     418 行内），连续 ROWS_EMPTY_STREAK 页没有目标行即可判定翻完，
 *     避免对 11099 行的全表空翻 20 页；
 *  2) 并发翻页：每批 ROWS_CONCURRENCY 页并行请求，总耗时从「页数 × 单页延迟」
 *     降到「批数 × 单页延迟」，保证后台抓取能在几秒内完成（waitUntil 不会被
 *     用户关页打断，KV 能按时写入）。
 */
async function fetchArenaViaRows(config, category) {
  const base =
    `${HF_ROWS_BASE}?dataset=${HF_DATASET}` +
    `&config=${encodeURIComponent(config)}&split=latest`;
  const collected = [];
  let emptyStreak = 0; // 连续无目标 category 行的页数（仅统计成功获取的页）
  let offset = 0;
  let anyOk = false;
  let retried = false; // 失败页重试标记（全程只重试一轮，避免无限重试拖慢抓取）

  while (offset < MAX_ROWS) {
    // 一批并发请求
    const batchOffsets = [];
    const batch = [];
    for (let i = 0; i < ROWS_CONCURRENCY && offset + i * ROWS_PAGE < MAX_ROWS; i++) {
      const off = offset + i * ROWS_PAGE;
      batchOffsets.push(off);
      batch.push(fetchPage(off));
    }
    let pages = await Promise.all(batch);

    // 失败页重试一轮：偶发 502/超时不该让数据残缺，更不该被误判成「空页」提前终止
    if (!retried && pages.some((p) => p === null)) {
      retried = true;
      pages = await Promise.all(
        batchOffsets.map((off, i) => (pages[i] !== null ? Promise.resolve(pages[i]) : fetchPage(off)))
      );
    }

    let reachedEnd = false;
    for (let i = 0; i < pages.length; i++) {
      const json = pages[i];
      if (!json) continue; // 重试后仍失败：跳过（不计入 emptyStreak，避免误判翻完）
      anyOk = true;
      const pageOffset = batchOffsets[i];
      const rows = (json.rows || []).map((r) => r.row).filter((r) => r && r.category === category);
      collected.push(...rows);
      emptyStreak = rows.length ? 0 : emptyStreak + 1;
      const total = Number(json.num_rows_total) || 0;
      if (total === 0 || pageOffset + ROWS_PAGE >= total) reachedEnd = true; // 已翻完
    }
    if (reachedEnd) break;
    // 头部若干页之后连续 emptyStreak 页无目标行 → 目标行集中在头部，判定翻完
    if (offset + batchOffsets.length * ROWS_PAGE >= ROWS_MIN_PAGES * ROWS_PAGE && emptyStreak >= ROWS_EMPTY_STREAK) break;
    offset = batchOffsets[batchOffsets.length - 1] + ROWS_PAGE;
  }
  if (!anyOk) throw new Error('Hugging Face datasets-server 无响应（rows 接口）');
  return collected;

  function fetchPage(off) {
    return fetchWithTimeout(`${base}&offset=${off}&length=${ROWS_PAGE}`, {}, 10000)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
}

/** 读取 Arena 官方 Hugging Face 数据集的某个榜单（返回全部条目，不截断） */
async function fetchArenaBoard(config, category, kind) {
  let rows = null;
  // filter 故障缓存有效期内跳过 filter（避免每榜白等一次超时）
  if (Date.now() >= filterBrokenUntil) {
    try {
      rows = await fetchArenaViaFilter(config, category, kind);
    } catch (_) {
      // filter 不可用：10 分钟内整个 Worker 实例直接走 rows
      filterBrokenUntil = Date.now() + 10 * 60 * 1000;
      rows = null;
    }
  }
  if (!rows || !rows.length) {
    try {
      rows = await fetchArenaViaRows(config, category);
    } catch (_) {
      /* 两个方案都失败则下面抛错 */
    }
  }
  if (!rows || !rows.length) throw new Error(`Arena 数据集中没有 category=${category} 的数据`);
  rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return rows.map((row) => {
    if (kind === 'ips') {
      const half = row.score_ci_lower != null ? (row.score_ci_upper - row.score_ci_lower) / 2 : null;
      return {
        rank: row.rank,
        model: row.model_name,
        org: normalizeOrg(row.organization),
        score: r2((row.score ?? 0) * 100) + '%',
        ci: half != null ? `±${r2(half * 100)}%` : null,
        license: row.license || null,
        open: isOpenLicense(row.license),
      };
    }
    const half = row.rating_lower != null ? (row.rating_upper - row.rating_lower) / 2 : null;
    return {
      rank: row.rank,
      model: row.model_name,
      org: normalizeOrg(row.organization),
      score: r1(row.rating ?? 0),
      ci: half != null ? `±${r1(half)}` : null,
      license: row.license || null,
      open: isOpenLicense(row.license),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Artificial Analysis 抓取（官方免费 API）                              */
/* ------------------------------------------------------------------ */

/** Artificial Analysis 官方免费 API（需要 AA_API_KEY，分页全量拉取） */
async function fetchArtificialAnalysis(env) {
  const key = env && env.AA_API_KEY;
  if (!key) {
    throw new Error('未配置 AA_API_KEY（免费申请：artificialanalysis.ai 注册账号 → API Keys → 在 Worker 设置里注入）');
  }
  const models = [];
  for (let page = 1; page <= AA_MAX_PAGES; page++) {
    let res = await fetchWithTimeout(`${AA_API}?page=${page}`, {
      headers: { 'x-api-key': key },
    }, 15000);
    // 限流/服务端抖动：退避 1.5s 重试一次，避免偶发失败整天不显示
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetchWithTimeout(`${AA_API}?page=${page}`, {
        headers: { 'x-api-key': key },
      }, 15000);
    }
    if (!res.ok) throw new Error(`Artificial Analysis API 返回 HTTP ${res.status}（请检查 key 是否有效）`);
    const json = await res.json();
    models.push(...(json.data || []));
    if (!json.pagination || !json.pagination.has_more) break; // 已翻完
  }
  const withIdx = models.filter((m) => m.evaluations && m.evaluations[AA_IDX] != null);
  if (!withIdx.length) throw new Error('AA API 返回数据中找不到智能指数字段');
  withIdx.sort((a, b) => b.evaluations[AA_IDX] - a.evaluations[AA_IDX]);
  return withIdx.map((m, i) => {
    const p = m.pricing || {};
    // 混合价（输入:输出 = 3:1），接口只给分项单价
    const blended =
      p.price_1m_input_tokens != null && p.price_1m_output_tokens != null
        ? (3 * p.price_1m_input_tokens + p.price_1m_output_tokens) / 4
        : null;
    const speed = m.performance && m.performance.median_output_tokens_per_second;
    return {
      rank: i + 1,
      model: m.name,
      org: normalizeOrg((m.model_creator && m.model_creator.name) || ''),
      score: m.evaluations[AA_IDX],
      ci: null,
      license: null,
      open: isOpenModelName(m),
      price: blended != null ? `$${r2(blended)}/M` : null,
      priceUsd: blended, // 混合价数值（美元/百万 tokens），供前端价格筛选；旧快照无此字段时前端从 price 串解析
      speed: speed != null ? `${r1(speed)} tok/s` : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 数据源定义                                                          */
/* ------------------------------------------------------------------ */

/**
 * 数据源定义。
 * 数组顺序即页面展示顺序（前端另有 BOARD_ORDER 兜底，旧快照也是这个顺序）：
 * Artificial Analysis → Agent 榜 → 文本总榜 → 搜索榜。
 */
export const SOURCES = [
  {
    id: 'aa-llm',
    name: 'Artificial Analysis',
    category: 'global',
    org: 'Artificial Analysis（独立第三方）',
    url: 'https://artificialanalysis.ai/leaderboards/models',
    metric: 'Intelligence Index · 独立实测综合智能',
    accent: '#FF9F0A',
    desc: '统一条件独立实测，同时给出价格与速度，适合看“性价比”；开源判定为名称启发式，仅供参考',
    fetcher: fetchArtificialAnalysis,
  },
  {
    id: 'arena-agent',
    name: 'Arena · Agent 榜',
    category: 'global',
    org: 'Arena（UC Berkeley 系）',
    url: 'https://arena.ai/leaderboard',
    metric: 'IPS 得分 · 真实 Agent 任务完成率',
    accent: '#5E5CE6',
    desc: '在真实工作流中跑 Agent 任务，衡量“能不能把事办成”',
    fetcher: () => fetchArenaBoard('agent', 'overall', 'ips'),
  },
  {
    id: 'arena-text',
    name: 'Arena · 文本总榜',
    category: 'global',
    org: 'Arena（UC Berkeley 系）',
    url: 'https://arena.ai/leaderboard',
    metric: 'Arena Score · 真人盲测投票',
    accent: '#0A84FF',
    desc: '全球用户匿名两两对战投票，最接近“用起来哪个好”的金标准',
    fetcher: () => fetchArenaBoard('text_style_control', 'overall', 'bt'),
  },
  {
    id: 'arena-search',
    name: 'Arena · 搜索榜',
    category: 'global',
    org: 'Arena（UC Berkeley 系）',
    url: 'https://arena.ai/leaderboard',
    metric: 'Arena Score · 联网搜索能力',
    accent: '#64D2FF',
    desc: '对比各模型的联网检索与答案综合能力',
    fetcher: () => fetchArenaBoard('search_style_control', 'overall', 'bt'),
  },
];

/** 去掉函数字段，保证可 JSON 序列化 */
function serialize(source, patch) {
  const { fetcher, ...rest } = source;
  return { ...rest, ...patch };
}

/** 并发抓取全部数据源，单个失败不影响其他 */
export async function refreshAll(env) {
  const results = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const entries = await s.fetcher(env);
        return serialize(s, {
          status: entries.length ? 'live' : 'empty',
          entries,
          error: null,
        });
      } catch (err) {
        return serialize(s, {
          status: 'unavailable',
          entries: [],
          error: String((err && err.message) || err),
        });
      }
    })
  );
  return { generatedAt: new Date().toISOString(), sources: results };
}

/**
 * 不发起网络请求的空快照（首次访问 / KV 为空时使用）。
 * 只返回时间戳，sources 为空——前端据此进入“首次抓取中”状态并自动重试，
 * 后台抓取完成后（cron 或手动刷新写入 KV）即展示真实数据。
 */
export function buildFallbackSnapshot() {
  return { generatedAt: new Date().toISOString(), sources: [] };
}

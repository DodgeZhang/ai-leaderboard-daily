/**
 * 数据源定义与每日抓取逻辑
 * ------------------------------------------------------------------
 * 每个抓取器返回统一格式的数组：
 *   { rank, model, org, score, ci, license, price?, speed? }
 *
 * 收录原则（2026-10-26 修订）：只保留「真能自动拿到数据」的榜单，
 * 拿不到的一律不进页面。当前收录 4 个数据源：
 *
 *  - Arena（文本 / Agent / 搜索榜）：官方 Hugging Face 数据集
 *      lmarena-ai/leaderboard-dataset，经 datasets-server REST API 读取，
 *      免密钥、结构化 JSON，是 Arena 官方自己发布的一手数据。
 *  - Artificial Analysis：官方免费 API /api/v2/language/models/free，
 *      需要免费 API Key（配置 AA_API_KEY 后启用；未配置时该卡片不显示）。
 *
 * 已移除：SuperCLUE / OpenCompass 司南 / FlagEval 天秤。
 * 三家官网均为前端动态渲染的 SPA，2026-10-26 再次全量探测其候选接口
 * （含 JS bundle 分析）均只返回 HTML，没有任何公开数据接口，
 * 无法自动获取，故从产品中移除。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TOP_N = 10; // 每张卡片展示前 10 名
const HF_ROWS_BASE = 'https://datasets-server.huggingface.co/rows';

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

/**
 * 读取 Arena 官方 Hugging Face 数据集的某个榜单
 * @param config    数据集子集，如 text_style_control / agent / search_style_control
 * @param category  行内分类，取 overall 总榜
 * @param kind      'bt' = Bradley-Terry 评分（rating 字段）；'ips' = Agent 榜 IPS 得分（score 字段）
 */
async function fetchArenaBoard(config, category, kind) {
  const base =
    `${HF_ROWS_BASE}?dataset=lmarena-ai%2Fleaderboard-dataset` +
    `&config=${encodeURIComponent(config)}&split=latest`;
  const collected = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const res = await fetchWithTimeout(`${base}&offset=${offset}&length=100`);
    if (!res.ok) throw new Error(`Hugging Face datasets-server 返回 HTTP ${res.status}`);
    const json = await res.json();
    const page = (json.rows || [])
      .map((r) => r.row)
      .filter((r) => r && r.category === category);
    collected.push(...page);
    const total = Number(json.num_rows_total) || 0;
    if (total === 0 || offset + 100 >= total) break; // 已翻完
  }
  if (!collected.length) throw new Error(`Arena 数据集中没有 category=${category} 的数据`);
  collected.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return collected.slice(0, TOP_N).map((row) => {
    if (kind === 'ips') {
      const half = row.score_ci_lower != null ? (row.score_ci_upper - row.score_ci_lower) / 2 : null;
      return {
        rank: row.rank,
        model: row.model_name,
        org: row.organization,
        score: r2((row.score ?? 0) * 100) + '%',
        ci: half != null ? `±${r2(half * 100)}%` : null,
        license: row.license || null,
      };
    }
    const half = row.rating_lower != null ? (row.rating_upper - row.rating_lower) / 2 : null;
    return {
      rank: row.rank,
      model: row.model_name,
      org: row.organization,
      score: r1(row.rating ?? 0),
      ci: half != null ? `±${r1(half)}` : null,
      license: row.license || null,
    };
  });
}

/** Artificial Analysis 官方免费 API（需要 AA_API_KEY） */
async function fetchArtificialAnalysis(env) {
  const key = env && env.AA_API_KEY;
  if (!key) {
    throw new Error('未配置 AA_API_KEY（免费申请：artificialanalysis.ai 注册账号 → API Keys → 在 Worker 设置里注入）');
  }
  const res = await fetchWithTimeout('https://artificialanalysis.ai/api/v2/language/models/free', {
    headers: { 'x-api-key': key },
  });
  if (!res.ok) throw new Error(`Artificial Analysis API 返回 HTTP ${res.status}（请检查 key 是否有效）`);
  const json = await res.json();
  const idx = 'artificial_analysis_intelligence_index';
  const models = (json.data || []).filter((m) => m.evaluations && m.evaluations[idx] != null);
  if (!models.length) throw new Error('AA API 返回数据中找不到智能指数字段');
  models.sort((a, b) => b.evaluations[idx] - a.evaluations[idx]);
  return models.slice(0, TOP_N).map((m, i) => ({
    rank: i + 1,
    model: m.name,
    org: (m.model_creator && m.model_creator.name) || '',
    score: m.evaluations[idx],
    ci: null,
    license: null,
    price: m.pricing && m.pricing.price_1m_blended_3_to_1 != null
      ? `$${r2(m.pricing.price_1m_blended_3_to_1)}/M`
      : null,
    speed: m.median_output_tokens_per_second != null
      ? `${r1(m.median_output_tokens_per_second)} tok/s`
      : null,
  }));
}

/* ------------------------------------------------------------------ */
/* 数据源定义                                                          */
/* ------------------------------------------------------------------ */

export const SOURCES = [
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
  {
    id: 'aa-llm',
    name: 'Artificial Analysis',
    category: 'global',
    org: 'Artificial Analysis（独立第三方）',
    url: 'https://artificialanalysis.ai/leaderboards/models',
    metric: 'Intelligence Index · 独立实测综合智能',
    accent: '#FF9F0A',
    desc: '统一条件独立实测，同时给出价格与速度，适合看“性价比”',
    fetcher: fetchArtificialAnalysis,
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

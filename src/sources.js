/**
 * 数据源定义与每日抓取逻辑
 * ------------------------------------------------------------------
 * 每个抓取器返回统一格式的数组：
 *   { rank, model, org, score, ci, license, price?, speed? }
 *
 * 抓取策略（2026-10 实测确认）：
 *  - Arena（文本 / Agent / 搜索榜）：官方 Hugging Face 数据集
 *      lmarena-ai/leaderboard-dataset，经 datasets-server REST API 读取，
 *      免密钥、结构化 JSON，是 Arena 官方自己发布的一手数据。
 *  - Artificial Analysis：官方免费 API /api/v2/language/models/free，
 *      需要免费 API Key（配置 AA_API_KEY 后启用）。
 *  - SuperCLUE / OpenCompass 司南 / FlagEval 天秤：官网均为前端动态
 *      渲染的 SPA，没有公开数据接口（已分析其 JS  bundle 确认）。
 *      这里保留探测逻辑：未来若开放接口可直接复用；当前降级为
 *      「官网快照 / 引导访问」状态，前端卡片给出官网直达链接。
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
    throw new Error('未配置 AA_API_KEY（免费申请：artificialanalysis.ai 注册账号 → API Keys → 用 wrangler secret put AA_API_KEY 注入）');
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

/**
 * 国内三家榜单的尽力探测：依次尝试候选接口，拿到合法 JSON 数组就用。
 * 当前三家官网都是 SPA（返回 HTML），此函数会抛错并触发降级。
 */
async function fetchChinaBoard(probeUrls) {
  for (const u of probeUrls) {
    try {
      const res = await fetchWithTimeout(u, {}, 8000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) continue;
      const json = await res.json();
      const arr = Array.isArray(json) ? json : json.data || json.rows || json.list;
      if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object') {
        return arr.slice(0, TOP_N).map((m, i) => ({
          rank: m.rank ?? i + 1,
          model: m.model || m.model_name || m.name || '未知模型',
          org: m.org || m.organization || m.creator || m.provider || '',
          score: m.score ?? m.rating ?? m.elo ?? m.value ?? null,
          ci: null,
          license: m.license || null,
        }));
      }
    } catch (_) {
      /* 尝试下一个候选地址 */
    }
  }
  throw new Error('官网为动态渲染页面（SPA），暂无公开数据接口');
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
    fallback: {
      date: '2026-10-25',
      note: '以下为 2026-10-25 核实的官网快照，实时抓取恢复前展示',
      entries: [
        { rank: 1, model: 'Claude Opus 5.5 (Max)', org: 'Anthropic', score: '20.35%', ci: null, license: 'Proprietary' },
        { rank: 2, model: 'GPT-6 Astra (Max)', org: 'OpenAI', score: '15.15%', ci: null, license: 'Proprietary' },
        { rank: 3, model: 'Claude Fable 5.1 (Max)', org: 'Anthropic', score: '14.33%', ci: null, license: 'Proprietary' },
        { rank: 4, model: 'GPT-6.1 Sol (Max)', org: 'OpenAI', score: '13.72%', ci: null, license: 'Proprietary' },
        { rank: 5, model: 'Claude Sonnet 5.5 (Max)', org: 'Anthropic', score: '12.75%', ci: null, license: 'Proprietary' },
        { rank: 6, model: 'Gemini 4 Argon (High)', org: 'Google', score: '12.12%', ci: null, license: 'Proprietary' },
        { rank: 7, model: 'GPT-6 Sol (Max)', org: 'OpenAI', score: '9.33%', ci: null, license: 'Proprietary' },
        { rank: 8, model: 'Claude Fable 5 (High)', org: 'Anthropic', score: '8.37%', ci: null, license: 'Proprietary' },
        { rank: 9, model: 'Claude Opus 5 (Max)', org: 'Anthropic', score: '8.08%', ci: null, license: 'Proprietary' },
        { rank: 10, model: 'GPT-5.6 Sol (xHigh)', org: 'OpenAI', score: '6.59%', ci: null, license: 'Proprietary' },
      ],
    },
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
    fallback: {
      date: '2026-10-25',
      note: '以下为 2026-10-25 核实的官网快照，实时抓取恢复前展示',
      entries: [
        { rank: 1, model: 'gemini-3-pro-grounding', org: 'Google', score: 1213, ci: null, license: 'Proprietary' },
        { rank: 2, model: 'gpt-5.2-search', org: 'OpenAI', score: 1210, ci: null, license: 'Proprietary' },
        { rank: 3, model: 'gpt-5.1-search', org: 'OpenAI', score: 1199, ci: null, license: 'Proprietary' },
        { rank: 4, model: 'grok-4-1-fast-search', org: 'xAI', score: 1178, ci: null, license: 'Proprietary' },
        { rank: 5, model: 'grok-4-fast-search', org: 'xAI', score: 1164, ci: null, license: 'Proprietary' },
        { rank: 6, model: 'gemini-2.5-pro-grounding', org: 'Google', score: 1143, ci: null, license: 'Proprietary' },
        { rank: 7, model: 'o3-search', org: 'OpenAI', score: 1138, ci: null, license: 'Proprietary' },
        { rank: 8, model: 'ppl-sonar-reasoning-pro-high', org: 'Perplexity AI', score: 1137, ci: null, license: 'Proprietary' },
        { rank: 9, model: 'grok-4-search', org: 'xAI', score: 1137, ci: null, license: 'Proprietary' },
        { rank: 10, model: 'claude-opus-4-1-search', org: 'Anthropic', score: 1128, ci: null, license: 'Proprietary' },
      ],
    },
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
  {
    id: 'superclue',
    name: 'SuperCLUE',
    category: 'china',
    org: '北大人工智能研究院团队',
    url: 'https://www.superclueai.com/',
    metric: '中文综合得分 · 每月更新',
    accent: '#FF375F',
    desc: '中文大模型综合性测评基准，客观题库 + 匿名对战机制',
    fetcher: () =>
      fetchChinaBoard([
        'https://www.superclueai.com/api/leaderboard',
        'https://www.superclueai.com/api/chores/leaderboard',
      ]),
  },
  {
    id: 'opencompass',
    name: 'OpenCompass 司南',
    category: 'china',
    org: '上海人工智能实验室',
    url: 'https://opencompass.org.cn/',
    metric: '综合得分 · 开源评测体系',
    accent: '#30D158',
    desc: '全球最具影响力的开源评测体系之一，C-Eval / CMMLU 等中文基准',
    fetcher: () =>
      fetchChinaBoard([
        'https://opencompass.org.cn/api/leaderboard',
        'https://opencompass.org.cn/api/getLeaderboard',
      ]),
  },
  {
    id: 'flageval',
    name: 'FlagEval 天秤',
    category: 'china',
    org: '北京智源研究院（BAAI）',
    url: 'https://flageval.baai.ac.cn/',
    metric: '能力-任务-指标 三维评分',
    accent: '#BF5AF2',
    desc: '智源牵头、多所高校共建的“能力-任务-指标”评测平台',
    fetcher: () =>
      fetchChinaBoard([
        'https://flageval.baai.ac.cn/eval/model-pool/',
        'https://flageval.baai.ac.cn/api/leaderboard',
      ]),
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
        const fb = s.fallback;
        return serialize(s, {
          status: fb ? 'cached' : 'unavailable',
          entries: fb ? fb.entries : [],
          error: String((err && err.message) || err),
          snapshotDate: fb ? fb.date : null,
          snapshotNote: fb ? fb.note : null,
        });
      }
    })
  );
  return { generatedAt: new Date().toISOString(), sources: results };
}

/** 不发起网络请求的快照（首次访问 / KV 为空时使用） */
export function buildFallbackSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    sources: SOURCES.map((s) => {
      const fb = s.fallback;
      return serialize(s, {
        status: fb ? 'cached' : 'unavailable',
        entries: fb ? fb.entries : [],
        error: fb ? null : '等待首次抓取（定时任务运行或手动刷新后自动填充）',
        snapshotDate: fb ? fb.date : null,
        snapshotNote: fb ? fb.note : null,
      });
    }),
  };
}

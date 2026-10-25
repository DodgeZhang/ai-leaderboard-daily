# AI 排行榜每日速览 · Cloudflare Worker

一个可部署到 **Cloudflare Workers** 的完整应用：后端每日定时抓取国内外最权威的 AI 排行榜数据，存入 Cloudflare KV；前端为 **iOS 液态玻璃（Liquid Glass）风格**的单页展示网站，深浅色自适应、移动端友好。

```
┌──────────────────────────── Cloudflare Worker ────────────────────────────┐
│  cron 每日 16:00(北京)  →  抓取 7 个榜单  →  写入 KV(data:latest + 归档)   │
│  GET  /            液态玻璃页面（本文件即后端+前端一体）                    │
│  GET  /api/data    最新快照 JSON（过期自动后台自愈）                       │
│  POST /api/refresh 手动刷新（可选 REFRESH_TOKEN 保护）                     │
└───────────────────────────────────────────────────────────────────────────┘
```

## 收录榜单

| 榜单 | 类型 | 数据来源 | 抓取方式 |
|---|---|---|---|
| Arena · 文本总榜 | 国际 | arena.ai | ✅ 实时（Hugging Face 官方数据集 `lmarena-ai/leaderboard-dataset`，免密钥） |
| Arena · Agent 榜 | 国际 | arena.ai | ✅ 实时（同上） |
| Arena · 搜索榜 | 国际 | arena.ai | ✅ 实时（同上） |
| Artificial Analysis | 国际 | artificialanalysis.ai | 🔑 配置 `AA_API_KEY` 后实时（官方免费 API） |
| SuperCLUE | 国内 | superclueai.com | ⚪ 官网为 SPA 动态渲染、无公开接口 → 卡片提供官网直达（已预留探测逻辑） |
| OpenCompass 司南 | 国内 | opencompass.org.cn | ⚪ 同上 |
| FlagEval 天秤 | 国内 | flageval.baai.ac.cn | ⚪ 同上 |

> 关于 Arena 数据：Arena 官方已于 2026-04 将全部榜单历史发布为 Hugging Face 数据集（lmarena-ai/leaderboard-dataset），本 Worker 通过 datasets-server REST API 读取，是官方一手数据，无需渲染网页、无需密钥。
>
> 关于国内三榜：已分析三者 JS bundle 确认无公开 JSON 接口（OpenCompass 的 `/api/*` 是 SPA 兜底路由，FlagEval 的 `/eval/model-pool/` 同样返回 HTML）。`sources.js` 中保留了探测代码，未来接口开放即自动生效。

## 部署步骤（约 5 分钟）

前置：Node.js ≥ 20、一个 Cloudflare 账号（免费计划即可）。

```bash
# 1. 进入项目并安装依赖
cd ai-leaderboard
npm install

# 2. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 3. 创建 KV 命名空间（数据缓存用）
npx wrangler kv namespace create LEADERBOARD_KV
# 输出形如： id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# 把它填进 wrangler.toml 中 [[kv_namespaces]] 的 id 字段

# 4.（可选）配置 Artificial Analysis 免费 API Key
#    申请：artificialanalysis.ai 注册账号 → API Keys（免费 1000 次/天）
npx wrangler secret put AA_API_KEY

# 5.（可选）给手动刷新接口加口令
npx wrangler secret put REFRESH_TOKEN

# 6. 部署
npx wrangler deploy
```

部署完成后会得到 `https://ai-leaderboard-daily.<你的子域>.workers.dev`，打开即见液态玻璃页面。

## 日常使用

- **自动更新**：cron 设为每天 08:00 UTC（北京时间 16:00）抓取一次，结果写入 KV。
- **手动刷新**：页面右上角 ⟳ 按钮；或 `curl -X POST https://<域名>/api/refresh`（配了 `REFRESH_TOKEN` 则加 `?token=xxx`）。
- **查看原始数据**：`curl https://<域名>/api/data`
- **健康检查**：`curl https://<域名>/healthz`（可配 UptimeRobot 监控）
- **实时日志**：`npx wrangler tail`

## 本地开发

```bash
npm run dev        # wrangler dev，本地起服务（KV 用本地模拟）
npm test           # 20 项冒烟 + 路由测试（mock 数据，无需网络）
npm run check      # 语法检查
```

## 免费额度够不够？

完全够。Worker 免费计划：10 万次请求/天；KV 免费计划：10 万次读/天 + 1000 次写/天。本应用每天只写 2 条（latest + 当日归档），页面本身可被 CDN 缓存。

## 目录结构

```
ai-leaderboard/
├── wrangler.toml            # Worker 配置：cron 定时 + KV 绑定
├── package.json
├── src/
│   ├── index.js             # Worker 入口：路由 / 定时任务 / KV 读写
│   ├── sources.js           # 7 个榜单适配器 + 降级策略 + 内置快照
│   └── frontend.js          # iOS 液态玻璃单页（内联 CSS/JS）
├── scripts/
│   ├── smoke-test.mjs       # 数据解析冒烟测试（12 项）
│   └── worker-route-test.mjs# 路由端到端测试（8 项）
└── README.md
```

## 如何新增一个榜单

在 `src/sources.js` 的 `SOURCES` 数组加一项即可，页面自动渲染：

```js
{
  id: 'my-board',
  name: '某个新榜单',
  category: 'global',            // 或 'china'
  org: '发布方',
  url: 'https://example.com/leaderboard',
  metric: '指标说明',
  accent: '#0A84FF',             // 卡片主题色
  desc: '一句话说明',
  fetcher: async () => {
    const res = await fetchWithTimeout('https://example.com/api/board.json');
    const json = await res.json();
    return json.items.slice(0, 10).map((m, i) => ({
      rank: i + 1, model: m.name, org: m.org, score: m.score, ci: null, license: null,
    }));
  },
}
```

抓取失败时自动降级为「暂无法自动获取」状态并展示官网链接，不影响其他卡片。

## 常见问题

**Q: 部署后页面显示"暂无法自动获取"？**
A: 打开 `/healthz` 看 `lastGeneratedAt`；点页面上的 ⟳ 手动触发一次抓取。cron 任务在部署后可能需要几分钟生效。

**Q: HF 数据集接口报错？**
A: 确认 Worker 能访问 `datasets-server.huggingface.co`（默认可以）。若接口结构变动，`fetchArenaBoard` 会抛错并降级，不会白屏。

**Q: 想改抓取时间？**
A: 编辑 `wrangler.toml` 的 `crons`，如 `["0 2 * * *"]` = 每天 02:00 UTC（北京时间 10:00）。

**Q: 榜单数据归谁？**
A: 版权归各榜单官方所有，本工具仅聚合展示，页面页脚已注明来源。

# AI 排行榜每日速览 · Cloudflare Worker

> 仓库地址：**https://github.com/DodgeZhang/ai-leaderboard-daily** · 通过 Cloudflare 连接 GitHub 自动部署

一个可部署到 **Cloudflare Workers** 的完整应用：后端每日定时抓取国内外最权威的 AI 排行榜数据，存入 Cloudflare KV；前端为 **iOS 液态玻璃（Liquid Glass）风格**的单页展示网站，深浅色自适应、移动端友好。

```
 GitHub 仓库 ──git push──▶ Cloudflare Workers Builds ──▶ 线上 Worker
 (本仓库)                    自动构建部署(约1分钟)            │
                                                            ├─ cron 每日 16:00(北京) 抓取 7 个榜单 → 写入 KV
                                                            ├─ GET  /            液态玻璃页面
                                                            ├─ GET  /api/data    最新快照 JSON(过期自动自愈)
                                                            └─ POST /api/refresh 手动刷新(可选 REFRESH_TOKEN)
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

## 部署：Cloudflare 连接 GitHub（推荐）

代码已上传至 **https://github.com/DodgeZhang/ai-leaderboard-daily**。连接 Cloudflare 后，每次 `git push` 到 `main` 分支都会自动构建并部署，无需再手动操作。

前置：一个 Cloudflare 账号（免费计划即可）。

### 1. 创建 KV 命名空间

Cloudflare Dashboard → **Storage & Databases → Workers KV → Create a namespace**，名称填 `LEADERBOARD_KV`。创建后复制它的 **Namespace ID**，填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "LEADERBOARD_KV"
id = "你的真实命名空间ID"
```

在本地仓库目录提交并推送这一改动：

```bash
git add wrangler.toml && git commit -m "chore: 填入 KV 命名空间 ID" && git push
```

> KV ID 必须是真实值，否则 Cloudflare 部署会报 "KV namespace id is invalid"。

### 2. 连接 GitHub 仓库

Cloudflare Dashboard → **Workers & Pages → Create → Import a repository**：

1. 点击 **Connect to GitHub** 完成授权（首次需允许 Cloudflare 访问指定仓库）
2. 选择仓库 `DodgeZhang/ai-leaderboard-daily`
3. 构建设置保持默认：
   - **Build command**：留空（本项目无构建步骤）
   - **Deploy command**：`npx wrangler deploy`（默认值；wrangler 版本已由 package.json 锁定）
4. 点击 **Save and Deploy**，约 1 分钟后部署完成，得到 `https://ai-leaderboard-daily.<你的子域>.workers.dev`

### 3. 配置密钥（可选）

Worker 页面 → **Settings → Variables and Secrets → Add**：

| 名称 | 说明 |
|---|---|
| `AA_API_KEY` | Artificial Analysis 免费 API Key（artificialanalysis.ai 注册账号 → API Keys，免费 1000 次/天）；不配则 AA 榜显示引导 |
| `REFRESH_TOKEN` | 手动刷新接口 `/api/refresh` 的访问口令；不配则接口公开 |

保存后即时生效，无需重新部署。

### 4. 之后的日常

- **自动部署**：`git push origin main` → Cloudflare 自动构建部署（约 1 分钟），可在 Workers & Pages → Deployments 查看每次部署记录
- **预览部署**：推送到其他分支或发 PR，Cloudflare 会生成预览链接，不影响线上
- **定时任务**：cron 每天 08:00 UTC（北京时间 16:00）自动抓取，随 wrangler.toml 部署生效
- **运行日志**：Worker → Logs 实时查看，或本地 `npx wrangler tail`

## 备选：命令行部署（本地调试用）

```bash
npm install
npx wrangler login                                   # 浏览器授权 Cloudflare
npx wrangler kv namespace create LEADERBOARD_KV      # 把输出的 id 填进 wrangler.toml
npx wrangler secret put AA_API_KEY                   # 可选
npx wrangler deploy
```

与 GitHub 连接方式二选一即可；连接 GitHub 后通常不需要再手动 deploy。

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

**Q: Cloudflare 部署失败，提示 "KV namespace id is invalid"？**
A: `wrangler.toml` 里的 id 还是占位符 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。按「部署」第 1 步在 Dashboard 创建命名空间并填入真实 ID，`git push` 后 Cloudflare 会自动重新部署。

**Q: HF 数据集接口报错？**
A: 确认 Worker 能访问 `datasets-server.huggingface.co`（默认可以）。若接口结构变动，`fetchArenaBoard` 会抛错并降级，不会白屏。

**Q: 想改抓取时间？**
A: 编辑 `wrangler.toml` 的 `crons`，如 `["0 2 * * *"]` = 每天 02:00 UTC（北京时间 10:00）。

**Q: 榜单数据归谁？**
A: 版权归各榜单官方所有，本工具仅聚合展示，页面页脚已注明来源。

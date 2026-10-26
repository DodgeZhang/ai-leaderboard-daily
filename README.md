# AI 排行榜每日速览 · Cloudflare Worker

> 仓库地址：**https://github.com/DodgeZhang/ai-leaderboard-daily** · 通过 Cloudflare 连接 GitHub 自动部署

一个可部署到 **Cloudflare Workers** 的完整应用：后端每日定时抓取全球最权威的 AI 排行榜数据，存入 Cloudflare KV；前端为 **iOS 液态玻璃（Liquid Glass）风格**的单页展示网站，深浅色自适应、移动端友好。

```
 GitHub 仓库 ──git push──▶ Cloudflare Workers Builds ──▶ 线上 Worker
 (本仓库)                    自动构建部署(约1分钟)            │
                                                            ├─ cron 每日 16:00(北京) 抓取 4 个榜单 → 写入 KV
                                                            ├─ GET  /            液态玻璃页面
                                                            ├─ GET  /api/data    最新快照 JSON(过期自动自愈)
                                                            └─ POST /api/refresh 手动刷新(可选 REFRESH_TOKEN)
```

## 收录榜单

收录原则：**只收录能自动拿到数据的榜单，拿不到的不进页面。**

| 榜单 | 数据来源 | 抓取方式 |
|---|---|---|
| Artificial Analysis（第 1 位） | artificialanalysis.ai | 🔑 配置 `AA_API_KEY` 后实时（官方免费 API，分页全量拉取）；未配置时该榜单不显示 |
| Arena · Agent 榜（第 2 位） | arena.ai | ✅ 实时（Hugging Face 官方数据集 `lmarena-ai/leaderboard-dataset`，免密钥） |
| Arena · 文本总榜（第 3 位） | arena.ai | ✅ 实时（同上） |
| Arena · 搜索榜（第 4 位） | arena.ai | ✅ 实时（同上） |

所有榜单展示**全部条目**（不截断前 N 名）：宽屏下 4 个榜单按 2×2 网格排布，单榜条目过多时在卡片内滚动，每张卡片标注收录总数，顶部显示「N 个榜单 · M 款模型」统计。展示顺序固定为 Artificial Analysis → Agent → 文本 → 搜索（前端按固定顺序渲染，旧数据快照也是这个顺序）。

**四种筛选可叠加使用**（页面顶部同一行）：
- **搜索框**：按模型名称 / 厂商关键字模糊匹配（大小写不敏感），右侧 ✕ 一键清空；
- **厂商多选下拉**：勾选一个或多个厂商精确筛选，面板内有厂商关键字过滤和条目计数，「全部厂商」重置；
- **价格多选下拉**：按混合价档位勾选（免费 / ≤ $1 / $1–5 / $5–20 / > $20，单位美元/百万 tokens），多选取并集，面板内显示每档条目数；
- **全部 / 仅开源 / 仅闭源**：分段控件。

> 价格口径：混合价 = 输入价 ×3 + 输出价按 3:1 折算（`(3×输入价 + 输出价)/4`），仅 Artificial Analysis 榜提供价格数据——**价格筛选生效时，Arena 各榜因无价格数据不参与展示**。旧快照没有数值字段时，前端从 `$X/M` 展示串兜底解析。

筛选后某榜单没有符合的条目时该卡片自动隐藏；顶部统计（榜单数 / 模型数）随筛选实时联动；空状态会提示当前生效的筛选条件。
- Arena 各榜：按数据集自带的官方 `license` 字段判定，**准确**；
- Artificial Analysis：接口不返回 license（Pro 订阅才有），按模型名称/发布方的启发式规则判定（GLM、Qwen、DeepSeek、Kimi、MiMo、Gemma、Llama 等开放权重家族），**仅供参考**。

> 关于 Arena 数据：Arena 官方已将全部榜单历史发布为 Hugging Face 数据集（lmarena-ai/leaderboard-dataset）。本 Worker 通过 datasets-server 的 `/filter` 接口按 `category='overall'` 服务端过滤后翻页（实测 text 榜 overall 共 418 条、agent 50 条、search 42 条，合计 7 次请求拿全）。`/filter` 故障时（2026-10-26 曾持续 500）自动回退 `/rows`：并发翻页（每批 5 页）+ 提前终止（实测 overall 集中在表头部，连续 2 页无目标行即判定翻完）+ 失败页重试一轮，并缓存 filter 故障状态 10 分钟避免每榜白等超时。整套抓取实测 8 秒内完成（首次含 filter 超时学费），保证后台抓取在用户关页前写完 KV。

> 关于 Arena 数据：Arena 官方已将全部榜单历史发布为 Hugging Face 数据集（lmarena-ai/leaderboard-dataset），本 Worker 通过 datasets-server REST API 读取，是官方一手数据，无需渲染网页、无需密钥。
>
> 关于国内榜单（SuperCLUE / OpenCompass 司南 / FlagEval 天秤）：2026-10-26 再次全量探测确认，三家官网均为前端动态渲染的 SPA，所有候选接口只返回 HTML，没有公开数据接口，无法自动获取，故未收录。页面只展示成功抓取的榜单，不做占位。

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

### 3. 配置密钥（Artificial Analysis 榜需要）

Worker 页面 → **Settings → Variables and Secrets → Add**：

| 名称 | 类型 | 说明 |
|---|---|---|
| `AA_API_KEY` | **Secret（加密）** | Artificial Analysis 免费 API Key（artificialanalysis.ai 注册账号 → API Keys，免费 1000 次/天）；**不配则 AA 榜整个不显示** |
| `REFRESH_TOKEN` | Secret（加密） | 手动刷新接口 `/api/refresh` 的访问口令；不配则接口公开 |

保存后即时生效，无需重新部署。本地开发则把 key 写进项目根目录的 `.dev.vars`（已被 .gitignore 忽略，不会提交）：

```
AA_API_KEY=aa_xxxxxxxxxxxxxxxx
```

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
- **健康检查 / 故障诊断**：`curl https://<域名>/healthz`——除基本状态外，还报告每个数据源的 `status`/`count`/`error`、`AA_API_KEY` 是否配置，并实时探测一次 AA 接口（可配 UptimeRobot 监控）
- **实时日志**：`npx wrangler tail`

## 本地开发

```bash
npm run dev        # wrangler dev，本地起服务（KV 用本地模拟）
npm test           # 26 项冒烟 + 路由测试（mock 数据，无需网络）
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
│   ├── sources.js           # 4 个榜单适配器（HF filter/rows + AA 分页）+ 开源/闭源判定
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
  category: 'global',
  org: '发布方',
  url: 'https://example.com/leaderboard',
  metric: '指标说明',
  accent: '#0A84FF',             // 卡片主题色
  desc: '一句话说明',
  fetcher: async () => {
    const res = await fetchWithTimeout('https://example.com/api/board.json');
    const json = await res.json();
    return json.items.map((m, i) => ({   // 返回全部条目即可，前端不截断
      rank: i + 1, model: m.name, org: m.org, score: m.score, ci: null, license: null,
    }));
  },
}
```

页面只渲染成功拿到数据的榜单卡片；抓取失败或未配置密钥的榜单不占版面，也不影响其他卡片。条目很多时卡片内会出现滚动条，属正常现象。

## 常见问题

**Q: 部署后页面显示"数据抓取中"或卡片比预期少？**
A: 首次访问时 KV 还是空的，Worker 会立即在后台抓取，页面每 3 秒自动重试，约十几秒后出现数据；也可点右上角 ⟳ 手动刷新。若某张卡片始终不显示：Arena 三分榜无需任何配置，AA 榜需要配置 `AA_API_KEY`（见「部署」第 3 步）。`/api/data` 可以看到每个源的抓取状态和错误原因。

**Q: Cloudflare 部署失败，提示 "KV namespace id is invalid"？**
A: `wrangler.toml` 里的 id 还是占位符 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。按「部署」第 1 步在 Dashboard 创建命名空间并填入真实 ID，`git push` 后 Cloudflare 会自动重新部署。

**Q: 某个榜单条目特别多，卡片有点长？**
A: 全部条目都已加载，卡片内滚动即可查看；每张卡片标注了收录总数（如「共 87 款」）。布局为宽屏 2×2、移动端单列，4 个榜单固定分布。

**Q: AA 榜不显示？**
A: 按顺序排查（页面已内置诊断，不用翻 JSON）：
1. **先点页面右上角 ⟳ 手动刷新**——页面展示的是 KV 里的快照，配置密钥后旧快照里 AA 仍是"未配置"状态，要等下一次 cron（每天 16:00 北京）或手动刷新才会重新抓取；
2. 刷新后**看两处**：① 弹出的提示会直接写明失败原因（如「Artificial Analysis：API 返回 HTTP 401」）；② 页脚出现「⚠ N 个数据源未就绪 · 查看详情」，点开可见每个源的状态和错误；
3. 还想深挖就访问 `curl https://<域名>/healthz`，它会实时报告：`aaKeyPresent`（密钥配没配）、`aaKeyPrefix`（配对没对）、`aaProbe`（Worker 到 AA 接口通不通：`reachable:false` 说明 Worker 出口被 AA 拦截或网络不通，`http:401` 说明 key 无效）、以及每个数据源的 `status`/`count`/`error`；
4. 常见原因：密钥名称打错（必须是 `AA_API_KEY`）、类型没选 Secret、加完没手动刷新。

Arena 三分榜无需任何配置，只要它们在显示就说明抓取链路正常。

**Q: HF 数据集接口报错？**
A: 确认 Worker 能访问 `datasets-server.huggingface.co`（默认可以）。若接口结构变动，`fetchArenaBoard` 会抛错，该卡片不显示，不会白屏。

**Q: 想改抓取时间？**
A: 编辑 `wrangler.toml` 的 `crons`，如 `["0 2 * * *"]` = 每天 02:00 UTC（北京时间 10:00）。

**Q: 榜单数据归谁？**
A: 版权归各榜单官方所有，本工具仅聚合展示，页面页脚已注明来源。

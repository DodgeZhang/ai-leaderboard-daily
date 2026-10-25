/**
 * 前端页面：iOS 液态玻璃（Liquid Glass）风格
 * 单页 HTML，内联 CSS/JS，由 Worker 直接返回。
 * 设计要点：极光渐变背景 + 毛玻璃卡片（backdrop-filter）+ SF Pro 字体栈
 *          + iOS 分段控件 + 深浅色自适应 + 弹簧动效。
 */

export function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#dfe7ff">
<title>AI 排行榜 · 每日速览</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --text-1: #1c1c1e;
    --text-2: #6e6e73;
    --text-3: #aeaeb2;
    --glass-bg: rgba(255, 255, 255, 0.55);
    --glass-bg-strong: rgba(255, 255, 255, 0.78);
    --glass-border: rgba(255, 255, 255, 0.7);
    --glass-shadow: 0 20px 50px -12px rgba(80, 90, 160, 0.22), 0 4px 14px -6px rgba(80, 90, 160, 0.12);
    --row-bg: rgba(255, 255, 255, 0.38);
    --row-hover: rgba(255, 255, 255, 0.72);
    --pill-live-bg: rgba(48, 209, 88, 0.16);
    --pill-live-fg: #1b8f3c;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --text-1: #f5f5f7;
      --text-2: #a1a1a6;
      --text-3: #6e6e73;
      --glass-bg: rgba(30, 30, 34, 0.55);
      --glass-bg-strong: rgba(38, 38, 44, 0.78);
      --glass-border: rgba(255, 255, 255, 0.12);
      --glass-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.5), 0 4px 14px -6px rgba(0, 0, 0, 0.35);
      --row-bg: rgba(255, 255, 255, 0.06);
      --row-hover: rgba(255, 255, 255, 0.12);
      --pill-live-bg: rgba(48, 209, 88, 0.2);
      --pill-live-fg: #4cd964;
    }
  }

  html { -webkit-text-size-adjust: 100%; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
      "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
    color: var(--text-1);
    min-height: 100vh;
    background: linear-gradient(165deg, #dbe4ff 0%, #e9dcff 42%, #ffe6d9 74%, #d9f2ff 100%);
    background-attachment: fixed;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }

  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(165deg, #0b1020 0%, #1a1030 46%, #2a1525 100%); }
  }

  /* ---------- 极光背景 blob ---------- */
  .blob {
    position: fixed;
    border-radius: 50%;
    filter: blur(90px);
    opacity: 0.5;
    pointer-events: none;
    z-index: 0;
    will-change: transform;
  }
  .b1 { width: 46vw; height: 46vw; min-width: 320px; min-height: 320px;
        background: radial-gradient(circle, #7aa5ff, transparent 65%);
        top: -10%; left: -8%; animation: drift1 22s ease-in-out infinite; }
  .b2 { width: 40vw; height: 40vw; min-width: 280px; min-height: 280px;
        background: radial-gradient(circle, #c58bff, transparent 65%);
        top: 30%; right: -10%; animation: drift2 26s ease-in-out infinite; }
  .b3 { width: 36vw; height: 36vw; min-width: 260px; min-height: 260px;
        background: radial-gradient(circle, #ff9ec4, transparent 65%);
        bottom: -12%; left: 22%; animation: drift3 30s ease-in-out infinite; }
  .b4 { width: 26vw; height: 26vw; min-width: 200px; min-height: 200px;
        background: radial-gradient(circle, #ffc49a, transparent 65%);
        bottom: 10%; right: 14%; animation: drift1 24s ease-in-out infinite reverse; }

  @keyframes drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(6vw, 4vh) scale(1.12); } }
  @keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-7vw, -5vh) scale(0.92); } }
  @keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(5vw, -6vh) scale(1.08); } }

  @media (prefers-color-scheme: dark) { .blob { opacity: 0.32; } }

  /* ---------- 布局 ---------- */
  .wrap {
    position: relative;
    z-index: 1;
    max-width: 1180px;
    margin: 0 auto;
    padding: max(20px, env(safe-area-inset-top)) 18px 60px;
  }

  /* ---------- 玻璃材质 ---------- */
  .glass {
    background: var(--glass-bg);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    border-radius: 28px;
  }

  /* ---------- 头部 ---------- */
  header {
    padding: 22px 24px 18px;
    margin-bottom: 22px;
  }
  .title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
  }
  h1 {
    font-size: clamp(28px, 4.5vw, 36px);
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(100deg, #0a84ff 0%, #bf5af2 55%, #ff375f 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    line-height: 1.15;
  }
  .subtitle {
    margin-top: 5px;
    font-size: 14px;
    color: var(--text-2);
    font-weight: 500;
  }
  .meta-row {
    margin-top: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .meta-pill {
    font-size: 12.5px;
    color: var(--text-2);
    background: var(--row-bg);
    border-radius: 999px;
    padding: 6px 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* 圆形刷新按钮 */
  .icon-btn {
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--glass-border);
    background: var(--glass-bg-strong);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    color: var(--text-1);
    font-size: 19px;
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
    box-shadow: 0 6px 18px -6px rgba(80, 90, 160, 0.3);
  }
  .icon-btn:hover { transform: scale(1.08); }
  .icon-btn:active { transform: scale(0.94); }
  .icon-btn.spinning span { display: inline-block; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---------- 卡片网格 ---------- */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
    gap: 20px;
  }
  @media (max-width: 420px) {
    .grid { grid-template-columns: 1fr; }
  }

  .card {
    padding: 20px 20px 16px;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    animation: rise 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;
    transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s;
  }
  .card:hover {
    transform: translateY(-5px);
    box-shadow: 0 28px 60px -14px rgba(80, 90, 160, 0.3), 0 6px 16px -6px rgba(80, 90, 160, 0.14);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(18px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  /* 卡片顶部 accent 高光 */
  .card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 3px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.85;
  }

  .card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .card-title h2 {
    font-size: 17.5px;
    font-weight: 700;
    letter-spacing: -0.2px;
  }
  .card-title .org {
    display: block;
    margin-top: 3px;
    font-size: 12px;
    color: var(--text-2);
  }

  .pill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 4.5px 10px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .pill.live { background: var(--pill-live-bg); color: var(--pill-live-fg); }

  .metric {
    margin-top: 12px;
    font-size: 12.5px;
    color: var(--text-2);
    font-weight: 500;
  }

  /* ---------- 榜单列表 ---------- */
  .list {
    list-style: none;
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 8px 11px;
    background: var(--row-bg);
    border-radius: 14px;
    transition: background 0.2s, transform 0.2s;
  }
  .list li:hover { background: var(--row-hover); transform: translateX(3px); }

  .rk {
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-2);
    background: rgba(120, 120, 128, 0.12);
    font-variant-numeric: tabular-nums;
  }
  .rk1 { background: linear-gradient(140deg, #ffd60a, #ffb340); color: #6b4a00;
         box-shadow: 0 3px 10px -2px rgba(255, 182, 64, 0.55); }
  .rk2 { background: linear-gradient(140deg, #e8e8ed, #b8b8c0); color: #4a4a50;
         box-shadow: 0 3px 10px -3px rgba(160, 160, 175, 0.5); }
  .rk3 { background: linear-gradient(140deg, #f0b27a, #cd7f32); color: #4d2c0a;
         box-shadow: 0 3px 10px -3px rgba(205, 127, 50, 0.5); }

  .mi { flex: 1; min-width: 0; }
  .mi b {
    display: block;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mi .sub {
    display: block;
    font-size: 11.5px;
    color: var(--text-2);
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chips { display: flex; gap: 5px; margin-top: 3px; flex-wrap: wrap; }
  .chip {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-2);
    background: rgba(120, 120, 128, 0.12);
    border-radius: 6px;
    padding: 1.5px 6px;
    font-variant-numeric: tabular-nums;
  }

  .score {
    flex: none;
    text-align: right;
    font-size: 14.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  .score .ci {
    display: block;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-3);
    font-style: normal;
  }

  /* ---------- 卡片底部 ---------- */
  .card-foot {
    margin-top: auto;
    padding-top: 13px;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 10px;
  }
  .note {
    font-size: 11.5px;
    color: var(--text-2);
    line-height: 1.5;
    min-width: 0;
  }
  .go {
    flex: none;
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    color: var(--accent);
    background: rgba(120, 120, 128, 0.1);
    padding: 7px 13px;
    border-radius: 999px;
    transition: background 0.2s, transform 0.2s;
    white-space: nowrap;
  }
  .go:hover { background: rgba(120, 120, 128, 0.2); transform: scale(1.04); }

  /* ---------- 空状态 ---------- */
  .empty-state {
    margin-top: 12px;
    padding: 22px 14px;
    text-align: center;
    background: var(--row-bg);
    border-radius: 16px;
  }
  .empty-state .ico { font-size: 26px; }
  .empty-state p {
    margin-top: 8px;
    font-size: 12.5px;
    color: var(--text-2);
    line-height: 1.6;
  }

  /* ---------- 骨架屏 ---------- */
  .sk {
    height: 268px;
    border-radius: 28px;
    background: linear-gradient(100deg, var(--row-bg) 30%, var(--row-hover) 50%, var(--row-bg) 70%);
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
    border: 1px solid var(--glass-border);
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  /* ---------- 页脚 ---------- */
  footer {
    margin-top: 26px;
    padding: 18px 22px;
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.7;
  }
  footer b { color: var(--text-1); font-weight: 600; }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%) translateY(20px);
    background: var(--glass-bg-strong);
    -webkit-backdrop-filter: blur(20px);
    backdrop-filter: blur(20px);
    border: 1px solid var(--glass-border);
    border-radius: 999px;
    padding: 10px 18px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    box-shadow: var(--glass-shadow);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s, transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    z-index: 10;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body>
<div class="blob b1"></div>
<div class="blob b2"></div>
<div class="blob b3"></div>
<div class="blob b4"></div>

<div class="wrap">
  <header class="glass">
    <div class="title-row">
      <div>
        <h1>AI 排行榜</h1>
        <p class="subtitle">国内外最权威榜单 · Cloudflare Worker 每日自动抓取</p>
      </div>
      <button class="icon-btn" id="refreshBtn" title="立即刷新"><span>⟳</span></button>
    </div>
    <div class="meta-row">
      <span class="meta-pill" id="updatedAt">加载中…</span>
    </div>
  </header>

  <main class="grid" id="grid"></main>

  <footer class="glass">
    <p><b>数据来源</b>：Arena（Hugging Face 官方数据集 lmarena-ai/leaderboard-dataset）· Artificial Analysis（配置 API Key 后显示）</p>
    <p><b>怎么看</b>：Arena 是真人盲测偏好，Artificial Analysis 是独立实测综合分——口径不同，建议交叉参考；头部模型分差常带置信区间，可能是统计意义上的并列。</p>
    <p>本页面只展示成功抓取到数据的榜单 · Cloudflare Worker 每日自动更新 · 数据版权归各榜单官方所有</p>
  </footer>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  'use strict';

  var state = { data: null };
  var grid = document.getElementById('grid');
  var updatedAt = document.getElementById('updatedAt');
  var refreshBtn = document.getElementById('refreshBtn');
  var toast = document.getElementById('toast');
  var coldRetries = 0; // 首次抓取中的自动重试计数

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '时间未知';
    var diff = Date.now() - d.getTime();
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function statusMeta(s) {
    // 只有拿到数据的榜单才会渲染，状态只可能是 live
    return s.status === 'live' ? { cls: 'live', label: '● 实时' } : null;
  }

  function rankCls(r) { return r === 1 ? 'rk rk1' : r === 2 ? 'rk rk2' : r === 3 ? 'rk rk3' : 'rk'; }

  function rowHtml(e) {
    var chips = '';
    if (e.price) chips += '<span class="chip">' + esc(e.price) + '</span>';
    if (e.speed) chips += '<span class="chip">' + esc(e.speed) + '</span>';
    if (e.license && e.license !== 'Proprietary' && e.license.indexOf('MIT') === 0) chips += '<span class="chip">' + esc(e.license) + '</span>';
    var chipsHtml = chips ? '<span class="chips">' + chips + '</span>' : '';
    var ciHtml = e.ci ? '<em class="ci">' + esc(e.ci) + '</em>' : '';
    return '<li>' +
      '<span class="' + rankCls(e.rank) + '">' + esc(e.rank) + '</span>' +
      '<div class="mi"><b>' + esc(e.model) + '</b>' +
      (e.org ? '<span class="sub">' + esc(e.org) + '</span>' : '') + chipsHtml + '</div>' +
      '<span class="score">' + esc(e.score) + ciHtml + '</span>' +
      '</li>';
  }

  function cardHtml(s, i) {
    var st = statusMeta(s);
    var list = (s.entries && s.entries.length)
      ? '<ol class="list">' + s.entries.map(rowHtml).join('') + '</ol>'
      : '';
    var pill = st ? '<span class="pill ' + st.cls + '">' + esc(st.label) + '</span>' : '';
    return '<section class="card glass" style="--accent:' + esc(s.accent) + ';animation-delay:' + (i * 60) + 'ms">' +
      '<div class="card-top"><div class="card-title"><h2>' + esc(s.name) + '</h2>' +
      '<span class="org">' + esc(s.org) + '</span></div>' + pill + '</div>' +
      '<p class="metric">' + esc(s.metric) + '</p>' + list +
      '<div class="card-foot"><span class="note">' + esc(s.desc || '') + '</span>' +
      '<a class="go" href="' + esc(s.url) + '" target="_blank" rel="noopener">官网 ↗</a></div>' +
      '</section>';
  }

  function skeleton(n) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<div class="sk"></div>';
    return h;
  }

  function render() {
    if (!state.data) { grid.innerHTML = skeleton(4); return; }
    // 只渲染成功拿到数据的榜单；拿不到的（未配置 key / 抓取失败）不占版面
    var list = (state.data.sources || []).filter(function (s) {
      return s.entries && s.entries.length > 0;
    });
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="ico">⏳</div>' +
        '<p>数据抓取中，请稍候…<br>首次访问约需十几秒，也可点右上角 ⟳ 手动刷新</p></div>';
      return;
    }
    grid.innerHTML = list.map(cardHtml).join('');
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2600);
  }

  function load() {
    fetch('/api/data', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        state.data = data;
        updatedAt.textContent = '更新于 ' + relTime(data.generatedAt);
        render();
        // 冷启动：KV 里还没有数据时，后台抓取需要十几秒，自动重试几次
        var live = (data.sources || []).filter(function (s) { return s.entries && s.entries.length; }).length;
        if (!live && coldRetries < 12) {
          coldRetries++;
          setTimeout(load, 3000);
        }
      })
      .catch(function () {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="ico">📡</div>' +
          '<p>数据加载失败，请检查网络后重试</p></div>';
      });
  }

  function refresh() {
    refreshBtn.classList.add('spinning');
    fetch('/api/refresh', { method: 'POST', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        state.data = data;
        coldRetries = 0;
        updatedAt.textContent = '更新于 ' + relTime(data.generatedAt);
        render();
        var all = data.sources || [];
        var live = all.filter(function (s) { return s.entries && s.entries.length; }).length;
        showToast('已刷新 · ' + live + '/' + all.length + ' 个榜单获取成功');
      })
      .catch(function () { showToast('刷新失败，请稍后重试'); })
      .then(function () { refreshBtn.classList.remove('spinning'); });
  }

  refreshBtn.addEventListener('click', refresh);

  load();
  setInterval(load, 5 * 60 * 1000); // 每 5 分钟静默轮询一次
})();
</script>
</body>
</html>`;
}

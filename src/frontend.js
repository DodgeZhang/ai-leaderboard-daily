/**
 * 前端页面：iOS 液态玻璃（Liquid Glass）风格
 * 单页 HTML，内联 CSS/JS，由 Worker 直接返回。
 * 设计要点：极光渐变背景 + 毛玻璃卡片（backdrop-filter）+ SF Pro 字体栈
 *          + iOS 分段控件 + 深浅色自适应 + 弹簧动效。
 */

/**
 * 榜单条目组合筛选：开源/闭源 + 关键字 + 厂商多选 + 价格多选（可叠加）。
 * 纯函数，无副作用——既供页面脚本使用（函数源码经 toString() 注入页面），
 * 也供单元测试直接 import 验证。
 *
 * 价格档位（prices 数组，元素为档位 id，空数组 = 不筛选）：
 *   free 免费 / lt1 ≤$1 / t1_5 $1–5 / t5_20 $5–20 / gt20 >$20
 *   单位为混合价（输入:输出 = 3:1）美元/百万 tokens。
 *   无价格数据的条目（Arena 各榜）在任何价格筛选生效时被排除。
 *
 * @param entries  某榜单的条目数组
 * @param opts     { lic: 'all'|'open'|'closed', kw: string, orgs: string[], prices: string[] }
 * @returns 新数组（不过滤原数据）
 */
export function applyEntryFilters(entries, opts) {
  var o = opts || {};
  var lic = o.lic || 'all';
  var kw = String(o.kw || '').trim().toLowerCase();
  var orgs = o.orgs || [];
  var prices = o.prices || [];
  if (!Array.isArray(entries)) return [];

  /* 混合价数值：优先 priceUsd 字段，兜底解析 "$3.5/M" 展示串（兼容旧快照）。
     注意不能用正则：本函数经 toString() 注入页面，而页面脚本在模板字符串里，
     "\$"、"\d" 会被烤成 "$"、"d"；parseFloat 遇非数字即停，无需正则。 */
  function priceUsd(e) {
    if (!e) return null;
    if (typeof e.priceUsd === 'number' && isFinite(e.priceUsd)) return e.priceUsd;
    var s = String(e.price || '');
    if (s.charAt(0) === '$') s = s.slice(1); // 去掉货币符号前缀
    var v = parseFloat(s); // '0.8/M' → 0.8
    return isFinite(v) ? v : null;
  }
  /* 档位边界（与页面 PRICE_TIERS 标签保持一致） */
  function inPriceTier(p, t) {
    if (t === 'free') return p <= 0;
    if (t === 'lt1') return p > 0 && p <= 1;
    if (t === 't1_5') return p > 1 && p <= 5;
    if (t === 't5_20') return p > 5 && p <= 20;
    if (t === 'gt20') return p > 20;
    return true; // 未知档位 id 不过滤
  }

  return entries.filter(function (e) {
    if (lic === 'open' && !e.open) return false;
    if (lic === 'closed' && e.open) return false;
    if (orgs.length && orgs.indexOf(e.org) < 0) return false;
    if (kw) {
      var name = String(e.model || '').toLowerCase();
      var org = String(e.org || '').toLowerCase();
      if (name.indexOf(kw) < 0 && org.indexOf(kw) < 0) return false;
    }
    if (prices.length) {
      var p = priceUsd(e);
      if (p == null) return false; // 没有价格数据的条目不参与价格筛选
      var hit = false;
      for (var i = 0; i < prices.length; i++) {
        if (inPriceTier(p, prices[i])) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  });
}

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

  /* [hidden] 必须能压过组件自身的 display：
     厂商下拉面板（flex）、搜索框清除按钮（grid）、诊断区（flex）都靠 hidden 属性显隐，
     否则会被 CSS 里的 display 强制显示（面板关不掉、✕ 常显） */
  [hidden] { display: none !important; }

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
    --seg-bg: rgba(120, 120, 128, 0.16);
    --seg-active: rgba(255, 255, 255, 0.95);
    --pill-live-bg: rgba(48, 209, 88, 0.16);
    --pill-live-fg: #1b8f3c;
    --pill-stale-bg: rgba(255, 159, 10, 0.14);
    --pill-stale-fg: #a05a00;
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
      --seg-bg: rgba(120, 120, 128, 0.24);
      --seg-active: rgba(99, 99, 102, 0.85);
      --pill-live-bg: rgba(48, 209, 88, 0.2);
      --pill-live-fg: #4cd964;
      --pill-stale-bg: rgba(255, 159, 10, 0.18);
      --pill-stale-fg: #ffb340;
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
  /* header 带 backdrop-filter（玻璃材质）会形成堆叠上下文，且默认静态定位；
     若不显式抬升 z-index，内部绝对定位的下拉面板会被后面 position:relative 的
     榜单卡片盖住（面板 z-index 再高也被困在 header 的堆叠上下文里）。
     抬到 40：高于卡片（auto=0），低于页脚 toast（10，且 toast 在 .wrap 外层不受影响）。 */
  header {
    position: relative;
    z-index: 40;
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

  /* ---------- 筛选行：搜索框 + 厂商多选 + 开源/闭源 ---------- */
  .filter-row {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .search-box {
    flex: 1 1 230px;
    min-width: 190px;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    background: var(--seg-bg);
    border-radius: 12px;
    padding: 0 11px;
    transition: box-shadow 0.25s;
  }
  .search-box:focus-within {
    box-shadow: 0 0 0 2px rgba(10, 132, 255, 0.45);
  }
  .search-box .s-ico { font-size: 12px; opacity: 0.55; flex: none; }
  .search-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    font: inherit;
    font-size: 13px;
    color: var(--text-1);
  }
  .search-box input::placeholder { color: var(--text-2); opacity: 0.85; }
  .s-clear {
    flex: none;
    border: 0;
    background: rgba(120, 120, 128, 0.2);
    color: var(--text-2);
    width: 18px;
    height: 18px;
    border-radius: 50%;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    display: grid;
    place-items: center;
    padding: 0;
  }
  .s-clear:hover { background: rgba(120, 120, 128, 0.35); color: var(--text-1); }

  /* 厂商多选下拉 */
  .multi { position: relative; }
  .multi-toggle {
    height: 34px;
    border: 0;
    background: var(--seg-bg);
    border-radius: 12px;
    padding: 0 12px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    transition: color 0.25s;
  }
  .multi-toggle:hover, .multi-toggle.active { color: var(--text-1); }
  .multi-toggle .caret { font-style: normal; font-size: 9px; opacity: 0.7; }
  .multi-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    width: 252px;
    max-height: 348px;
    display: flex;
    flex-direction: column;
    background: var(--glass-bg-strong);
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
    border: 1px solid var(--glass-border);
    border-radius: 14px;
    box-shadow: var(--glass-shadow);
    z-index: 30;
    padding: 8px;
    animation: pop 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
  .multi-panel input.m-filter {
    width: 100%;
    border: 0;
    outline: 0;
    background: var(--seg-bg);
    border-radius: 9px;
    padding: 7px 10px;
    font: inherit;
    font-size: 12.5px;
    color: var(--text-1);
    margin-bottom: 6px;
  }
  .multi-panel input.m-filter::placeholder { color: var(--text-2); }
  .multi-list { overflow-y: auto; overscroll-behavior: contain; }
  .multi-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border-radius: 9px;
    font-size: 13px;
    color: var(--text-1);
    cursor: pointer;
    user-select: none;
  }
  .multi-item:hover { background: var(--row-hover); }
  .multi-item input { accent-color: #0a84ff; margin: 0; flex: none; }
  .multi-item .cnt {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .multi-empty { padding: 12px 8px; font-size: 12px; color: var(--text-2); text-align: center; }
  .multi-note {
    margin-top: 6px;
    padding: 8px 8px 2px;
    border-top: 1px dashed var(--glass-border);
    font-size: 11px;
    color: var(--text-2);
    line-height: 1.6;
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

  /* iOS 分段控件（开源 / 闭源筛选） */
  .seg {
    display: inline-flex;
    background: var(--seg-bg);
    border-radius: 14px;
    padding: 2.5px;
    gap: 2px;
  }
  .seg button {
    border: 0;
    background: transparent;
    padding: 7px 15px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.25s, color 0.25s, box-shadow 0.25s;
    white-space: nowrap;
  }
  .seg button.active {
    background: var(--seg-active);
    color: var(--text-1);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  }

  /* ---------- 卡片网格：宽屏 2×2（正好容纳 4 个榜单） ---------- */
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
  }
  @media (min-width: 760px) {
    .grid { grid-template-columns: repeat(2, 1fr); }
  }

  .card {
    padding: 20px 20px 16px;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    min-height: 0; /* 允许 grid 子项收缩，卡片内滚动才能生效 */
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
  .pill.stale { background: var(--pill-stale-bg); color: var(--pill-stale-fg); }

  .metric {
    margin-top: 12px;
    font-size: 12.5px;
    color: var(--text-2);
    font-weight: 500;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .count {
    flex: none;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    background: rgba(120, 120, 128, 0.12);
    border-radius: 999px;
    padding: 2.5px 9px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ---------- 榜单列表（条目全量展示，超长时卡片内滚动） ---------- */
  .list {
    list-style: none;
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: min(58vh, 620px);
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: rgba(120, 120, 128, 0.35) transparent;
    padding-right: 4px;
  }
  .list::-webkit-scrollbar { width: 4px; }
  .list::-webkit-scrollbar-track { background: transparent; }
  .list::-webkit-scrollbar-thumb { background: rgba(120, 120, 128, 0.35); border-radius: 4px; }
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
  .chip-lic { color: #1b8f3c; background: rgba(48, 209, 88, 0.14); }
  @media (prefers-color-scheme: dark) {
    .chip-lic { color: #4cd964; background: rgba(48, 209, 88, 0.18); }
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

  /* ---------- 数据源诊断（仅在有源失败时出现） ---------- */
  .diag {
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px dashed var(--glass-border);
  }
  .diag-toggle {
    border: 0;
    background: rgba(255, 159, 10, 0.14);
    color: #b2500a;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 5px 12px;
    cursor: pointer;
    transition: background 0.25s;
  }
  .diag-toggle:hover { background: rgba(255, 159, 10, 0.24); }
  @media (prefers-color-scheme: dark) {
    .diag-toggle { background: rgba(255, 179, 64, 0.18); color: #ffb340; }
  }
  .diag-body {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 11.5px;
  }
  .diag-row { display: flex; gap: 8px; align-items: baseline; }
  .diag-row b { flex: none; font-weight: 600; color: var(--text-1); }
  .diag-row .msg { color: var(--text-2); word-break: break-all; }
  .diag-row .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; align-self: center; }
  .diag-row .dot.ok { background: #34c759; }
  .diag-row .dot.warn { background: #ff9f0a; }
  .diag-row .dot.bad { background: #ff453a; }

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
    max-width: min(92vw, 620px);
    text-align: center;
    line-height: 1.55;
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
        <p class="subtitle">获取最权威榜单 · 每日自动抓取</p>
      </div>
      <button class="icon-btn" id="refreshBtn" title="立即刷新"><span>⟳</span></button>
    </div>
    <div class="meta-row">
      <span class="meta-pill" id="updatedAt">加载中…</span>
      <span class="meta-pill" id="boardCount"></span>
    </div>
    <div class="filter-row">
      <div class="search-box">
        <span class="s-ico">🔍</span>
        <input id="searchInput" type="text" placeholder="搜索模型 / 厂商…" autocomplete="off" />
        <button class="s-clear" id="searchClear" hidden title="清空">✕</button>
      </div>
      <div class="multi" id="orgFilter">
        <button class="multi-toggle" id="orgToggle"><span id="orgToggleLabel">厂商：全部</span><i class="caret">▾</i></button>
        <div class="multi-panel" id="orgPanel" hidden>
          <input class="m-filter" id="orgSearch" type="text" placeholder="筛选厂商…" autocomplete="off" />
          <label class="multi-item"><input type="checkbox" id="orgAll" checked /><span>全部厂商</span></label>
          <div class="multi-list" id="orgList"></div>
        </div>
      </div>
      <div class="multi" id="priceFilter">
        <button class="multi-toggle" id="priceToggle"><span id="priceToggleLabel">价格：全部</span><i class="caret">▾</i></button>
        <div class="multi-panel" id="pricePanel" hidden>
          <label class="multi-item"><input type="checkbox" id="priceAll" checked /><span>全部价格</span></label>
          <div class="multi-list" id="priceList"></div>
          <p class="multi-note">混合价（输入:输出 = 3:1，$/百万 tokens）<br>仅 Artificial Analysis 榜提供价格数据</p>
        </div>
      </div>
      <div class="seg" id="seg">
        <button data-lic="all" class="active">全部</button>
        <button data-lic="open">仅开源</button>
        <button data-lic="closed">仅闭源</button>
      </div>
    </div>
  </header>

  <main class="grid" id="grid"></main>

  <footer class="glass">
    <div class="diag" id="diag" hidden>
      <button class="diag-toggle" id="diagToggle">⚠ <span id="diagCount"></span></button>
      <div class="diag-body" id="diagBody" hidden></div>
    </div>
    <p><b>数据来源</b>：Arena（Hugging Face 官方数据集 lmarena-ai/leaderboard-dataset）· Artificial Analysis（配置 API Key 后显示）</p>
    <p><b>价格</b>：混合价 = 输入价 ×3 + 输出价按 3:1 折算（美元/百万 tokens），仅 Artificial Analysis 榜提供价格数据——价格筛选生效时，Arena 各榜因无价格数据不参与展示。</p>
    <p><b>开源 / 闭源</b>：Arena 各榜按官方 license 字段判定，准确；Artificial Analysis 接口不提供 license，按模型名称/发布方启发式判定，仅供参考。</p>
    <p><b>怎么看</b>：Arena 是真人盲测偏好，Artificial Analysis 是独立实测综合分——口径不同，建议交叉参考；头部模型分差常带置信区间，可能是统计意义上的并列。</p>
    <p>本页面只展示成功抓取到数据的榜单 · Cloudflare Worker 每日自动更新 · 数据版权归各榜单官方所有</p>
  </footer>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  'use strict';

  /* 组合筛选纯函数（由模块顶层注入，与单元测试共用同一实现） */
  var filterEntries = ${applyEntryFilters};

  /* 榜单展示顺序：Artificial Analysis → Agent 榜 → 文本总榜 → 搜索榜
     （即使 KV 里是旧顺序的快照，也按这个顺序渲染） */
  var BOARD_ORDER = ['aa-llm', 'arena-agent', 'arena-text', 'arena-search'];

  var state = { data: null, lic: 'all', kw: '', orgs: [], orgQuery: '', prices: [] };
  var grid = document.getElementById('grid');
  var updatedAt = document.getElementById('updatedAt');
  var boardCount = document.getElementById('boardCount');
  var refreshBtn = document.getElementById('refreshBtn');
  var seg = document.getElementById('seg');
  var toast = document.getElementById('toast');
  var diag = document.getElementById('diag');
  var diagToggle = document.getElementById('diagToggle');
  var diagBody = document.getElementById('diagBody');
  var diagCount = document.getElementById('diagCount');
  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');
  var orgFilter = document.getElementById('orgFilter');
  var orgToggle = document.getElementById('orgToggle');
  var orgToggleLabel = document.getElementById('orgToggleLabel');
  var orgPanel = document.getElementById('orgPanel');
  var orgSearch = document.getElementById('orgSearch');
  var orgAll = document.getElementById('orgAll');
  var orgList = document.getElementById('orgList');
  var priceFilter = document.getElementById('priceFilter');
  var priceToggle = document.getElementById('priceToggle');
  var priceToggleLabel = document.getElementById('priceToggleLabel');
  var pricePanel = document.getElementById('pricePanel');
  var priceAll = document.getElementById('priceAll');
  var priceList = document.getElementById('priceList');
  var coldRetries = 0; // 首次抓取中的自动重试计数
  var loadRetries = 0; // 请求失败后的自动重试计数
  var MAX_LOAD_RETRIES = 10;

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
    // 只有拿到数据的榜单才会渲染；stale = 本次抓取失败、展示上次成功的数据
    if (s.status === 'live') return { cls: 'live', label: '● 实时' };
    if (s.status === 'stale') return { cls: 'stale', label: '⏳ 上次数据' };
    return null;
  }

  /** 截断过长的错误信息，便于在 toast / 诊断区展示 */
  function shortErr(msg, max) {
    var s = String(msg || '未知错误');
    return s.length > (max || 60) ? s.slice(0, max || 60) + '…' : s;
  }

  /**
   * 数据源诊断区：只在使用原始数据（不受开源/闭源筛选影响）判断，
   * 有任何一个源没拿到数据时，页脚出现可展开的详情，直接显示失败原因，
   * 不用再去 /api/data 的 JSON 里翻 error 字段。
   */
  function updateDiag(data) {
    var all = (data && data.sources) || [];
    var failed = all.filter(function (s) { return !(s.entries && s.entries.length); });
    var stale = all.filter(function (s) { return s.status === 'stale'; });
    if (!failed.length && !stale.length) { diag.hidden = true; diagBody.hidden = true; return; }
    diag.hidden = false;
    diagCount.textContent = (failed.length ? failed.length + ' 个数据源未就绪' : '') +
      (failed.length && stale.length ? ' · ' : '') +
      (stale.length ? stale.length + ' 个数据源为上次数据' : '') + ' · 查看详情';
    diagBody.innerHTML = all.map(function (s) {
      var ok = s.entries && s.entries.length;
      var cls = ok ? (s.status === 'stale' ? 'warn' : 'ok') : 'bad';
      var msg = ok
        ? (s.status === 'stale'
            ? '本次抓取失败，展示上次成功的数据 · ' + s.entries.length + ' 款'
            : '正常 · ' + s.entries.length + ' 款')
        : esc(shortErr(s.error || '暂无数据', 120));
      return '<div class="diag-row"><span class="dot ' + cls + '"></span>' +
        '<b>' + esc(s.name) + '</b><span class="msg">' + msg + '</span></div>';
    }).join('');
  }

  function rankCls(r) { return r === 1 ? 'rk rk1' : r === 2 ? 'rk rk2' : r === 3 ? 'rk rk3' : 'rk'; }

  function rowHtml(e) {
    var chips = '';
    if (e.price) chips += '<span class="chip">' + esc(e.price) + '</span>';
    if (e.speed) chips += '<span class="chip">' + esc(e.speed) + '</span>';
    if (e.open && e.license) chips += '<span class="chip chip-lic">' + esc(e.license) + '</span>';
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
    var n = (s.entries && s.entries.length) || 0;
    return '<section class="card glass" style="--accent:' + esc(s.accent) + ';animation-delay:' + (i * 60) + 'ms">' +
      '<div class="card-top"><div class="card-title"><h2>' + esc(s.name) + '</h2>' +
      '<span class="org">' + esc(s.org) + '</span></div>' + pill + '</div>' +
      '<p class="metric"><span>' + esc(s.metric) + '</span>' +
      '<span class="count">共 ' + n + ' 款</span></p>' + list +
      '<div class="card-foot"><span class="note">' + esc(s.desc || '') + '</span>' +
      '<a class="go" href="' + esc(s.url) + '" target="_blank" rel="noopener">官网 ↗</a></div>' +
      '</section>';
  }

  function skeleton(n) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<div class="sk"></div>';
    return h;
  }

  /** 收集全部厂商及条目数（按条目数降序，同名按字母序） */
  function collectOrgs() {
    var map = {};
    ((state.data && state.data.sources) || []).forEach(function (s) {
      (s.entries || []).forEach(function (e) {
        var o = e.org || '未知';
        map[o] = (map[o] || 0) + 1;
      });
    });
    return Object.keys(map)
      .map(function (o) { return { name: o, count: map[o] }; })
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  /** 渲染厂商多选面板（含面板内关键字过滤与已选状态） */
  function renderOrgList() {
    var q = state.orgQuery.trim().toLowerCase();
    var orgs = collectOrgs().filter(function (o) {
      return !q || o.name.toLowerCase().indexOf(q) >= 0;
    });
    orgList.innerHTML = orgs.map(function (o) {
      return '<label class="multi-item"><input type="checkbox" data-org="' + esc(o.name) + '"' +
        (state.orgs.indexOf(o.name) >= 0 ? ' checked' : '') + ' /><span>' + esc(o.name) + '</span>' +
        '<span class="cnt">' + o.count + '</span></label>';
    }).join('') || '<div class="multi-empty">无匹配厂商</div>';
    orgAll.checked = state.orgs.length === 0;
    orgToggleLabel.textContent = state.orgs.length === 0
      ? '厂商：全部'
      : '厂商：' + (state.orgs.length === 1 ? state.orgs[0] : '已选 ' + state.orgs.length + ' 家');
    orgToggle.classList.toggle('active', state.orgs.length > 0);
  }

  /* ---------- 价格多选 ---------- */
  /* 档位边界与 applyEntryFilters 内的 inPriceTier 保持一致（改一边必须同步另一边） */
  var PRICE_TIERS = [
    { id: 'free', label: '免费' },
    { id: 'lt1', label: '≤ $1/M' },
    { id: 't1_5', label: '$1 – 5/M' },
    { id: 't5_20', label: '$5 – 20/M' },
    { id: 'gt20', label: '> $20/M' },
  ];

  /** 条目混合价数值：优先 priceUsd，兜底解析 "$3.5/M" 展示串（旧快照）。
      不能用正则：页面脚本整体在模板字符串里，"\$" 会被烤成 "$"。 */
  function parsePriceUsd(e) {
    if (!e) return null;
    if (typeof e.priceUsd === 'number' && isFinite(e.priceUsd)) return e.priceUsd;
    var s = String(e.price || '');
    if (s.charAt(0) === '$') s = s.slice(1); // 去掉货币符号前缀
    var v = parseFloat(s); // '0.8/M' → 0.8
    return isFinite(v) ? v : null;
  }

  /** 数值 → 档位 id（无价格数据返回 null） */
  function tierOfPrice(p) {
    if (p == null) return null;
    if (p <= 0) return 'free';
    if (p <= 1) return 'lt1';
    if (p <= 5) return 't1_5';
    if (p <= 20) return 't5_20';
    return 'gt20';
  }

  /** 统计各价格档位的条目数（只数有价格数据的条目，即 AA 榜） */
  function priceTierCounts() {
    var counts = {};
    ((state.data && state.data.sources) || []).forEach(function (s) {
      (s.entries || []).forEach(function (e) {
        var t = tierOfPrice(parsePriceUsd(e));
        if (t) counts[t] = (counts[t] || 0) + 1;
      });
    });
    return counts;
  }

  /** 渲染价格多选面板（固定 5 档 + 条目计数 + 已选状态） */
  function renderPriceList() {
    var counts = priceTierCounts();
    priceList.innerHTML = PRICE_TIERS.map(function (t) {
      return '<label class="multi-item"><input type="checkbox" data-price="' + t.id + '"' +
        (state.prices.indexOf(t.id) >= 0 ? ' checked' : '') + ' /><span>' + t.label + '</span>' +
        '<span class="cnt">' + (counts[t.id] || 0) + '</span></label>';
    }).join('');
    priceAll.checked = state.prices.length === 0;
    priceToggleLabel.textContent = state.prices.length === 0
      ? '价格：全部'
      : '价格：' + (state.prices.length === 1
        ? (PRICE_TIERS.filter(function (t) { return t.id === state.prices[0]; })[0] || {}).label
        : '已选 ' + state.prices.length + ' 档');
    priceToggle.classList.toggle('active', state.prices.length > 0);
  }

  /** 顶部「N 个榜单 · M 款模型」随筛选联动 */
  function syncCount() {
    if (!state.data) return;
    var st = stats(state.data);
    boardCount.textContent = st.boards ? (st.boards + ' 个榜单 · ' + st.models + ' 款模型') : '';
  }

  function render() {
    if (!state.data) { grid.innerHTML = skeleton(4); return; }
    // 组合筛选（开源/闭源 + 关键字 + 厂商多选，可叠加）；只渲染筛完仍有条目的榜单
    var list = (state.data.sources || [])
      .map(function (s) {
        return Object.assign({}, s, { entries: filterEntries(s.entries || [], state) });
      })
      .filter(function (s) { return s.entries.length > 0; });
    // 固定展示顺序：Agent → AA → 文本 → 搜索（旧快照也按此顺序）
    list.sort(function (a, b) {
      var ia = BOARD_ORDER.indexOf(a.id); if (ia < 0) ia = 99;
      var ib = BOARD_ORDER.indexOf(b.id); if (ib < 0) ib = 99;
      return ia - ib;
    });
    if (!list.length) {
      var tips = [];
      if (state.kw) tips.push('关键字「' + state.kw + '」');
      if (state.orgs.length) tips.push('厂商（' + state.orgs.length + ' 家）');
      if (state.prices.length) {
        tips.push('价格（' + state.prices.map(function (id) {
          var t = PRICE_TIERS.filter(function (x) { return x.id === id; })[0];
          return t ? t.label : id;
        }).join(' / ') + '）');
      }
      if (state.lic !== 'all') tips.push(state.lic === 'open' ? '仅开源' : '仅闭源');
      var cold = !tips.length;
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="ico">' +
        (cold ? '⏳' : '🔍') + '</div><p>' +
        (cold
          ? '数据抓取中，请稍候…<br>首次访问约需十几秒，也可点右上角 ⟳ 手动刷新'
          : '没有符合 ' + tips.join(' + ') + ' 的模型，试试放宽条件') +
        '</p></div>';
      return;
    }
    grid.innerHTML = list.map(cardHtml).join('');
  }

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { toast.classList.remove('show'); }, ms || 2600);
  }

  function stats(data) {
    var live = (data.sources || []).map(function (s) {
      return Object.assign({}, s, { entries: filterEntries(s.entries || [], state) });
    }).filter(function (s) { return s.entries.length; });
    var models = live.reduce(function (sum, s) { return sum + s.entries.length; }, 0);
    return { boards: live.length, models: models };
  }

  function load() {
    fetch('/api/data', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        state.data = data;
        loadRetries = 0;
        updatedAt.textContent = '更新于 ' + relTime(data.generatedAt);
        var st = stats(data);
        boardCount.textContent = st.boards ? (st.boards + ' 个榜单 · ' + st.models + ' 款模型') : '';
        render();
        renderOrgList();
        renderPriceList();
        updateDiag(data);
        // 冷启动：KV 里还没有数据时，后台抓取需要十几秒，自动重试几次
        if (!st.boards && coldRetries < 12) {
          coldRetries++;
          setTimeout(load, 3000);
        }
      })
      .catch(function (err) {
        // 请求失败不直接判死刑：自动重试（旧缓存页/偶发网络问题都能自愈），
        // 仍失败才显示错误，并引导去 /healthz 看服务端诊断
        loadRetries++;
        if (loadRetries <= MAX_LOAD_RETRIES) {
          setTimeout(load, 3000);
          return;
        }
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="ico">📡</div>' +
          '<p>数据加载失败，请检查网络后重试<br>' +
          '<span style="font-size:12px;opacity:.7">连续 ' + MAX_LOAD_RETRIES + ' 次请求未成功（' +
          String((err && err.message) || '网络错误') + '）· 可访问 /healthz 查看服务端状态</span></p></div>';
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
        var st = stats(data);
        boardCount.textContent = st.boards ? (st.boards + ' 个榜单 · ' + st.models + ' 款模型') : '';
        render();
        renderOrgList();
        renderPriceList();
        updateDiag(data);
        var all = data.sources || [];
        var bad = all.filter(function (s) { return !(s.entries && s.entries.length); });
        var msg = '已刷新 · ' + (all.length - bad.length) + '/' + all.length + ' 个榜单获取成功';
        if (bad.length) {
          // 直接把失败原因显示出来，不用再去 /api/data 翻 JSON
          msg += '；' + bad.map(function (s) {
            return s.name + '：' + shortErr(s.error || '暂无数据', 40);
          }).join('；');
        }
        showToast(msg, bad.length ? 9000 : 2600);
      })
      .catch(function () { showToast('刷新失败，请稍后重试'); })
      .then(function () { refreshBtn.classList.remove('spinning'); });
  }

  refreshBtn.addEventListener('click', refresh);

  diagToggle.addEventListener('click', function () {
    diagBody.hidden = !diagBody.hidden;
  });

  /* ---------- 搜索框：按模型 / 厂商关键字模糊筛选 ---------- */
  searchInput.addEventListener('input', function () {
    state.kw = searchInput.value;
    searchClear.hidden = !state.kw;
    render();
    if (state.data) {
      var st = stats(state.data);
      boardCount.textContent = st.boards ? (st.boards + ' 个榜单 · ' + st.models + ' 款模型') : '';
    }
  });
  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    state.kw = '';
    searchClear.hidden = true;
    render();
    if (state.data) {
      var st2 = stats(state.data);
      boardCount.textContent = st2.boards ? (st2.boards + ' 个榜单 · ' + st2.models + ' 款模型') : '';
    }
    searchInput.focus();
  });

  /* ---------- 厂商多选下拉 ---------- */
  orgToggle.addEventListener('click', function (e) {
    e.stopPropagation();
    pricePanel.hidden = true; // 两个下拉互斥
    orgPanel.hidden = !orgPanel.hidden;
    if (!orgPanel.hidden) {
      renderOrgList();
      orgSearch.value = state.orgQuery;
    }
  });
  orgSearch.addEventListener('input', function () {
    state.orgQuery = orgSearch.value;
    renderOrgList();
  });
  // 勾选 / 取消某个厂商（事件委托）
  orgList.addEventListener('change', function (e) {
    var box = e.target;
    var org = box.getAttribute && box.getAttribute('data-org');
    if (!org) return;
    var i = state.orgs.indexOf(org);
    if (box.checked && i < 0) state.orgs.push(org);
    if (!box.checked && i >= 0) state.orgs.splice(i, 1);
    renderOrgList();
    render();
    if (state.data) {
      var st3 = stats(state.data);
      boardCount.textContent = st3.boards ? (st3.boards + ' 个榜单 · ' + st3.models + ' 款模型') : '';
    }
  });
  // 「全部厂商」：清空已选
  orgAll.addEventListener('change', function () {
    if (orgAll.checked) {
      state.orgs = [];
      renderOrgList();
      render();
      if (state.data) {
        var st4 = stats(state.data);
        boardCount.textContent = st4.boards ? (st4.boards + ' 个榜单 · ' + st4.models + ' 款模型') : '';
      }
    }
  });
  // 点击面板外部关闭（阻止面板内点击冒泡关闭）
  orgPanel.addEventListener('click', function (e) { e.stopPropagation(); });
  pricePanel.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () {
    orgPanel.hidden = true;
    pricePanel.hidden = true;
  });

  /* ---------- 价格多选下拉 ---------- */
  priceToggle.addEventListener('click', function (e) {
    e.stopPropagation();
    orgPanel.hidden = true; // 两个下拉互斥
    pricePanel.hidden = !pricePanel.hidden;
    if (!pricePanel.hidden) renderPriceList();
  });
  // 「全部价格」：清空已选档位
  priceAll.addEventListener('change', function () {
    if (priceAll.checked) {
      state.prices = [];
      renderPriceList();
      render();
      syncCount();
    }
  });
  // 勾选 / 取消某个价格档位（事件委托）
  priceList.addEventListener('change', function (e) {
    var box = e.target;
    var tier = box.getAttribute && box.getAttribute('data-price');
    if (!tier) return;
    var i = state.prices.indexOf(tier);
    if (box.checked && i < 0) state.prices.push(tier);
    if (!box.checked && i >= 0) state.prices.splice(i, 1);
    renderPriceList();
    render();
    syncCount();
  });

  seg.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    seg.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    state.lic = btn.getAttribute('data-lic');
    render();
    // 顶部统计随筛选联动
    if (state.data) {
      var st = stats(state.data);
      boardCount.textContent = st.boards ? (st.boards + ' 个榜单 · ' + st.models + ' 款模型') : '';
    }
  });

  load();
  setInterval(load, 5 * 60 * 1000); // 每 5 分钟静默轮询一次
})();
</script>
</body>
</html>`;
}

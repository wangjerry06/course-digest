/* course-digest 前端查看器。
 *
 * 两种数据来源（高 1 修复）：
 *   ?mock=1   → mock 模式，只读 ./fixture/mock.json，不发任何 /api 请求
 *   无该参数   → 生产模式，fetch('/api/doc/<docId>')（由本地服务提供）
 * 两者的返回体字段名完全一致，只有 pdf_full / pdf_simplified 的 URL 不同。
 *
 * PDF 渲染走 PDF.js 自有 canvas 列表 + 虚拟化（ADR-005）：
 *   - 每页容器的高度从 MediaBox 提前算出 → 首帧滚动条长度就是准的
 *   - IntersectionObserver 只渲染视口附近（前后各 2 页），滚远即丢 canvas
 *   - 不用内置 viewer.html（iframe 跨文档，联动做不了）
 */

import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

/* 前后各预加载的页数 */
const PRELOAD_PAGES = 2;
/* 渲染比例上限，防止超宽屏上 canvas 过大 */
const MAX_SCALE = 2;
/* 网络请求超时：没这个，碰到死连接会永远停在「加载中…」 */
const FETCH_TIMEOUT_MS = 5000;
const PDF_TIMEOUT_MS = 15000;

const VENDOR = '/vendor/pdfjs/';
/* 用户缩放倍率的上限档（PDF_FONT.levels 的最大值）。渲染上限 = MAX_SCALE × 它 */
const MAX_ZOOM = 1.6;

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  version: 'simplified',
  pdf: null,
  sizes: [],        // [{w,h}]：scale=1 时的页面尺寸
  scale: 1,
  pdfZoom: 1,       // 用户缩放倍率（100% = 刚好铺满左栏）
  pages: [],        // 每页的容器 div
  rendered: new Map(),
  observer: null,
};

/* ------------------------------------------------------------------ *
 * 数据来源
 * ------------------------------------------------------------------ */

function docIdFromUrl(params) {
  if (params.get('doc')) return params.get('doc');
  const m = location.pathname.match(/\/doc\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/* 带超时的 fetch：超时 / 失败都抛人话错误。
 * 没有超时的话，服务被停过、连接半死时 fetch 会永远 pending，
 * 页面就卡在「加载中…」——不报错也不重试。 */
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）：${url}`);
    }
    throw new Error(`请求失败：${url}（${err && err.message}）`);
  }
  if (!res.ok) throw new Error(`${url} 返回 ${res.status} ${res.statusText}`);
  return res.json();
}

/* 给任意 promise 加超时（PDF.js 的加载不走 fetch JSON 那条路） */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000} 秒）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchDocData() {
  const params = new URLSearchParams(location.search);

  if (params.has('mock')) {
    return fetchJson('/fixture/mock.json');
  }

  const id = docIdFromUrl(params);
  if (!id) throw new Error('缺少 docId：请用 ?doc=<docId> 或 /doc/<docId> 访问');
  return fetchJson(`/api/doc/${encodeURIComponent(id)}`);
}

/* ------------------------------------------------------------------ *
 * 页锚点（约定：<!-- pages: 5,6 --> → data-pages，注释不显示）
 * ------------------------------------------------------------------ */

function nextElementAfter(node) {
  if (node.nextElementSibling) return node.nextElementSibling;
  let p = node.parentElement;
  while (p && p !== document.body) {
    if (p.nextElementSibling) return p.nextElementSibling;
    p = p.parentElement;
  }
  return null;
}

function attachAnchors(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);

  for (const node of comments) {
    const m = /^\s*pages\s*:\s*([0-9,\s]+?)\s*$/.exec(node.nodeValue || '');
    if (!m) continue;

    const pages = m[1]
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);

    const target = nextElementAfter(node);
    const parent = node.parentElement;
    node.remove();
    // 注释独占一个 <p> 时，把空壳也清掉
    if (parent && parent !== root && parent.tagName === 'P'
        && !parent.textContent.trim() && !parent.querySelector('*')) {
      parent.remove();
    }
    if (target && pages.length) target.dataset.pages = pages.join(',');
  }
}

/* 元素上的 data-pages → 页号数组。写成 function 声明是为了能被 node 直接抽出来测
   （tests/frontend_test.js），箭头函数抽不出来。 */
function parsePages(el) {
  return (el.dataset.pages || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/* 悬停气泡的文案。取首尾而不是原样拼接 —— 锚点写成 "5,6,7" 时
   应该显示「第 5–7 页」而不是「第 5,6,7 页」。用 min/max 顺带兜住
   万一写成乱序（如 "6,5"）时出现「第 6–5 页」这种读不通的文案。 */
function anchorTooltip(pages) {
  if (!pages.length) return '';
  const first = Math.min(...pages);
  const last = Math.max(...pages);
  return first === last
    ? `点击跳转到第 ${first} 页`
    : `点击跳转到第 ${first}–${last} 页`;
}

/* 给所有可点元素挂原生 title 气泡（用原生 title：零依赖 + 可访问性天然满足，
   不自己画 tooltip）。表格 / 代码块本身就是 [data-pages] 元素，一起覆盖。 */
function annotateAnchors(root) {
  for (const el of root.querySelectorAll('[data-pages]')) {
    const tip = anchorTooltip(parsePages(el));
    if (tip) el.title = tip;
  }
}

/* 三级回退规则：返回 {orig, rule}
 *   1. 第一个页号之后（含）最近的保留页
 *   2. 没有 → 之前最近的保留页
 *   3. 都没有 → orig = null，不滚动，只高亮 */
function resolveAnchor(pages) {
  const pm = state.data.page_map;
  const total = pm.total_original;
  const first = pages[0];
  const isKept = (p) => pm.orig_to_simp[String(p)] != null;

  for (let p = first; p <= total; p++) if (isKept(p)) return { orig: p, rule: 1 };
  for (let p = first - 1; p >= 1; p--) if (isKept(p)) return { orig: p, rule: 2 };
  return { orig: null, rule: 3 };
}

/* resolveAnchor 的反向（ADR-015）：**原始页号 → MD 里第一个标注了它的元素**。
 * 那边是「总结的锚点找落页」，这边是「PDF 的页找总结段」，两者共用同一套页号口径
 * （都是原始 PDF 页码），所以 PDF 与总结能互指。
 * 写成 function 声明、只依赖 root.querySelectorAll，是为了能被 node 直接抽出来测
 * （tests/frontend_test.js）——与 parsePages / resolveAnchor 同样的处理方式。 */
function findAnchorForPage(root, origPage) {
  for (const el of root.querySelectorAll('[data-pages]')) {
    if (parsePages(el).includes(origPage)) return el;
  }
  return null;
}

/* 原始页号 → 当前版本里的页序号（简化版可能没有这一页） */
function pageIndexForVersion(orig) {
  const pm = state.data.page_map;
  if (state.version === 'full') return orig;
  const simp = pm.orig_to_simp[String(orig)];
  return simp == null ? null : simp;
}

/* 当前版本里的页序号 → 原始页号 */
function origForIndex(index) {
  const pm = state.data.page_map;
  if (state.version === 'full') return index;
  const orig = pm.simp_to_orig[String(index)];
  return orig == null ? null : orig;
}

/* ------------------------------------------------------------------ *
 * 「此处略过原 PX–PY」提示条（ADR-013 信任要求）
 * ------------------------------------------------------------------ */

/* 页号连续的相邻段合并成一条提示；reason 不同则算「混合」 */
function groupRanges(ranges) {
  const sorted = [...(ranges || [])].sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
      last.reasons.add(r.reason);
    } else {
      out.push({ from: r.from, to: r.to, reasons: new Set([r.reason]) });
    }
  }
  return out;
}

function bannerText(g) {
  const label = g.from === g.to ? `原 P${g.from}` : `原 P${g.from}–P${g.to}`;
  if (g.reasons.size === 1) {
    if (g.reasons.has('dup')) return `此处略过${label}（与前后页重复）`;
    if (g.reasons.has('manual')) return `此处略过${label}（与主题无关）`;
  }
  return `此处略过${label}`;
}

/* 提示条插在「下一个锚点之前」：按阅读顺序，用户读到这一节时就该知道中间跳过了哪些页 */
function buildBanners() {
  const article = $('#md');
  const groups = groupRanges(state.data.page_map.dropped_ranges);
  if (!groups.length) return;

  const anchored = [...article.querySelectorAll('[data-pages]')];
  let gi = 0;

  for (const el of anchored) {
    const minPage = Math.min(...parsePages(el));
    while (gi < groups.length && groups[gi].from < minPage) {
      insertBanner(groups[gi], sectionHeadBefore(article, el));
      gi++;
    }
  }
  while (gi < groups.length) {
    insertBanner(groups[gi], null);
    gi++;
  }
}

/* 找该锚点所属小节的标题，提示条插在标题之前 */
function sectionHeadBefore(article, el) {
  let node = el;
  while (node && node.parentElement !== article) node = node.parentElement;
  let prev = node;
  while (prev) {
    if (/^H[1-6]$/.test(prev.tagName)) return prev;
    prev = prev.previousElementSibling;
  }
  return node || el;
}

function insertBanner(group, beforeEl) {
  const bar = document.createElement('div');
  bar.className = 'skipped-banner';

  const text = document.createElement('span');
  text.textContent = bannerText(group);
  bar.appendChild(text);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '切到完整版查看';
  btn.addEventListener('click', () => switchVersion('full', { gotoOrig: group.from }));
  bar.appendChild(btn);

  const article = $('#md');
  if (beforeEl && beforeEl.parentElement === article) article.insertBefore(bar, beforeEl);
  else article.appendChild(bar);
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染
 * ------------------------------------------------------------------ */

function renderMarkdown() {
  const article = $('#md');
  article.innerHTML = window.marked.parse(state.data.summary_md || '', { gfm: true });

  attachAnchors(article);
  annotateAnchors(article);       // 挂「点击跳转到第 N 页」气泡

  // 顺序：先 hljs（只认 <pre><code>），再 KaTeX（会插入自己的 DOM）
  article.querySelectorAll('pre code').forEach((block) => {
    try { window.hljs.highlightElement(block); } catch (e) { console.warn('高亮失败', e); }
  });

  if (window.renderMathInElement) {
    window.renderMathInElement(article, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    });
  }
}

/* ------------------------------------------------------------------ *
 * PDF：加载 / 布局 / 虚拟化渲染
 * ------------------------------------------------------------------ */

/* 根绝对路径：页面在 /doc/<id> 时，相对路径会变成 /doc/vendor/... 被 SPA 路由吞掉 */
const workerUrl = '/vendor/pdfjs/pdf.worker.min.mjs';

let statusRetry = null;

function setStatus(msg, retry = null) {
  const el = $('#pdf-status');
  el.textContent = msg || '';
  el.hidden = !msg;
  statusRetry = retry;
  el.classList.toggle('retryable', Boolean(retry));
}

async function measurePages() {
  const n = state.pdf.numPages;
  const sizes = new Array(n);
  let next = 0;
  const CONCURRENCY = 8;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      const page = await state.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });   // MediaBox，未缩放
      sizes[i] = { w: vp.width, h: vp.height };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));
  return sizes;
}

/* 丢弃全部已渲染页：先取消在途任务再放手，避免切版本 / 改窗口大小时
   旧任务还在往已脱离文档的 canvas 上画（白烧内存） */
function clearRendered() {
  for (const rec of state.rendered.values()) {
    if (rec.task) { try { rec.task.cancel(); } catch (e) { /* 已完成 */ } }
    if (rec.textLayer) { try { rec.textLayer.cancel(); } catch (e) { /* 已取消 */ } }
    if (rec.canvas) { rec.canvas.width = 0; rec.canvas.height = 0; }
    if (rec.page) { try { rec.page.cleanup(); } catch (e) { /* 忽略 */ } }
  }
  state.rendered.clear();
}

async function loadPdf(url) {
  clearRendered();                       // 必须在 destroy 之前
  if (state.pdf) {
    try { await state.pdf.destroy(); } catch (e) { /* 已销毁 */ }
    state.pdf = null;
  }
  state.sizes = [];

  setStatus('加载 PDF…');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  state.pdf = await withTimeout(
    pdfjsLib.getDocument({
      url,
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      wasmUrl: `${VENDOR}wasm/`,
    }).promise,
    PDF_TIMEOUT_MS,
    'PDF 加载',
  );

  state.sizes = await measurePages();
  setStatus('');
}

function layoutPages() {
  const host = $('#pdf-pages');
  if (state.observer) { state.observer.disconnect(); state.observer = null; }
  clearRendered();
  host.textContent = '';
  state.pages = [];

  const avail = Math.max(200, $('#pdf-scroll').clientWidth - 24);
  /* 「适配容器宽度」这一步照旧受 MAX_SCALE 约束；用户缩放是**在它之上再乘**的，
     所以宽屏上把 160% 悄悄吃掉是不对的 —— 单独给最终值一个上限（MAX_SCALE ×
     最大倍率），只防失控，不压缩用户意图。 */
  const fit = Math.min(MAX_SCALE, avail / state.sizes[0].w);
  const scale = Math.min(fit * state.pdfZoom, MAX_SCALE * MAX_ZOOM);
  state.scale = scale;

  const frag = document.createDocumentFragment();
  state.sizes.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'cd-page';
    el.dataset.page = String(i + 1);
    el.style.width = `${Math.round(s.w * scale)}px`;
    el.style.height = `${Math.round(s.h * scale)}px`;
    el.style.setProperty('--scale-factor', String(scale));
    el.appendChild(placeholderFor(i + 1));
    attachPageHit(el, i + 1);       // ADR-015：这一页可点 → 跳总结
    frag.appendChild(el);
    state.pages.push(el);
  });
  host.appendChild(frag);
}

function placeholderFor(n) {
  const ph = document.createElement('div');
  ph.className = 'page-placeholder';
  ph.textContent = `第 ${n} 页`;
  return ph;
}

function observePages() {
  const root = $('#pdf-scroll');
  const avgH = state.sizes.reduce((a, s) => a + s.h, 0) / state.sizes.length;
  const margin = Math.round(avgH * state.scale * PRELOAD_PAGES);

  state.observer = new IntersectionObserver(onIntersect, {
    root,
    rootMargin: `${margin}px 0px ${margin}px 0px`,
    threshold: 0,
  });
  state.pages.forEach((el) => state.observer.observe(el));
}

function onIntersect(entries) {
  for (const e of entries) {
    const n = Number(e.target.dataset.page);
    if (e.isIntersecting) renderPage(n, e.target);
    else evictPage(n, e.target);
  }
}

async function renderPage(n, el) {
  if (state.rendered.has(n)) return;
  const rec = { page: null, canvas: null, task: null, layer: null, textLayer: null };
  state.rendered.set(n, rec);
  const current = () => state.rendered.get(n) === rec;

  try {
    const page = await state.pdf.getPage(n);
    if (!current()) return;
    rec.page = page;

    const viewport = page.getViewport({ scale: state.scale });
    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    rec.canvas = canvas;

    const ph = el.querySelector('.page-placeholder');
    if (ph) ph.remove();
    el.appendChild(canvas);

    rec.task = page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    await rec.task.promise;
    if (!current()) return;

    // 铺文本层：文字可选中（ADR-005）
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    el.appendChild(layer);
    rec.layer = layer;

    rec.textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: layer,
      viewport,
    });
    await rec.textLayer.render();
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error(`第 ${n} 页渲染失败`, err);
    // 失败页不留在表里，否则这一页永远不会再尝试渲染
    if (current()) {
      state.rendered.delete(n);
      if (!el.querySelector('.page-placeholder')) el.appendChild(placeholderFor(n));
    }
  }
}

function evictPage(n, el) {
  const rec = state.rendered.get(n);
  if (!rec) return;
  state.rendered.delete(n);

  if (rec.task) { try { rec.task.cancel(); } catch (e) { /* 已完成 */ } }
  if (rec.textLayer) { try { rec.textLayer.cancel(); } catch (e) { /* 已取消 */ } }
  if (rec.canvas) {
    rec.canvas.width = 0;      // 先缩到 0 再移除，尽快让浏览器回收位图
    rec.canvas.height = 0;
    rec.canvas.remove();
  }
  if (rec.layer) rec.layer.remove();
  if (rec.page) { try { rec.page.cleanup(); } catch (e) { /* 忽略 */ } }

  if (!el.querySelector('.page-placeholder')) el.appendChild(placeholderFor(n));
}

/* ------------------------------------------------------------------ *
 * 滚动与联动
 * ------------------------------------------------------------------ */

function scrollToPage(n, { flash = false } = {}) {
  const el = state.pages[n - 1];
  if (!el) return;
  const scroller = $('#pdf-scroll');
  const top = el.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
  // 瞬时跳转：平滑滚动会一路触发中间页的渲染，跃迁几百页时等于白烧内存
  scroller.scrollTop = Math.max(0, top);

  if (flash) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  }
}

function currentVisiblePage() {
  const scroller = $('#pdf-scroll');
  const top = scroller.getBoundingClientRect().top;
  for (let i = 0; i < state.pages.length; i++) {
    if (state.pages[i].getBoundingClientRect().bottom > top + 4) return i + 1;
  }
  return state.pages.length || 1;
}

/* 重排 PDF 并**保住当前页**。所有会改变「页面显示尺寸」的动作都走这条：
   窗口 resize、拖分栏结束、改 PDF 缩放。
   不做的话，用户会看到自己正读的那一页被甩走 —— 这是最容易被当成「坏了」的体验。 */
function relayoutPdfKeepingPosition() {
  if (!state.pdf) return;
  const visible = currentVisiblePage();
  layoutPages();
  observePages();
  scrollToPage(visible);
}

function highlightMd(el) {
  $('#md').querySelectorAll('.md-active').forEach((x) => x.classList.remove('md-active'));
  el.classList.add('md-active');
  setTimeout(() => el.classList.remove('md-active'), 1600);
}

function onMdClick(ev) {
  const el = ev.target.closest('[data-pages]');
  if (!el) return;
  const pages = parsePages(el);
  if (!pages.length) return;

  const { orig } = resolveAnchor(pages);
  highlightMd(el);

  if (orig == null) {
    console.warn(`锚点 ${pages.join(',')} 在简化版里没有可落点（三级回退都用尽），只高亮不滚动`);
    return;
  }
  const idx = pageIndexForVersion(orig);
  if (idx == null) return;
  scrollToPage(idx, { flash: true });
}

/* ------------------------------------------------------------------ *
 * PDF → MD 反向跳转（ADR-015：联动从单向升为双向）
 * ------------------------------------------------------------------ */

/* 借 PDF 的状态条做 MD 侧反馈（不另起一条，避免本版扩面）。
 * 1.5 秒后自动消失；PDF 正在报错（状态条带「点这里重试」）时让位 ——
 * 那条比「已跳到第 N 页」重要得多，不能被 1.5 秒的提示顶掉。 */
function setMdStatus(text) {
  const el = $('#pdf-status');
  if (!el || statusRetry) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(setMdStatus._t);
  setMdStatus._t = setTimeout(() => {
    // 这 1.5 秒里被更重要的 PDF 状态顶掉过？那内容已经不是我们的了，别去清它
    if (el.textContent !== text) return;
    el.textContent = '';
    el.hidden = true;
  }, 1500);
}

/* 点 PDF 的某一原始页 → 滚 MD 到标注此页的第一段 + 高亮（复用 MD → PDF 那套视觉反馈）。
 * 找不到就轻提示，**不报错、不弹窗**（设计冻结：查不到段是正常情况，
 * 简化版里很多页本来就没被总结引用）。返回是否命中，便于测试与调用方判断。 */
function jumpToMarkdown(origPage) {
  const el = findAnchorForPage($('#md'), origPage);
  if (!el) {
    setMdStatus(`第 ${origPage} 页未在总结中出现`);
    return false;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  highlightMd(el);
  setMdStatus(`已跳到第 ${origPage} 页对应总结`);
  return true;
}

/* 给一页装上反向跳转。index 是**当前版本里的页序号**（1 起，与 dataset.page 同源）：
 *   完整版 → 页序号就是原始页号；简化版 → 经 page_map.simp_to_orig 反查（复用 origForIndex）。
 * 命中层是必须的：它盖在 canvas 之上才能同时拿到 cursor:pointer 与 hover 反馈，
 * 也能让没渲染出 canvas 的占位页照样可点。 */
function attachPageHit(el, index) {
  const orig = origForIndex(index);
  /* aria-label 用**原始页号**（与总结锚点、状态条同一套编号）：
     完整版下两者相等；简化版下页序 2 可能对应原 P7，用户要跳的正是「原 P7 的总结」。 */
  const label = orig == null ? index : orig;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `点击跳到第 ${label} 页对应总结`);

  const hit = document.createElement('div');
  hit.className = 'cd-page-hit';
  hit.addEventListener('click', () => {
    const page = origForIndex(index);
    if (page == null) return;          // 该页没有对应的原始页号（映射缺失），静默不动
    jumpToMarkdown(page);
  });
  el.appendChild(hit);

  // 键盘可达：Tab 聚焦到页容器后 Enter / Space 与点击同效
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();               // Space 默认会滚动页面，拦掉
    hit.click();
  });
}

/* ------------------------------------------------------------------ *
 * 版本切换
 * ------------------------------------------------------------------ */

async function switchVersion(version, opts = {}) {
  const data = state.data;
  if (!opts.initial && version === state.version && state.pdf) return;
  if (version === 'simplified' && !data.pdf_simplified) return;

  const prevVisible = opts.initial ? null : currentVisiblePage();
  const prevOrig = opts.gotoOrig != null
    ? opts.gotoOrig
    : (prevVisible != null ? origForIndex(prevVisible) : null);

  state.version = version;
  updateVersionButtons();

  const url = version === 'full' ? data.pdf_full : data.pdf_simplified;
  try {
    await loadPdf(url);
  } catch (err) {
    console.error('PDF 加载失败', err);
    // 只把错误放到 PDF 那一栏，右侧已渲染的总结保留（不白屏）
    setStatus(`PDF 加载失败：${err.message}（点这里重试）`, () => switchVersion(version, opts));
    return;
  }
  layoutPages();
  observePages();

  let target = null;
  if (prevOrig != null) {
    target = pageIndexForVersion(prevOrig);
    if (target == null) {
      // 该原始页在简化版里被删了 → 按同一个三级回退找落点
      const { orig } = resolveAnchor([prevOrig]);
      target = orig == null ? 1 : pageIndexForVersion(orig);
    }
  }
  scrollToPage(target || 1);
  if (!target) renderPage(1, state.pages[0]);   // 首屏立刻可见
}

function updateVersionButtons() {
  document.querySelectorAll('#version-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.version === state.version);
  });
  const simplified = state.data.page_map.total_simplified;
  const original = state.data.page_map.total_original;
  $('#doc-sub').textContent = state.version === 'simplified'
    ? `${original} 页 → 简化版 ${simplified} 页`
    : `${original} 页 · 完整版`;
}

/* ------------------------------------------------------------------ *
 * 导出：MD 已在本地磁盘，页面只提供「下载」
 * （「复制 MD」按钮 2026-09-19 裁掉 —— 下载已覆盖保存需求，复制源码无额外价值）
 * PDF 同理：简化版 PDF 由服务端生成好了，这里只负责触发下载（v0.1.1）
 * ------------------------------------------------------------------ */

/* 下载文件名。纯函数，单独拎出来是为了能被 node 直接测（tests/frontend_test.js）——
   文件名拼错是那种「点了没反应/存下来叫 xxxxx.pdf」的低级但难自查的 bug。 */
function mdDownloadName(docId) {
  return `${docId || 'summary'}.md`;
}

function pdfDownloadName(docId) {
  return `${docId || 'summary'}-simplified.pdf`;
}

function downloadMd() {
  const md = state.data.summary_md || '';
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = mdDownloadName(state.data.meta.id);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* 下载简化版 PDF：URL 由服务端在 /api/doc/<id> 里拼好（pdf_simplified），
   前端**不构造路径** —— 路径一旦在这里手写，serve 改路由就会悄悄失联。
   走 `<a download>`：本项目服务只绑 127.0.0.1，页面与 PDF 天然同源。 */
function downloadPdf() {
  const url = state.data.pdf_simplified;
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = pdfDownloadName(state.data.meta.id);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ------------------------------------------------------------------ *
 * 分栏拖拽（**不设限位**，纯流式拖）
 * ------------------------------------------------------------------ */

/* 手柄轨道宽度，与 style.css 的 grid-template-columns 中间那一列保持一致 */
const SPLIT_HANDLE_PX = 6;

/* 鼠标 x → 左栏占比字符串。纯函数（node 里可测）。
   不设最小宽度（用户控制权 > 防误操作），只把值夹进 0%~100% ——
   越界的百分比会算出负的列宽或溢出容器。 */
function splitPercent(clientX, layoutLeft, layoutWidth, handlePx) {
  const usable = layoutWidth - handlePx;
  if (usable <= 0) return '100%';
  const left = clientX - layoutLeft - handlePx / 2;
  const pct = (left / usable) * 100;
  return `${Math.min(100, Math.max(0, pct)).toFixed(2)}%`;
}

/* 持久化键：per-docId（v0.1.1 不做全局开关） */
function splitKey(docId) {
  return `course-digest:${docId}:split`;
}

function applySplit(value) {
  document.documentElement.style.setProperty('--split-left', value);
}

function currentSplit() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--split-left').trim();
}

function initSplitDrag() {
  const handle = $('#split-handle');
  const layout = $('#layout');
  if (!handle || !layout) return;

  const key = splitKey(state.data.meta.id || '');
  const stored = localStorage.getItem(key);
  if (stored) applySplit(stored);      // 刷新后保持比例

  let dragging = false;
  let raf = 0;
  let lastX = null;

  /* 写 CSS 变量本身很便宜，但 pointermove 频率可达几百 Hz —— 节流到帧 */
  const flush = () => {
    raf = 0;
    if (lastX == null) return;
    const rect = layout.getBoundingClientRect();
    applySplit(splitPercent(lastX, rect.left, rect.width, SPLIT_HANDLE_PX));
  };

  const onMove = (ev) => {
    if (!dragging) return;
    lastX = ev.clientX;
    if (!raf) raf = requestAnimationFrame(flush);
  };

  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    if (raf) cancelAnimationFrame(raf);
    flush();
    if (ev && handle.hasPointerCapture && handle.hasPointerCapture(ev.pointerId)) {
      handle.releasePointerCapture(ev.pointerId);
    }
    const value = currentSplit();
    if (value) localStorage.setItem(key, value);

    /* 分栏宽度变了，PDF 的「适配容器宽度」比例也得跟着重算 —— 否则会留着旧宽度：
       变窄时出横向滚动条，变宽时两侧一大片留白。与窗口 resize 走同一条路。 */
    relayoutPdfKeepingPosition();
    lastX = null;
  };

  handle.addEventListener('pointerdown', (ev) => {
    dragging = true;
    handle.classList.add('dragging');
    try {
      handle.setPointerCapture(ev.pointerId);
    } catch (err) {
      /* 个别浏览器不支持 pointer capture：退化成普通 pointermove，仍可用 */
    }
    ev.preventDefault();       // 别让拖拽变成选中文本
  });
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

/* ------------------------------------------------------------------ *
 * 字号调整（按**内容载体**分两路）
 *   MD  → CSS 变量 --md-font-size，浏览器自动重排，零重渲成本
 *   PDF → PDF.js 的 scale（canvas 渲染，CSS 改不动），要重渲可见页
 * 两者语义不同，所以是两套独立控件 + 两套独立 localStorage 键，
 * 「MD 调到 24 而 PDF 跟着变」这种事不该发生。
 * ------------------------------------------------------------------ */

const MD_FONT = { min: 12, max: 24, step: 1, default: 16 };
const PDF_FONT = { levels: [0.8, 1.0, 1.2, 1.4, 1.6], default: 1.0 };

/* 从 localStorage 读回来的字符串 → 合法的数值。脏数据一律退回默认值，
   越界值夹进范围 —— 存的是用户自己改过的 localStorage，不能信。 */
function clampNumber(raw, fallback, min, max) {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/* MD：连续加减，夹在 [min, max] */
function stepMdFont(value, dir) {
  const next = value + dir * MD_FONT.step;
  return Math.min(MD_FONT.max, Math.max(MD_FONT.min, next));
}

/* PDF：5 个固定档（80% / 100% / 120% / 140% / 160%），取相邻档。
   值不在档上（比如 localStorage 里是旧版留下的 1.3）就从默认档开始数。 */
function stepPdfFont(value, dir) {
  const found = PDF_FONT.levels.indexOf(value);
  const at = found < 0 ? PDF_FONT.levels.indexOf(PDF_FONT.default) : found;
  const next = Math.min(PDF_FONT.levels.length - 1, Math.max(0, at + dir));
  return PDF_FONT.levels[next];
}

function pdfFontLabel(value) {
  return `${Math.round(value * 100)}%`;
}

function fontKey(target, docId) {
  return `course-digest:${docId}:font-${target}`;
}

function applyMdFont(value) {
  document.documentElement.style.setProperty('--md-font-size', `${value}px`);
}

/* PDF 缩放：改 scale 之后必须重排重渲，且**保住当前页**。
   节流到一帧 —— 连着点几下 +，不该触发几轮完整的重排。 */
let pdfZoomPending = false;

function applyPdfFont(value) {
  if (value !== state.pdfZoom) state.pdfZoom = value;
  if (!state.pdf || pdfZoomPending) return;
  pdfZoomPending = true;
  requestAnimationFrame(() => {
    pdfZoomPending = false;
    relayoutPdfKeepingPosition();
  });
}

function initFontControls() {
  const box = $('#font-controls');
  if (!box) return;

  const docId = state.data.meta.id || '';
  const lastLevel = PDF_FONT.levels[PDF_FONT.levels.length - 1];
  const fonts = {
    md: {
      key: fontKey('md', docId),
      value: clampNumber(localStorage.getItem(fontKey('md', docId)),
        MD_FONT.default, MD_FONT.min, MD_FONT.max),
    },
    pdf: {
      key: fontKey('pdf', docId),
      value: clampNumber(localStorage.getItem(fontKey('pdf', docId)),
        PDF_FONT.default, PDF_FONT.levels[0], lastLevel),
    },
  };

  for (const group of box.querySelectorAll('.font-group')) {
    const target = group.dataset.target;          // 'md' | 'pdf'
    const now = group.querySelector('.font-now');
    const isMd = target === 'md';

    const apply = (value) => {
      fonts[target].value = value;
      if (isMd) applyMdFont(value);
      else applyPdfFont(value);
      now.textContent = isMd ? String(value) : pdfFontLabel(value);
    };

    const step = (dir) => {
      const current = fonts[target].value;
      const next = isMd ? stepMdFont(current, dir) : stepPdfFont(current, dir);
      if (next === current) return;               // 到头了就不写盘、不重排
      apply(next);
      localStorage.setItem(fonts[target].key, String(next));
    };

    group.querySelector('.font-dec').addEventListener('click', () => step(-1));
    group.querySelector('.font-inc').addEventListener('click', () => step(+1));
    /* 点数字 = 重置（并清掉存的值，回到「未设置」状态） */
    now.addEventListener('click', () => {
      apply(isMd ? MD_FONT.default : PDF_FONT.default);
      localStorage.removeItem(fonts[target].key);
    });

    apply(fonts[target].value);                   // 首次应用（含读回的值）
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function wireInteractions() {
  $('#md').addEventListener('click', onMdClick);
  $('#btn-download').addEventListener('click', downloadMd);
  $('#btn-pdf').addEventListener('click', downloadPdf);
  $('#pdf-status').addEventListener('click', () => {
    if (statusRetry) statusRetry();
  });
  document.querySelectorAll('#version-switch button').forEach((b) => {
    b.addEventListener('click', () => switchVersion(b.dataset.version));
  });

  let timer = null;
  window.addEventListener('resize', () => {
    if (!state.pdf) return;
    clearTimeout(timer);
    timer = setTimeout(relayoutPdfKeepingPosition, 200);
  });
}

function showError(err) {
  console.error(err);
  const article = $('#md');
  article.innerHTML = '';
  const p = document.createElement('p');
  p.style.color = '#c00';
  p.textContent = `加载失败：${err.message}`;
  article.appendChild(p);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重试';
  btn.style.marginTop = '12px';
  btn.addEventListener('click', () => location.reload());
  article.appendChild(btn);

  setStatus('加载失败');
  $('#doc-title').textContent = 'course-digest';
}

async function main() {
  try {
    state.data = await fetchDocData();
    $('#doc-title').textContent = state.data.meta.title || state.data.meta.id || 'course-digest';
    document.title = `${state.data.meta.title || 'course-digest'} · course-digest`;

    renderMarkdown();
    buildBanners();
    wireInteractions();
    initSplitDrag();               // 先把存下来的分栏比例应用上，再布局 PDF（避免闪一下）
    initFontControls();            // 字号同理：PDF 倍率先就位，再让 switchVersion 去布局
    await switchVersion('simplified', { initial: true });
    console.info('course-digest: 已就绪', {
      mode: new URLSearchParams(location.search).has('mock') ? 'mock' : 'api',
      pages: state.data.page_map.total_original,
      simplified: state.data.page_map.total_simplified,
    });
  } catch (err) {
    showError(err);
  }
}

main();

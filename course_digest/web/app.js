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
 *
 * 右栏两态（v0.1.3）：「查看」渲染总结，「编辑」是 textarea + 实时预览 + 工具栏。
 * 两态是两个兄弟节点（#md-scroll / #md-editor），只切 hidden —— 不重建 #md，
 * 因为 #md 上挂着 MD → PDF 的点击监听，重建它会静默失联。
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

  /* ---- MD 编辑器（v0.1.3）---- */
  mode: 'view',          // 'view' | 'edit'
  hasUnsaved: false,     // 编辑框内容与「最后一次保存成功」的正文不同
  editorDraft: null,     // 切走时留下的草稿文本（null = 没有草稿）
  mdStale: false,        // 查看区 DOM 落后于 state.data.summary_md（保存过就要重画）
  viewScroll: 0,         // 进编辑模式前查看区的滚动位置，切回来还回原位
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

/* Markdown → DOM 的**唯一**渲染链：marked → 锚点 → 悬停气泡 → 代码高亮 → 公式。
 * 查看区（#md）与编辑器的预览区（#md-preview）共用这一条 —— 两边必须渲染得一模一样，
 * 渲染链一旦分叉，「预览」当场就是在骗人（编辑时看到的东西和保存后看到的不是一回事）。
 * 写成收 container 参数的函数，正是为了让两条路径不可能各写一套。 */
function renderRichMarkdown(container, md) {
  container.innerHTML = window.marked.parse(md || '', { gfm: true });

  attachAnchors(container);
  annotateAnchors(container);       // 挂「点击跳转到第 N 页」气泡

  // 顺序：先 hljs（只认 <pre><code>），再 KaTeX（会插入自己的 DOM）
  container.querySelectorAll('pre code').forEach((block) => {
    try { window.hljs.highlightElement(block); } catch (e) { console.warn('高亮失败', e); }
  });

  if (window.renderMathInElement) {
    window.renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    });
  }
}

function renderMarkdown() {
  renderRichMarkdown($('#md'), state.data.summary_md || '');
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

/* 高亮跳转目标（1.6 秒后退场）。查看区与预览区都清一遍 ——
   两边的锚点都能点，高亮不互清的话会同时亮着两处，看不出刚跳的是哪一段。 */
function highlightMd(el) {
  document.querySelectorAll('#md .md-active, #md-preview .md-active')
    .forEach((x) => x.classList.remove('md-active'));
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
 * MD 编辑器（v0.1.3）
 *   查看 / 编辑两态共用右栏：#md-scroll（查看）与 #md-editor（编辑）是**兄弟节点**，
 *   切模式只切 hidden —— 不重建 #md（它身上挂着 onMdClick，重建就静默失联）。
 *   保存走 POST /api/doc/<id>/summary：校验链与 footer 都归服务端，前端不自己拼票。
 * ------------------------------------------------------------------ */

/* 超长草稿提醒的阈值（设计 §4：100KB 内流畅）。只提醒、不阻止。 */
const MAX_DRAFT_CHARS = 100000;

/* 预览重渲的防抖窗口。预览与查看走**同一条**渲染链（marked → 锚点 → 高亮 → 公式），
 * 而高亮与公式在长文档上不便宜 —— 每个按键都跑一遍会把手感拖垮。
 * 等手停下来再渲，人几乎感觉不到，CPU 省一截。 */
const PREVIEW_DEBOUNCE_MS = 150;

/* HTML 转义。错误条要显示服务端回来的文案（里面含用户自己正文的预览片段），
   拼 innerHTML 前必须转义，否则正文里的 < 、> 会当场变成标签。 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* 前端版 strip_footer：找**最后一个**回程票注释，从它的起点截断，尾部空白规范化。
 * 匹配规则与 course_digest/footer.py 的 _FOOTER_ANCHOR_RE 同形（`course-digest:` 后面
 * 必须跟 `docId=`），而不是只找 `<!-- course-digest:` 前缀 —— 松匹配会把正文里同前缀的
 * 普通注释也当票剥掉。返回值口径同样对齐 footer.py：正文为空就返回空串。
 * 写成 function 声明、不引用模块级常量，是为了能被 node 直接抽出来测。 */
function stripFooterInJs(text) {
  const src = typeof text === 'string' ? text : '';
  const re = /<!--\s*course-digest:\s*docId=[^\s\n]+[^>]*-->/g;
  let last = null;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) last = m;
  const body = (last ? src.slice(0, last.index) : src).replace(/\s+$/, '');
  return body ? body + '\n' : '';
}

/* 光标处插入：**替换**当前选区，光标落在插入内容之后。
 * 语义是「替换」而不是「插在选区之前」—— 工具栏送进来的是**完整片段**（如 `**X**`），
 * 若还把原选区拼在后面，会得到 `**X**X`（选中文字被复制一份）。 */
function insertAtCursorText(text, selectionStart, selectionEnd, surroundingText) {
  const value = typeof surroundingText === 'string' ? surroundingText : '';
  const rawStart = Number(selectionStart);
  const rawEnd = Number(selectionEnd);
  const start = Number.isFinite(rawStart) ? Math.min(Math.max(rawStart, 0), value.length) : 0;
  const end = Number.isFinite(rawEnd) ? Math.min(Math.max(rawEnd, start), value.length) : start;
  const newText = value.slice(0, start) + text + value.slice(end);
  const cursor = start + text.length;
  return { newText, newCursorStart: cursor, newCursorEnd: cursor };
}

/* 工具栏按钮 → 要插入的 md 片段。ul / anchor 不在这里（它们不是「替换选区」语义，
   由 applyToolbarAction 单独处理）；未知动作返回空串，调用方据此跳过插入。 */
function toolbarInsert(act, selectedText) {
  const sel = selectedText || '';
  switch (act) {
    case 'bold': return '**' + (sel || '粗体') + '**';
    case 'italic': return '*' + (sel || '斜体') + '*';
    case 'link': return '[' + (sel || '文字') + '](https://)';
    /* 有选中就把它裹进围栏 —— 别让「插代码块」把用户选中的文字吃掉；没选中才放占位 */
    case 'code': return sel ? '\n```\n' + sel + '\n```\n' : '\n```\n代码\n```\n';
    default: return '';
  }
}

/* 无序列表：在**光标所在行**的行首插 `- `，光标随之后移 2。 */
function insertListMarker(text, cursor) {
  const value = typeof text === 'string' ? text : '';
  const raw = Number(cursor);
  const at = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), value.length) : 0;
  const lineStart = value.lastIndexOf('\n', at - 1) + 1;
  return {
    newText: value.slice(0, lineStart) + '- ' + value.slice(lineStart),
    newCursor: at + 2,
  };
}

/* 锚点输入（「5, 6,8」这种）→ 约定格式的注释行；页号全非法 / 越界 → 空串（调用方不插入）。
 * 越界在这里就拦：锚点页号 > 总页数，服务端一定 400，不如当场说清楚。 */
function anchorComment(rawPages, maxPage) {
  const pages = String(rawPages == null ? '' : rawPages)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!pages.length) return '';
  const ceiling = Number(maxPage);
  if (Number.isFinite(ceiling) && ceiling > 0 && pages.some((p) => p > ceiling)) return '';
  return '\n<!-- pages: ' + pages.join(',') + ' -->\n';
}

/* 状态条文案。lastResult = 「最后一次保存的结果」：
 *   'loading' / 'fail' / 'ok' / { coverage } / null（还没存过） */
function computeEditorStatus(hasUnsaved, lastResult) {
  if (lastResult === 'loading') return '保存中…';
  if (lastResult === 'fail') return '保存失败';
  if (lastResult === 'ok') return '已保存';
  if (lastResult && typeof lastResult === 'object' && Number.isFinite(lastResult.coverage)) {
    return '已保存（覆盖率 ' + Math.round(lastResult.coverage) + '%）';
  }
  return hasUnsaved ? '未保存' : '已加载';
}

/* 状态条右侧的行数 / 字符数。
 * 字符数按**码点**数（Array.from）而不是 str.length（UTF-16 码元）—— 后者会把一个
 * emoji 或增补平面汉字算成 2 个字符，而这是用户会拿去核对的数字。 */
function updateCounter(text) {
  const value = typeof text === 'string' ? text : '';
  return value.split('\n').length + ' 行 / ' + Array.from(value).length + ' 字符';
}

/* 超长草稿提醒（只提醒、不阻止）。阈值由调用方传 MAX_DRAFT_CHARS ——
 * 这样这条纯函数不依赖模块级常量，测试可以喂任意阈值。 */
function draftWarnings(md, maxChars) {
  const len = typeof md === 'string' ? md.length : 0;
  if (!(len > maxChars)) return [];
  return ['正文较长（' + len + ' 字符，超过 ' + maxChars + '），预览与保存会变慢'];
}

/* 服务端回报的未锚定段落 → 人读文案（行号 + 前 30 字符预览） */
function unanchoredWarnings(unanchored) {
  return (Array.isArray(unanchored) ? unanchored : [])
    .map((u) => '第 ' + ((u && u.line) || '?') + ' 行未加锚点：' + ((u && u.preview) || ''));
}

/* 进编辑模式时编辑框该放什么：
 *   有未保存草稿 → 用草稿（切模式不该吞掉用户没保存的编辑）
 *   没有 → 用最新已保存正文，并剥掉 footer（footer 归工具管，不该给用户改） */
function editorInitialText(summaryMd, draft, hasUnsaved) {
  if (hasUnsaved && typeof draft === 'string') return draft;
  return stripFooterInJs(summaryMd || '');
}

/* ---- 落 DOM 的那一层 ---- */

function showEditorErrors(errors) {
  const el = $('#md-errors');
  if (!el) return;
  const list = (errors || []).filter(Boolean);
  el.innerHTML = list.map((e) => '<div class="md-error">' + escapeHtml(e) + '</div>').join('');
  el.hidden = list.length === 0;
}

function showEditorWarnings(warnings) {
  const el = $('#md-warn');
  if (!el) return;
  const list = (warnings || []).filter(Boolean);
  el.innerHTML = list.map((w) => '<div class="md-warn-item">' + escapeHtml(w) + '</div>').join('');
  el.hidden = list.length === 0;
}

function refreshEditorStatus(lastResult) {
  const el = $('#md-status');
  if (el) el.textContent = computeEditorStatus(state.hasUnsaved, lastResult);
}

function refreshEditorCounter() {
  const ta = $('#md-textarea');
  const el = $('#md-counter');
  if (ta && el) el.textContent = updateCounter(ta.value);
}

/* 预览区：与查看区**同一个渲染函数**（renderRichMarkdown）——
 * 高亮、公式、锚点 ▸ 标记与悬停气泡全都到位，编辑时看到的就是保存后看到的。 */
function refreshEditorPreview() {
  const ta = $('#md-textarea');
  const preview = $('#md-preview');
  if (ta && preview) renderRichMarkdown(preview, ta.value);
}

let previewTimer = null;

/* 输入时先起个定时器：连着打字只会渲最后一次（见 PREVIEW_DEBOUNCE_MS 的说明）。 */
function scheduleEditorPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshEditorPreview, PREVIEW_DEBOUNCE_MS);
}

/* 回写编辑框并把选区放好，再派发 input —— 预览 / 计数 / 脏标记 / 状态条全挂在 input 上，
   于是工具栏与键盘走的是同一条更新路径，不会出现「某个入口忘了刷新」。 */
function writeTextarea(value, selStart, selEnd) {
  const ta = $('#md-textarea');
  if (!ta) return;
  ta.value = value;
  ta.selectionStart = selStart;
  ta.selectionEnd = selEnd;
  ta.dispatchEvent(new Event('input'));
}

function maxOriginalPage() {
  const map = state.data && state.data.page_map;
  const total = map && Number(map.total_original);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/* 工具栏动作 → 改编辑框 */
function applyToolbarAction(act) {
  const ta = $('#md-textarea');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;

  if (act === 'ul') {
    const r = insertListMarker(value, start);
    writeTextarea(r.newText, r.newCursor, r.newCursor);
    return;
  }

  if (act === 'anchor') {
    const raw = prompt('页号（逗号分隔）：', '');
    if (raw == null || raw.trim() === '') return;     // 取消 / 空输入：什么都不做
    const ceiling = maxOriginalPage();
    const comment = anchorComment(raw, ceiling);
    if (!comment) {
      showEditorErrors([
        '锚点页号无效：只接受 1–' + (ceiling || '?') + ' 之间的正整数，逗号分隔（例：5,6,8）',
      ]);
      return;
    }
    showEditorErrors([]);
    const r = insertAtCursorText(comment, start, end, value);
    writeTextarea(r.newText, r.newCursorStart, r.newCursorEnd);
    return;
  }

  const snippet = toolbarInsert(act, value.slice(start, end));
  if (!snippet) return;                               // 未知动作：一个字都不动
  const r = insertAtCursorText(snippet, start, end, value);
  writeTextarea(r.newText, r.newCursorStart, r.newCursorEnd);
}

/* 编辑框每次改动：标脏 + 刷预览 / 计数 / 状态条。
   预览走防抖（高亮 + 公式不便宜），计数与状态条是纯字符串拼接，照旧即时。
   顺手清掉上一次保存留下的错误条；警告条换成「当前草稿」的（超长提醒）。 */
function onEditorInput() {
  const ta = $('#md-textarea');
  if (!ta) return;
  state.hasUnsaved = true;
  state.editorDraft = ta.value;
  showEditorErrors([]);
  showEditorWarnings(draftWarnings(ta.value, MAX_DRAFT_CHARS));
  scheduleEditorPreview();
  refreshEditorCounter();
  refreshEditorStatus(null);
}

function renderMode() {
  if (state.mode === 'edit') renderEditor();
  else renderView();
}

/* 切到编辑模式：显示编辑器、把正文放进去。
   进编辑前记住查看区的滚动位置 —— 元素一旦 hidden，它的 scrollTop 就不可读了。 */
function renderEditor() {
  const scroller = $('#md-scroll');
  const editor = $('#md-editor');
  const ta = $('#md-textarea');
  if (!scroller || !editor || !ta) return;

  state.viewScroll = scroller.scrollTop;
  ta.value = editorInitialText(state.data.summary_md || '', state.editorDraft, state.hasUnsaved);
  state.editorDraft = ta.value;
  scroller.hidden = true;
  editor.hidden = false;

  showEditorErrors([]);
  showEditorWarnings(draftWarnings(ta.value, MAX_DRAFT_CHARS));
  refreshEditorPreview();
  refreshEditorCounter();
  refreshEditorStatus(null);
}

/* 切回查看模式：**只切显隐**，刻意不重建 #md（重建会丢掉它的点击监听）。
   只有保存过（mdStale）才重画一次，且重画放在解除隐藏之后 —— 隐藏期间设 scrollTop 是无效的。 */
function renderView() {
  const scroller = $('#md-scroll');
  const editor = $('#md-editor');
  if (editor) editor.hidden = true;
  if (!scroller) return;
  clearTimeout(previewTimer);          // 走了就别再为看不见的预览区白渲一次
  scroller.hidden = false;
  if (state.mdStale) {
    renderMarkdown();
    buildBanners();
    state.mdStale = false;
  }
  scroller.scrollTop = state.viewScroll;
}

function onModeSwitch(ev) {
  const btn = ev.target.closest('button[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode === state.mode) return;

  /* 草稿保护：编辑模式下有未保存的改动 → 先问一句 */
  if (state.mode === 'edit' && state.hasUnsaved
      && !confirm('有未保存的修改，确定离开编辑模式？')) return;

  state.mode = mode;
  document.querySelectorAll('#mode-switch button').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });
  renderMode();
}

/* 保存：POST /api/doc/<id>/summary。校验 / footer / 落盘全在服务端，
   前端**不自己拼 footer**（格式只由 footer.py 定义）—— 成功就回填服务端给的 summary_md。 */
async function saveEditorDraft() {
  const ta = $('#md-textarea');
  if (!ta) return;
  const md = ta.value;
  state.editorDraft = md;

  showEditorErrors([]);
  showEditorWarnings([]);
  refreshEditorStatus('loading');

  try {
    const resp = await fetch('/api/doc/' + encodeURIComponent(state.data.meta.id) + '/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary_md: md }),
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data || !data.ok) {
      const errors = (data && data.errors)
        || [(data && data.error) || ('保存失败：HTTP ' + resp.status)];
      showEditorErrors(errors);
      showEditorWarnings(unanchoredWarnings(data && data.unanchored));
      refreshEditorStatus('fail');
      return;
    }

    state.data.summary_md = data.summary_md;
    state.hasUnsaved = false;
    state.editorDraft = null;
    state.mdStale = true;                 // 查看区落后了，切回去时重画
    showEditorWarnings(unanchoredWarnings(data.unanchored));
    refreshEditorStatus({ coverage: data.coverage });
  } catch (err) {
    showEditorErrors(['保存失败：' + ((err && err.message) || err)]);
    refreshEditorStatus('fail');
  }
}

/* 取消：丢掉草稿回查看模式（改过就先问一次） */
function cancelEditorDraft() {
  if (state.hasUnsaved && !confirm('放弃未保存的修改？')) return;
  state.hasUnsaved = false;
  state.editorDraft = null;
  showEditorErrors([]);
  showEditorWarnings([]);
  const viewBtn = document.querySelector('#mode-switch button[data-mode="view"]');
  if (viewBtn) viewBtn.click();           // 复用同一条切换路径（含按钮高亮与显隐）
}

/* 编辑器接线。全部只接一次 —— 结构是静态 HTML，不存在「重建后监听丢失」的问题。 */
function initEditor() {
  const editor = $('#md-editor');
  if (!editor) return;

  editor.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    applyToolbarAction(btn.dataset.act);
  });

  $('#md-textarea').addEventListener('input', onEditorInput);
  $('#md-save').addEventListener('click', saveEditorDraft);
  $('#md-cancel').addEventListener('click', cancelEditorDraft);

  /* 预览区与查看区一样可点：点带锚点的段落 → 跳 PDF。
     这是「预览 = 所见即所得」的一部分 —— 同一个渲染链，也该是同一套交互。 */
  $('#md-preview').addEventListener('click', onMdClick);

  /* 模式分段的绑定风格与「简化版 / 完整版」一致（事件委托 + data-* 属性） */
  $('#mode-switch').addEventListener('click', onModeSwitch);

  /* 草稿保护：编辑模式下有未保存改动时关页面 / 刷新 → 浏览器原生确认框。
     本页只有一篇文档，没有「切文档」这条交互，所以不必额外拦路由。 */
  window.addEventListener('beforeunload', (ev) => {
    if (state.mode === 'edit' && state.hasUnsaved) {
      ev.preventDefault();
      ev.returnValue = '';
      return '';
    }
  });
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
    initEditor();                  // 编辑器接线（模式分段 + 工具栏 + 保存 + 草稿保护）
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

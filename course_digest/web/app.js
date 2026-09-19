/* course-digest 前端查看器。
 *
 * 两种数据来源（高 1 修复）：
 *   ?mock=1   → mock 模式，只读 ./fixture/mock.json，不发任何 /api 请求
 *   无该参数   → 生产模式，fetch('/api/doc/<docId>')（M4 提供）
 * 两者的返回体字段名完全一致，只有 pdf_full / pdf_simplified 的 URL 不同。
 *
 * PDF 渲染走 PDF.js 自有 canvas 列表 + 虚拟化（ADR-005）：
 *   - 每页容器的高度从 MediaBox 提前算出 → 首帧滚动条长度就是准的
 *   - IntersectionObserver 只渲染视口附近（前后各 2 页），滚远即丢 canvas
 *   - 不用内置 viewer.html（iframe 跨文档，联动做不了）
 */

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

/* 前后各预加载的页数 */
const PRELOAD_PAGES = 2;
/* 渲染比例上限，防止超宽屏上 canvas 过大 */
const MAX_SCALE = 2;
/* 网络请求超时：没这个，碰到死连接会永远停在「加载中…」 */
const FETCH_TIMEOUT_MS = 5000;
const PDF_TIMEOUT_MS = 15000;

const VENDOR = './vendor/pdfjs/';

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  version: 'simplified',
  pdf: null,
  sizes: [],        // [{w,h}]：scale=1 时的页面尺寸
  scale: 1,
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
    return fetchJson('./fixture/mock.json');
  }

  const id = docIdFromUrl(params);
  if (!id) throw new Error('缺少 docId：请用 ?doc=<docId> 或 /doc/<docId> 访问');
  return fetchJson(`/api/doc/${encodeURIComponent(id)}`);
}

/* ------------------------------------------------------------------ *
 * 页锚点（§三 约定：<!-- pages: 5,6 --> → data-pages，注释不显示）
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

const parsePages = (el) =>
  (el.dataset.pages || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);

/* 三级回退规则（§三）：返回 {orig, rule}
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

const workerUrl = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

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
  const scale = Math.min(MAX_SCALE, avail / state.sizes[0].w);
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
 * 导出（F5）：MD 已在本地磁盘，页面只提供「下载」
 * （「复制 MD」按钮 2026-09-19 裁掉 —— 下载已覆盖保存需求，复制源码无额外价值）
 * ------------------------------------------------------------------ */

function downloadMd() {
  const md = state.data.summary_md || '';
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.data.meta.id || 'summary'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function wireInteractions() {
  $('#md').addEventListener('click', onMdClick);
  $('#btn-download').addEventListener('click', downloadMd);
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
    timer = setTimeout(async () => {
      const visible = currentVisiblePage();
      layoutPages();
      observePages();
      scrollToPage(visible);
    }, 200);
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

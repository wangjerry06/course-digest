#!/usr/bin/env node
/* 前端纯逻辑冒烟测试（plain node，零依赖）。
 *
 * 为什么不做浏览器测试：本项目的老规矩是「**用真函数源码 + 合成数据在 node 里跑**」
 * （本项目的验证惯例）。真函数源码是从 app.js 里**读出来再 eval** 的，
 * 不是在这儿抄一份 —— 所以改了 app.js 而忘了这里的期望值，测试会立刻红。
 *
 * 覆盖不到的东西（留给手测）：CSS 视觉效果、pointer 拖拽手感、canvas 渲染。
 *
 * 运行：cd <repo root> && node tests/frontend_test.js
 */

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'course_digest', 'web', 'app.js');
const SRC = fs.readFileSync(APP, 'utf8');

let failed = 0;

function check(name, cond) {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

/* 从 app.js 源码里切出一个具名 function 声明的完整源码（按大括号配平找结尾）。 */
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js 里找不到 function ${name}()`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name}() 的大括号不闭合`);
}

/* 把真函数放进一个只含指定外部依赖的作用域里求值，返回该函数本身。 */
function load(name, deps = {}) {
  const keys = Object.keys(deps);
  const factory = new Function(...keys, `${extract(name)}\nreturn ${name};`);
  return factory(...keys.map((k) => deps[k]));
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ *
 * 语法自检：拼错括号、漏逗号这类错误在浏览器里的表现是「整页白屏 +
 * 只有 module 报错」，而且服务端日志全是 200（与「前端资产用相对路径」那类事故同一个形态）。这里先拦一道。
 * import 必须写在顶层，所以摘掉 import 行再整体编译。
 * ------------------------------------------------------------------ */

try {
  new Function(SRC.replace(/^\s*import .*$/gm, ''));
  check('app.js 语法可编译', true);
} catch (err) {
  check(`app.js 语法可编译（${err.message}）`, false);
}

/* ------------------------------------------------------------------ *
 * 下载文件名
 * ------------------------------------------------------------------ */

const mdName = load('mdDownloadName');
const pdfName = load('pdfDownloadName');

check('mdDownloadName: 正常 docId',
  mdName('2026-09-23-03-transport') === '2026-09-23-03-transport.md');
check('mdDownloadName: docId 缺失时兜底 summary', mdName(undefined) === 'summary.md');
check('mdDownloadName: 空串同样兜底', mdName('') === 'summary.md');
check('pdfDownloadName: 文件名 = <docId>-simplified.pdf',
  pdfName('2026-09-23-03-transport') === '2026-09-23-03-transport-simplified.pdf');
check('pdfDownloadName: docId 缺失时兜底 summary',
  pdfName('') === 'summary-simplified.pdf');
check('pdfDownloadName: 与 MD 名不撞车', pdfName('x') !== mdName('x'));

/* ------------------------------------------------------------------ *
 * 锚点三级回退 —— 现有逻辑，真数据只触发得到规则 1
 * ------------------------------------------------------------------ */

const MAP = {
  total_original: 6,
  // 保留：P1/P3/P6；删除：P2/P4/P5
  orig_to_simp: { '1': 1, '2': null, '3': 2, '4': null, '5': null, '6': 3 },
};
const resolveAnchor = load('resolveAnchor', { state: { data: { page_map: MAP } } });

check('规则1: 首个页号本身保留 → 落在自己',
  eq(resolveAnchor([1]), { orig: 1, rule: 1 }));
check('规则1: 首个页号被删 → 之后最近的保留页',
  eq(resolveAnchor([2]), { orig: 3, rule: 1 }));
check('规则1: 连删多页 → 跳过后面的保留页',
  eq(resolveAnchor([4]), { orig: 6, rule: 1 }));
check('规则1: 末页仍保留 → 落在自己', eq(resolveAnchor([6]), { orig: 6, rule: 1 }));

// 规则2：首个页号之后**全删** → 往前找
const tailGone = load('resolveAnchor', {
  state: {
    data: {
      page_map: {
        total_original: 6,
        orig_to_simp: { '1': 1, '2': null, '3': 2, '4': null, '5': null, '6': null },
      },
    },
  },
});
check('规则2: 之后全删 → 往前找最近的保留页',
  eq(tailGone([4]), { orig: 3, rule: 2 }));
check('规则2: 往前找同样跳着找',
  eq(tailGone([5]), { orig: 3, rule: 2 }));

// 规则3：整份都没有保留页
const empty = load('resolveAnchor', {
  state: { data: { page_map: { total_original: 3, orig_to_simp: {} } } },
});
check('规则3: 没有可落点 → orig=null（只高亮不滚动）',
  eq(empty([2]), { orig: null, rule: 3 }));

/* ------------------------------------------------------------------ *
 * 页号解析
 * ------------------------------------------------------------------ */

const parsePages = load('parsePages');
check('parsePages: 逗号分隔', eq(parsePages({ dataset: { pages: '5,6' } }), [5, 6]));
check('parsePages: 单页', eq(parsePages({ dataset: { pages: '3' } }), [3]));
check('parsePages: 没有 data-pages → 空数组', eq(parsePages({ dataset: {} }), []));
check('parsePages: 过滤 NaN / 0 / 负数',
  eq(parsePages({ dataset: { pages: '5,x,-1,0,7' } }), [5, 7]));

/* ------------------------------------------------------------------ *
 * 锚点提示：文案 + 挂载
 * ------------------------------------------------------------------ */

const anchorTooltip = load('anchorTooltip');
check('anchorTooltip: 单页', anchorTooltip([5]) === '点击跳转到第 5 页');
check('anchorTooltip: 多页取首尾', anchorTooltip([5, 6]) === '点击跳转到第 5–6 页');
check('anchorTooltip: 三页以上也只写首尾',
  anchorTooltip([5, 6, 7]) === '点击跳转到第 5–7 页');
check('anchorTooltip: 乱序不会写出「第 6–5 页」',
  anchorTooltip([6, 5]) === '点击跳转到第 5–6 页');
check('anchorTooltip: 空数组 → 空串（不写 title）', anchorTooltip([]) === '');

const annotateAnchors = load('annotateAnchors', { parsePages, anchorTooltip });
const els = [
  { dataset: { pages: '5,6' }, title: '' },
  { dataset: { pages: '3' }, title: '' },
  { dataset: {}, title: '' },
  { dataset: { pages: '0,x' }, title: '' },
];
annotateAnchors({ querySelectorAll: () => els });
check('annotateAnchors: 多页元素写上 title',
  els[0].title === '点击跳转到第 5–6 页');
check('annotateAnchors: 单页元素写上 title', els[1].title === '点击跳转到第 3 页');
check('annotateAnchors: 没有 data-pages → 不动 title', els[2].title === '');
check('annotateAnchors: 页号全非法 → 不动 title', els[3].title === '');

/* ------------------------------------------------------------------ *
 * CSS 静态检查：段首 ▸（视觉发现的主信号）+ 触摸设备常显分支
 * ------------------------------------------------------------------ */

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'course_digest', 'web', 'style.css'), 'utf8');

check('style.css: 有 #md [data-pages]::before 规则',
  /#md \[data-pages\]::before\s*\{/.test(CSS));
check('style.css: ▸ 默认透明（不打扰阅读）',
  /#md \[data-pages\]::before\s*\{[^}]*opacity:\s*0[;\s]/.test(CSS));
check('style.css: 悬停时显形',
  /#md \[data-pages\]:hover::before\s*\{[^}]*opacity:\s*\.6/.test(CSS));
check('style.css: 触摸设备（无 hover）常显分支存在',
  /@media \(hover:\s*none\)\s*\{[^}]*#md \[data-pages\]::before/.test(CSS));
check('style.css: ▸ 用 --accent 变量（主题色变就跟着变）',
  /#md \[data-pages\]::before\s*\{[^}]*var\(--accent\)/.test(CSS));
check('style.css: :root 定义了 --accent',
  /:root\s*\{[^}]*--accent:/.test(CSS));
check('style.css: ▸ 不吃鼠标事件（点击要落到段落上）',
  /#md \[data-pages\]::before\s*\{[^}]*pointer-events:\s*none/.test(CSS));

/* 几何不变量（比截图更靠谱：这是一条能长期跑的断言，不靠人眼看）——
   ▸ 是「悬挂」在左边距里的，悬挂距离必须**小于 #md 的左内边距**，否则它会跑出
   #md 的 border box，被 #md-scroll 的 overflow:auto 裁掉或挤出横向滚动条。
   写成 px 而不是 em 也是刻意的：字号调到 24px 时 em 会跟着变大到 28.8px → 越界。 */
const hanging = Number(
  (CSS.match(/#md \[data-pages\]::before\s*\{[^}]*left:\s*-(\d+(?:\.\d+)?)px/) || [])[1]);
const mdPadShorthand =
  (CSS.match(/#md\s*\{[^}]*padding:\s*([\d.]+)px\s+([\d.]+)px/) || []);
const padLeft = Number(mdPadShorthand[2]);

check('几何: 解析得到 ▸ 悬挂距离（px）', Number.isFinite(hanging));
check('几何: 解析得到 #md 的左内边距', Number.isFinite(padLeft));
check(`几何: ▸ 悬挂 ${hanging}px < #md 左内边距 ${padLeft}px → 不会被裁掉`,
  hanging < padLeft);

/* ------------------------------------------------------------------ *
 * 用**真渲染器**（vendored marked）验证「锚点注释后面紧跟的是哪个元素」。
 * 前端靠 nextElementAfter() 找宿主元素；表格 / 代码块能不能被标上 data-pages
 * 完全取决于这一步（引导句 + 空行 + 表格是两个块，表格前必须再补一行锚点）。
 * ------------------------------------------------------------------ */

const marked = require(path.join(
  __dirname, '..', 'course_digest', 'web', 'vendor', 'marked', 'marked.umd.js'));

const sampleMd = [
  '<!-- pages: 5 -->', '', '一段普通正文', '',
  '<!-- pages: 6 -->', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
  '<!-- pages: 7 -->', '', '```cpp', 'int main() { return 0; }', '```', '',
  '<!-- pages: 8 -->', '', '## 一个小节', '',
].join('\n');

const sampleHtml = marked.parse(sampleMd, { gfm: true });
const hosts = [...sampleHtml.matchAll(/<!-- pages: (\d+) -->\s*(<[a-z0-9]+)/g)]
  .map((m) => [m[1], m[2]]);

check('marked: 锚点注释原样保留（不转义、不吞掉）',
  sampleHtml.includes('<!-- pages: 8 -->'));
check('marked: 锚点数量与输入一致', hosts.length === 4);
check('marked: 正文前的锚点 → 落在 <p>', eq(hosts[0], ['5', '<p']));
check('marked: 表格前的锚点 → 落在 <table>', eq(hosts[1], ['6', '<table']));
check('marked: 代码块前的锚点 → 落在 <pre>', eq(hosts[2], ['7', '<pre']));

check('style.css: ▸ 用的是通用 `[data-pages]` 选择器，没有限定标签',
  /#md \[data-pages\]::before\s*\{/.test(CSS)
  && !/#md [a-z]+\[data-pages\]/.test(CSS));   // 限定标签（如 #md p[data-pages]）就会漏掉表格/代码块

/* ------------------------------------------------------------------ *
 * 分栏拖拽（不设限位）
 * ------------------------------------------------------------------ */

const splitPercent = load('splitPercent');
const splitKey = load('splitKey');

check('splitKey: 形如 course-digest:<docId>:split（per-docId）',
  splitKey('2026-09-23-demo') === 'course-digest:2026-09-23-demo:split');
check('splitKey: 不同 docId 互不干扰',
  splitKey('a') !== splitKey('b') && splitKey('') === 'course-digest::split');

// 1000px 布局 + 6px 手柄 → 可用宽度 994px
check('splitPercent: 正中间 = 50%',
  splitPercent(500, 0, 1000, 6) === '50.00%');
check('splitPercent: 布局有左边距（窗口内嵌）时要减去布局原点',
  splitPercent(600, 100, 1000, 6) === '50.00%');
check('splitPercent: 手柄贴最左（clientX = 手柄半宽）→ 0%',
  splitPercent(3, 0, 1000, 6) === '0.00%');
check('splitPercent: 手柄贴最右 → 100%',
  splitPercent(997, 0, 1000, 6) === '100.00%');
// 2006 - 6 = 2000 可用；手柄中心 500 → 正好 1/4
check('splitPercent: 左侧 1/4',
  splitPercent(503, 0, 2006, 6) === '25.00%');
check('splitPercent: 拖到最左 → 夹到 0%（不设限位，但值不能为负）',
  splitPercent(0, 0, 1000, 6) === '0.00%');
check('splitPercent: 拖到最右 → 夹到 100%（不能溢出容器）',
  splitPercent(1000, 0, 1000, 6) === '100.00%');
check('splitPercent: 远超右边界照样夹到 100%',
  splitPercent(5000, 0, 1000, 6) === '100.00%');
check('splitPercent: 布局宽度为 0 时不除零',
  splitPercent(10, 0, 0, 6) === '100%');
check('splitPercent: 宽度等于手柄宽度时也不除零',
  splitPercent(10, 0, 6, 6) === '100%');
check('splitPercent: 结果是带两位小数的百分比字符串',
  /^\d+\.\d{2}%$/.test(splitPercent(333, 0, 1000, 6)));

/* CSS / HTML 静态检查：手柄真的存在、真的接在 grid 上、移动端真的隐藏 */
const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'course_digest', 'web', 'index.html'), 'utf8');

check('index.html: 有分栏手柄且带无障碍标注',
  /id="split-handle"/.test(HTML) && /role="separator"/.test(HTML)
  && /aria-label="拖动调整左右分栏"/.test(HTML));
check('index.html: 手柄夹在 PDF 与 MD 两栏之间',
  HTML.indexOf('id="pdf-pane"') < HTML.indexOf('id="split-handle"')
  && HTML.indexOf('id="split-handle"') < HTML.indexOf('id="md-pane"'));
check('style.css: #layout 用 --split-left 控制左栏宽度',
  /grid-template-columns:\s*var\(--split-left,\s*2fr\)/.test(CSS));
check('style.css: 中间留了 6px 手柄轨道',
  /grid-template-columns:\s*var\(--split-left,[^;]*\)\s*6px\s+1fr/.test(CSS));
check('style.css: 手柄为 col-resize 光标',
  /\.split-handle\s*\{[^}]*cursor:\s*col-resize/.test(CSS));
check('style.css: 拖动中/悬停时手柄变色（用 --accent）',
  /\.split-handle\.dragging::after[\s\S]{0,80}var\(--accent\)/.test(CSS));
check('style.css: 手柄 touch-action: none（触摸下不被滚动抢走）',
  /\.split-handle\s*\{[^}]*touch-action:\s*none/.test(CSS));
check('style.css: ≤900px 隐藏手柄（保持 v0.1.0 的上下堆叠）',
  /@media \(max-width:\s*900px\)[\s\S]*?\.split-handle\s*\{\s*display:\s*none/.test(CSS));

/* 持久化的接线（真实读写要在浏览器里才跑得到，这里把「有没有接上」钉住） */
check('app.js: 启动时按 docId 读回已存比例并应用',
  /localStorage\.getItem\(key\)/.test(SRC) && /if \(stored\) applySplit\(stored\)/.test(SRC));
check('app.js: 拖动结束写回 localStorage',
  /localStorage\.setItem\(key,\s*value\)/.test(SRC));
check('app.js: 用 pointer 事件（触摸设备同一套）',
  /addEventListener\('pointerdown'/.test(SRC)
  && /addEventListener\('pointermove'/.test(SRC)
  && /addEventListener\('pointerup'/.test(SRC));
check('app.js: pointermove 节流到 rAF（不是每个事件都写 DOM）',
  /requestAnimationFrame\(flush\)/.test(SRC));
check('app.js: 拖动结束会重算 PDF 布局（否则留着旧宽度）',
  /const visible = currentVisiblePage\(\);\s*\n\s*layoutPages\(\);\s*\n\s*observePages\(\);\s*\n\s*scrollToPage\(visible\);/
    .test(SRC));
/* 「函数写了但没调用」是纯静态检查唯一抓得到的失效形态，而它恰恰最常见。
   注意要**在函数体里**找调用点并按调用位置断言：只在整个文件里搜字符串的话，
   调用被挪出渲染路径（比如挪出 renderMarkdown）测试照样绿。 */
const renderMarkdownSrc = extract('renderMarkdown');
check('app.js: renderMarkdown() 里真的调用了 annotateAnchors()',
  /annotateAnchors\(article\);/.test(renderMarkdownSrc));
check('app.js: main() 里真的调用了 renderMarkdown()',
  /^\s*renderMarkdown\(\);/m.test(SRC));
check('app.js: main() 里真的调用了 initSplitDrag()',
  /^\s*initSplitDrag\(\);/m.test(SRC));

/* 手柄轨道宽度必须与 JS 里的常量一致，否则 splitPercent 会算偏 */
const trackPx = Number(
  (CSS.match(/grid-template-columns:\s*var\(--split-left,[^;]*?\)\s*(\d+)px\s+1fr/) || [])[1]);
const jsHandlePx = Number(
  (SRC.match(/const SPLIT_HANDLE_PX\s*=\s*(\d+)/) || [])[1]);
check(`几何: CSS 手柄轨道(${trackPx}px) 与 JS 常量(${jsHandlePx}px) 一致`,
  trackPx > 0 && trackPx === jsHandlePx);

/* ------------------------------------------------------------------ *
 * 字号调整（MD / PDF 两路独立）
 * ------------------------------------------------------------------ */

/* const 常量也照「真源码」来：从 app.js 里切出 `const NAME = ...;` 再 eval，
   所以改了 app.js 的档位/范围而没同步这里的期望值，测试会立刻红。 */
function loadConst(name) {
  const m = SRC.match(new RegExp(`const ${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`));
  if (!m) throw new Error(`app.js 里找不到 const ${name}`);
  return new Function(`return (${m[1]});`)();
}

const MD_FONT = loadConst('MD_FONT');
const PDF_FONT = loadConst('PDF_FONT');
const stepMdFont = load('stepMdFont', { MD_FONT });
const stepPdfFont = load('stepPdfFont', { PDF_FONT });
const pdfFontLabel = load('pdfFontLabel');
const clampNumber = load('clampNumber');
const fontKey = load('fontKey');

check('MD 档位：12-24、步长 1、默认 16',
  MD_FONT.min === 12 && MD_FONT.max === 24 && MD_FONT.step === 1 && MD_FONT.default === 16);
check('PDF 档位：80% / 100% / 120% / 140% / 160%，默认 100%',
  eq(PDF_FONT.levels, [0.8, 1.0, 1.2, 1.4, 1.6]) && PDF_FONT.default === 1.0);

check('stepMdFont: 加一档', stepMdFont(16, +1) === 17);
check('stepMdFont: 减一档', stepMdFont(16, -1) === 15);
check('stepMdFont: 到上限不再涨', stepMdFont(24, +1) === 24);
check('stepMdFont: 到下限不再降', stepMdFont(12, -1) === 12);
check('stepMdFont: 越界值先夹回范围再加', stepMdFont(99, +1) === 24);

check('stepPdfFont: 100% → 120%', stepPdfFont(1.0, +1) === 1.2);
check('stepPdfFont: 100% → 80%', stepPdfFont(1.0, -1) === 0.8);
check('stepPdfFont: 到上限不再涨', stepPdfFont(1.6, +1) === 1.6);
check('stepPdfFont: 到下限不再降', stepPdfFont(0.8, -1) === 0.8);
check('stepPdfFont: 5 档从头点到尾再点回来，逐档走完',
  eq([0.8, 1.0, 1.2, 1.4, 1.6].map((v) => stepPdfFont(v, +1)),
     [1.0, 1.2, 1.4, 1.6, 1.6]));
check('stepPdfFont: 不在档位上的脏值从默认档开始数', stepPdfFont(1.3, +1) === 1.2);

check('pdfFontLabel: 0.8 → 80%', pdfFontLabel(0.8) === '80%');
check('pdfFontLabel: 1.6 → 160%', pdfFontLabel(1.6) === '160%');
check('pdfFontLabel: 1.0 → 100%（不带小数点）', pdfFontLabel(1.0) === '100%');

check('clampNumber: 正常值原样返回', clampNumber('20', 16, 12, 24) === 20);
check('clampNumber: 空值退回默认', clampNumber(null, 16, 12, 24) === 16);
check('clampNumber: 垃圾值退回默认', clampNumber('abc', 16, 12, 24) === 16);
check('clampNumber: 超上限夹回', clampNumber('999', 16, 12, 24) === 24);
check('clampNumber: 超下限夹回', clampNumber('-5', 16, 12, 24) === 12);
check('clampNumber: 小数值（PDF 档）可用', clampNumber('1.4', 1.0, 0.8, 1.6) === 1.4);

check('fontKey: MD 与 PDF 是两套独立的键',
  fontKey('md', 'doc1') === 'course-digest:doc1:font-md'
  && fontKey('pdf', 'doc1') === 'course-digest:doc1:font-pdf');
check('fontKey: 不同 docId 互不干扰',
  fontKey('md', 'a') !== fontKey('md', 'b'));

/* HTML / CSS 静态检查 */
check('index.html: 两组字号控件，PDF 在前 MD 在后',
  /data-target="pdf"[\s\S]*?data-target="md"/.test(HTML));
check('index.html: 每组各有 − / 数字 / + 三个按钮',
  (HTML.match(/class="font-dec"/g) || []).length === 2
  && (HTML.match(/class="font-now"/g) || []).length === 2
  && (HTML.match(/class="font-inc"/g) || []).length === 2);
check('index.html: 按钮都带 aria-label（窄屏藏标签后可访问性不丢）',
  (HTML.match(/aria-label="(缩小|放大|重置) (MD|PDF)/g) || []).length === 6);
check('index.html: 点数字重置要能从 aria-label 看出来',
  /aria-label="重置 MD 字号/.test(HTML) && /aria-label="重置 PDF 字号/.test(HTML));

check('style.css: MD 字号走 --md-font-size 变量',
  /#md\s*\{[^}]*font-size:\s*var\(--md-font-size\)/.test(CSS));
check('style.css: :root 里 --md-font-size 默认 16px',
  /:root\s*\{[^}]*--md-font-size:\s*16px/.test(CSS));
check('style.css: 选择器是 #md 本身（#md article 会选不到任何元素）',
  !/#md article\s*\{/.test(CSS));
check('style.css: 数字按钮等宽数字 + 固定宽度（防止 100%→80% 时宽度跳动）',
  /\.font-now\s*\{[^}]*tabular-nums[^}]*min-width/.test(CSS));

/* 字号变大时排版不能崩：MD 里的字号必须是相对单位。
   绝对 px 的标题在字号 24 时会比正文还小 —— 这是最容易漏掉的一类退化。 */
const absFontSizes = [...CSS.matchAll(/(#md[^{]*\{[^}]*?font-size:\s*(\d+(?:\.\d+)?)px)/g)]
  .map((m) => m[0]);
check('style.css: #md 区域内没有任何绝对 px 字号（除 #md 自身的变量）',
  absFontSizes.filter((rule) => !/font-size:\s*var\(/.test(rule)).length === 0);
check('style.css: h2 用 em（不会比正文小）', /#md h2\s*\{[^}]*font-size:\s*[\d.]+em/.test(CSS));
check('style.css: table 用 em', /#md table[^{]*\{[^}]*font-size:\s*[\d.]+em/.test(CSS));

/* 接线与行为 */
check('app.js: main() 里真的调用了 initFontControls()',
  /^\s*initFontControls\(\);/m.test(SRC));
check('app.js: MD 用 CSS 变量、PDF 用 PDF.js 缩放（两路）',
  /setProperty\('--md-font-size'/.test(SRC) && /state\.pdfZoom\s*=/.test(SRC));
check('app.js: PDF 缩放重排会保住当前页',
  /function relayoutPdfKeepingPosition\(\)[\s\S]*?currentVisiblePage\(\)[\s\S]*?layoutPages\(\)[\s\S]*?observePages\(\)[\s\S]*?scrollToPage\(visible\)/
    .test(SRC));
check('app.js: 改 PDF 缩放节流到一帧（连点不触发多轮重排）',
  /pdfZoomPending\s*=\s*true[\s\S]*?requestAnimationFrame/.test(SRC));
check('app.js: 点数字会清掉已存的值（回到未设置状态）',
  /localStorage\.removeItem\(fonts\[target\]\.key\)/.test(SRC));

/* 渲染上限：fit 受 MAX_SCALE 约束，用户倍率另乘 —— 别把 160% 悄悄吃掉 */
const maxScale = Number((SRC.match(/const MAX_SCALE\s*=\s*(\d+)/) || [])[1]);
const maxZoom = Number((SRC.match(/const MAX_ZOOM\s*=\s*([\d.]+)/) || [])[1]);
check(`渲染上限: fit(${maxScale}) × 最大倍率(${maxZoom}) = 最终上限，且倍率与 PDF 档位最大值一致`,
  maxScale > 0 && maxZoom === PDF_FONT.levels[PDF_FONT.levels.length - 1]);

/* ------------------------------------------------------------------ *
 * PDF → MD 反向跳转（ADR-015）
 *   findAnchorForPage 是纯函数（只吃 root.querySelectorAll + origPage）→ 按行为测；
 *   接线部分（命中层、监听、aria、键盘）按 app.js 真源码做静态断言。
 * ------------------------------------------------------------------ */

const findAnchorForPage = load('findAnchorForPage', { parsePages });

/* 虚拟 root：只需要 querySelectorAll 返回一个可遍历的「元素」列表 */
const pagesRoot = (...specs) => ({
  querySelectorAll: () => specs.map((p) => ({ dataset: { pages: p } })),
});

/* —— 正常路径 —— */
const elSingle = { dataset: { pages: '2' } };
const elMulti = { dataset: { pages: '5,6' } };
const twoEls = { querySelectorAll: () => [elSingle, elMulti] };

check('findAnchorForPage: 命中 → 返回该元素的引用',
  findAnchorForPage(twoEls, 5) === elMulti);
check('findAnchorForPage: 返回「第一个」匹配元素（不是第一个元素）',
  findAnchorForPage(twoEls, 2) === elSingle);
check('findAnchorForPage: 单页号命中', findAnchorForPage(pagesRoot('3'), 3) !== null);
check('findAnchorForPage: 多页号里的首号命中', findAnchorForPage(pagesRoot('5,6'), 5) !== null);
check('findAnchorForPage: 多页号里的次号命中', findAnchorForPage(pagesRoot('5,6'), 6) !== null);
check('findAnchorForPage: 多页号乱序（9,5）也找得到 5',
  findAnchorForPage(pagesRoot('9,5'), 5) !== null);
check('findAnchorForPage: 页号带空白照样解析（" 5 , 6 "）',
  findAnchorForPage(pagesRoot(' 5 , 6 '), 6) !== null);

const threeEls = [{ dataset: { pages: '1' } }, { dataset: { pages: '2' } }, { dataset: { pages: '7' } }];
check('findAnchorForPage: 目标在最后一个元素也返回它（不是 null）',
  findAnchorForPage({ querySelectorAll: () => threeEls }, 7) === threeEls[2]);

/* —— 边界 / 反向 —— */
check('findAnchorForPage: 无匹配 → null', findAnchorForPage(pagesRoot('1', '2'), 9) === null);
check('findAnchorForPage: 一个元素都没有 → null', findAnchorForPage(pagesRoot(), 1) === null);
check('findAnchorForPage: dataset.pages 空串 → null',
  findAnchorForPage(pagesRoot(''), 1) === null);
check('findAnchorForPage: 垃圾字符（x,y）→ null，不抛',
  findAnchorForPage(pagesRoot('x,y'), 1) === null);
check('findAnchorForPage: 没有 dataset.pages → null',
  findAnchorForPage({ querySelectorAll: () => [{ dataset: {} }] }, 1) === null);
check('findAnchorForPage: 0 / 负数页号不会被匹配（0 不是合法页号）',
  findAnchorForPage(pagesRoot('0,-3'), 0) === null
  && findAnchorForPage(pagesRoot('0,-3'), -3) === null);
/* 复算过：parseInt('5.5', 10) === 5（不是 NaN）——「5.5」按 5 处理，
   与 parsePages 同一口径（这里刻意记录真实行为，不写想象中的 NaN）。 */
check('findAnchorForPage: "5.5" 按 parseInt 取整成 5 命中，而 6 不命中',
  findAnchorForPage(pagesRoot('5.5'), 5) !== null
  && findAnchorForPage(pagesRoot('5.5'), 6) === null);

/* 命中即返回、不再往下遍历（惰性迭代器：若多走一步就抛） */
const lazyRoot = {
  querySelectorAll: () => ({
    [Symbol.iterator]() {
      const list = ['1', '6,7', '9'];
      let i = 0;
      return {
        next() {
          if (i >= list.length) throw new Error('命中后不该继续遍历');
          return { value: { dataset: { pages: list[i++] } }, done: false };
        },
      };
    },
  }),
};
check('findAnchorForPage: 命中立即返回，不再往下遍历',
  findAnchorForPage(lazyRoot, 6).dataset.pages === '6,7');

/* —— 页序号 → 原始页号（简化版走 page_map 反查，完整版直通） —— */

const SIMP_MAP = {
  total_original: 6,
  orig_to_simp: { '1': 1, '2': null, '3': 2, '4': null, '5': null, '6': 3 },
  simp_to_orig: { '1': 1, '2': 3, '3': 6 },
};
const origOfSimplified = load('origForIndex', {
  state: { version: 'simplified', data: { page_map: SIMP_MAP } },
});
const origOfFull = load('origForIndex', {
  state: {
    version: 'full',
    data: { page_map: { total_original: 285, orig_to_simp: {}, simp_to_orig: {} } },
  },
});
const origMissing = load('origForIndex', {
  state: { version: 'simplified', data: { page_map: { simp_to_orig: { '2': null } } } },
});

check('origForIndex 简化版: 页序 1 → 原 P1', origOfSimplified(1) === 1);
check('origForIndex 简化版: 页序 2 → 原 P3（中间被删的页跳过去）', origOfSimplified(2) === 3);
check('origForIndex 简化版: 页序 3 → 原 P6', origOfSimplified(3) === 6);
check('origForIndex 简化版: 映射缺条目 → null（不崩）', origOfSimplified(9) === null);
check('origForIndex 简化版: 页序 0 → null', origOfSimplified(0) === null);
check('origForIndex 简化版: 映射值是 null → null（不把 null 当页号）', origMissing(2) === null);
check('origForIndex 完整版: 页序号就是原始页号（不查 page_map）', origOfFull(7) === 7);
check('origForIndex 完整版: page_map 全空也不受影响（路径独立）', origOfFull(285) === 285);

/* —— 接线静态断言：函数写得再对，没接上也是白写 —— */

const layoutPagesSrc = extract('layoutPages');
check('app.js: layoutPages() 给每一页挂了反向跳转',
  /attachPageHit\(el,\s*i\s*\+\s*1\)/.test(layoutPagesSrc));

const attachSrc = extract('attachPageHit');
check('app.js: 命中层是 .cd-page-hit，且挂在页容器上',
  /className = 'cd-page-hit'/.test(attachSrc) && /el\.appendChild\(hit\)/.test(attachSrc));
check('app.js: 点命中层 → 页序换成原始页号 → jumpToMarkdown',
  /hit\.addEventListener\('click'/.test(attachSrc)
  && /origForIndex\(index\)/.test(attachSrc)
  && /jumpToMarkdown\(page\)/.test(attachSrc));
check('app.js: 页容器带 role=button / tabindex / aria-label「点击跳到第 N 页对应总结」',
  /setAttribute\('role', 'button'\)/.test(attachSrc)
  && /setAttribute\('tabindex', '0'\)/.test(attachSrc)
  && /点击跳到第 \$\{label\} 页对应总结/.test(attachSrc));
check('app.js: 键盘 Enter / Space 与点击同效（并拦掉 Space 的滚动）',
  /ev\.key !== 'Enter'/.test(attachSrc) && /ev\.key !== ' '/.test(attachSrc)
  && /ev\.preventDefault\(\)/.test(attachSrc) && /hit\.click\(\)/.test(attachSrc));

const jumpSrc = extract('jumpToMarkdown');
check('app.js: jumpToMarkdown 复用 findAnchorForPage 在总结 DOM 里查',
  /findAnchorForPage\(\$\('#md'\), origPage\)/.test(jumpSrc));
check('app.js: 命中 → 平滑滚动 + 复用既有高亮 + 状态条',
  /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/.test(jumpSrc)
  && /highlightMd\(el\)/.test(jumpSrc)
  && /setMdStatus\(/.test(jumpSrc));
check('app.js: 未命中 → 只轻提示 + 返回 false（不抛、不弹窗）',
  /if \(!el\)[\s\S]*?setMdStatus\(`第 \$\{origPage\} 页未在总结中出现`\)[\s\S]*?return false;/
    .test(jumpSrc));

const mdStatusSrc = extract('setMdStatus');
check('app.js: MD 反馈 1.5 秒后自动消失（并清掉上一次的定时器）',
  /clearTimeout\(setMdStatus\._t\)/.test(mdStatusSrc) && /1500\)/.test(mdStatusSrc));
check('app.js: PDF 正在报错（带重试）时，状态条不被 MD 反馈抢占',
  /if \(!el \|\| statusRetry\) return;/.test(mdStatusSrc));

/* —— 命中层样式 —— */

const hitRule = (CSS.match(/\.cd-page-hit\s*\{[^}]*\}/) || [''])[0];
check('style.css: 有 .cd-page-hit 命中层规则', hitRule.length > 0);
check('style.css: 命中层绝对定位并盖满整页（inset: 0）',
  /position:\s*absolute/.test(hitRule) && /inset:\s*0/.test(hitRule));
check('style.css: 命中层在 canvas 之上（z-index: 1）', /z-index:\s*1/.test(hitRule));
check('style.css: 命中层能吃点击（pointer-events: auto）',
  /pointer-events:\s*auto/.test(hitRule));
check('style.css: 命中层背景透明（不挡 PDF 渲染）', /background:\s*transparent/.test(hitRule));
check('style.css: 命中层 cursor: pointer', /cursor:\s*pointer/.test(hitRule));
check('style.css: hover 时给浅色内框提示（不打扰阅读）',
  /\.cd-page-hit:hover\s*\{[^}]*outline:\s*2px solid rgba\(0,\s*122,\s*255,\s*\.25\)/.test(CSS));

/* —— 命中层的**行为**测试：用最小假 DOM 把 attachPageHit 真跑一遍 ——
   静态正则只能证明「代码里写了 addEventListener」，证明不了「点下去真的跳」。
   这里用真函数源码 + 假 document，把「挂层 / aria / 点击 / 键盘 / 映射缺失」都走一遍。 */

function fakeEl() {
  return {
    attrs: {},
    children: [],
    listeners: {},
    className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); },
    click() { this.fire('click', {}); },
  };
}
const fakeDocument = { createElement: () => fakeEl() };

/* 简化版口径：页序 2 → 原 P3（中间的页被删了） */
const jumped = [];
const attachHit = load('attachPageHit', {
  document: fakeDocument,
  origForIndex: (i) => (i === 2 ? 3 : i),
  jumpToMarkdown: (p) => { jumped.push(p); return true; },
});

const pageEl = fakeEl();
attachHit(pageEl, 2);
check('attachPageHit: 挂出一个 .cd-page-hit 命中层（且只挂一个）',
  pageEl.children.length === 1 && pageEl.children[0].className === 'cd-page-hit');
check('attachPageHit: 页容器带 role=button / tabindex=0',
  pageEl.attrs.role === 'button' && pageEl.attrs.tabindex === '0');
check('attachPageHit: aria-label 用**原始页号**（页序 2 → 原 P3）',
  pageEl.attrs['aria-label'] === '点击跳到第 3 页对应总结');

pageEl.children[0].fire('click', {});
check('attachPageHit: 点命中层 → jumpToMarkdown(原 P3)',
  jumped.length === 1 && jumped[0] === 3);

let prevented = 0;
const keyEv = (key) => ({ key, preventDefault() { prevented += 1; } });
const beforeKeys = jumped.length;
pageEl.fire('keydown', keyEv('a'));            // 无关键不该动
check('attachPageHit: 无关按键不触发跳转',
  jumped.length === beforeKeys && prevented === 0);
pageEl.fire('keydown', keyEv('Enter'));
pageEl.fire('keydown', keyEv(' '));
check('attachPageHit: Enter / Space 各触发一次跳转',
  jumped.length === beforeKeys + 2);
check('attachPageHit: Enter / Space 会拦掉默认行为（Space 不滚页）',
  prevented === 2);

/* 映射缺失的边界：不跳、不抛，且 aria-label 退回页序号 */
const jumpedMissing = [];
const noMapping = load('attachPageHit', {
  document: fakeDocument,
  origForIndex: () => null,
  jumpToMarkdown: (p) => { jumpedMissing.push(p); return true; },
});
const orphanEl = fakeEl();
noMapping(orphanEl, 2);
orphanEl.children[0].fire('click', {});
orphanEl.fire('keydown', keyEv('Enter'));
check('attachPageHit: 原始页号映射缺失 → 点/键盘都不跳、不抛',
  jumpedMissing.length === 0);
check('attachPageHit: 映射缺失时 aria-label 退回页序号（页面仍可访问）',
  orphanEl.attrs['aria-label'] === '点击跳到第 2 页对应总结');

/* —— 回归：MD → PDF 的单向跳转不能被碰坏 —— */

const onMdClickSrc = extract('onMdClick');
check('回归: onMdClick 仍走 resolveAnchor + scrollToPage(flash)（MD → PDF 没坏）',
  /resolveAnchor\(pages\)/.test(onMdClickSrc)
  && /scrollToPage\(idx,\s*\{\s*flash:\s*true\s*\}\)/.test(onMdClickSrc));
check('回归: #md 的点击监听仍指向 onMdClick',
  /#md'\)\.addEventListener\('click',\s*onMdClick\)/.test(SRC));
check('回归: data-pages 的生成方式没变（attachAnchors 原样）',
  /target\.dataset\.pages = pages\.join\(','\)/.test(SRC));

if (failed) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\nALL PASS');

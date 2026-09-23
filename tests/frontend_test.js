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
/* 渲染链已经抽成查看区/预览区共用的 renderRichMarkdown：
   这条断言从「renderMarkdown 里调了 annotateAnchors」改成「renderMarkdown 走的是那条共用链」，
   四件事（锚点 / 气泡 / 高亮 / 公式）的断言落在扩展后的渲染链上，见下面的编辑器一节。 */
check('app.js: renderMarkdown() 走**共用**渲染链，不自己再拼一套',
  /renderRichMarkdown\(\$\('#md'\), state\.data\.summary_md/.test(renderMarkdownSrc));
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

/* —— setMdStatus 的行为：借用 #pdf-status，1.5 秒后自清，但不许误清别人的状态 —— */

let timerFn = null;
let timerMs = 0;
const statusEl = { textContent: '', hidden: true };
const $status = (sel) => (sel === '#pdf-status' ? statusEl : null);
const timerDeps = {
  $: $status,
  setTimeout: (fn, ms) => { timerFn = fn; timerMs = ms; return 1; },
  clearTimeout: () => { timerFn = null; },
};

const setMdStatus = load('setMdStatus', { ...timerDeps, statusRetry: null });
const setMdStatusBusy = load('setMdStatus', { ...timerDeps, statusRetry: () => {} });

setMdStatus('已跳到第 5 页对应总结');
check('setMdStatus: 写出文案并显示出来',
  statusEl.textContent === '已跳到第 5 页对应总结' && statusEl.hidden === false);
check('setMdStatus: 定时 1.5 秒后消失', timerMs === 1500 && typeof timerFn === 'function');
timerFn();
check('setMdStatus: 到点后清空并隐藏', statusEl.textContent === '' && statusEl.hidden === true);

setMdStatus('已跳到第 7 页对应总结');
statusEl.textContent = 'PDF 加载失败：xxx';     // 这 1.5 秒里真正的 PDF 状态顶了上来
timerFn();
check('setMdStatus: 期间被 PDF 状态顶掉过 → 不误清别人的文案',
  statusEl.textContent === 'PDF 加载失败：xxx');

statusEl.textContent = 'PDF 加载失败：xxx';
statusEl.hidden = false;
setMdStatusBusy('已跳到第 1 页对应总结');
check('setMdStatus: PDF 报错带重试时不抢占状态条',
  statusEl.textContent === 'PDF 加载失败：xxx');

/* —— 回归：MD → PDF 的单向跳转不能被碰坏 —— */

const onMdClickSrc = extract('onMdClick');
check('回归: onMdClick 仍走 resolveAnchor + scrollToPage(flash)（MD → PDF 没坏）',
  /resolveAnchor\(pages\)/.test(onMdClickSrc)
  && /scrollToPage\(idx,\s*\{\s*flash:\s*true\s*\}\)/.test(onMdClickSrc));
check('回归: #md 的点击监听仍指向 onMdClick',
  /#md'\)\.addEventListener\('click',\s*onMdClick\)/.test(SRC));
check('回归: data-pages 的生成方式没变（attachAnchors 原样）',
  /target\.dataset\.pages = pages\.join\(','\)/.test(SRC));

/* ------------------------------------------------------------------ *
 * MD 编辑器（v0.1.3）—— 纯函数
 *   期望值全部先手算过（纪律 §E-5）。「光标挪到哪」这类断言最容易想当然，
 *   所以每条的 newCursor 都从 slice 长度推出来，不凭印象写。
 * ------------------------------------------------------------------ */

const insertAtCursorText = load('insertAtCursorText');
const toolbarInsert = load('toolbarInsert');
const insertListMarker = load('insertListMarker');
const anchorComment = load('anchorComment');
const computeEditorStatus = load('computeEditorStatus');
const updateCounter = load('updateCounter');
const escapeHtml = load('escapeHtml');
const stripFooterInJs = load('stripFooterInJs');
const unanchoredWarnings = load('unanchoredWarnings');
const draftWarnings = load('draftWarnings');
const editorInitialText = load('editorInitialText', { stripFooterInJs });

/* —— 光标处插入：**替换选区**，光标落在插入内容之后 —— */

check('insert: 空选区插到中间 → 文本插进去、光标在插入内容之后',
  eq(insertAtCursorText('X', 1, 1, 'abc'),
     { newText: 'aXbc', newCursorStart: 2, newCursorEnd: 2 }));
check('insert: 有选区 → 选区被**替换**（不是插在选区之前）',
  eq(insertAtCursorText('**world**', 6, 11, 'hello world'),
     { newText: 'hello **world**', newCursorStart: 15, newCursorEnd: 15 }));
check('insert: 在文本末尾插入 → 追加，光标在最后',
  eq(insertAtCursorText('!', 3, 3, 'abc'),
     { newText: 'abc!', newCursorStart: 4, newCursorEnd: 4 }));
check('insert: 在文本开头插入 → 前置，光标在插入内容之后',
  eq(insertAtCursorText('# ', 0, 0, 'abc'),
     { newText: '# abc', newCursorStart: 2, newCursorEnd: 2 }));
check('insert: 插入空串 + 空选区 → 一个字都不变',
  eq(insertAtCursorText('', 1, 1, 'abc'),
     { newText: 'abc', newCursorStart: 1, newCursorEnd: 1 }));
check('insert: 插入空串 + 有选区 → 等于删除选区（替换语义的必然结果）',
  eq(insertAtCursorText('', 1, 3, 'abcd'),
     { newText: 'ad', newCursorStart: 1, newCursorEnd: 1 }));
check('insert: 空全文 + 空选区 → 结果就是插入内容',
  eq(insertAtCursorText('**粗体**', 0, 0, ''),
     { newText: '**粗体**', newCursorStart: 6, newCursorEnd: 6 }));
check('insert: selectionEnd 越界 → 夹到末尾（不产生 undefined 拼接）',
  eq(insertAtCursorText('Z', 1, 99, 'ab'),
     { newText: 'aZ', newCursorStart: 2, newCursorEnd: 2 }));
check('insert: selectionStart 越界 → 夹到末尾',
  eq(insertAtCursorText('Z', 99, 99, 'ab'),
     { newText: 'abZ', newCursorStart: 3, newCursorEnd: 3 }));
check('insert: 非法选区（NaN / undefined）→ 当作 0（不崩、不写 NaN 进全文）',
  eq(insertAtCursorText('Z', NaN, undefined, 'ab'),
     { newText: 'Zab', newCursorStart: 1, newCursorEnd: 1 }));
check('insert: end < start → 收成空选区（不会把区间内的字反向复制一遍）',
  eq(insertAtCursorText('Z', 2, 0, 'abc'),
     { newText: 'abZc', newCursorStart: 3, newCursorEnd: 3 }));
check('insert: 全文不是字符串 → 当空串（不抛）',
  eq(insertAtCursorText('Z', 0, 0, null),
     { newText: 'Z', newCursorStart: 1, newCursorEnd: 1 }));

/* —— 工具栏片段生成 —— */

check('toolbarInsert: bold + 无选中 → **粗体**', toolbarInsert('bold', '') === '**粗体**');
check('toolbarInsert: bold + 选中 X → **X**（不是 **X**X）', toolbarInsert('bold', 'X') === '**X**');
check('toolbarInsert: italic + 无选中 → *斜体*', toolbarInsert('italic', '') === '*斜体*');
check('toolbarInsert: italic + 选中 X → *X*', toolbarInsert('italic', 'X') === '*X*');
check('toolbarInsert: link + 无选中 → [文字](https://)', toolbarInsert('link', '') === '[文字](https://)');
check('toolbarInsert: link + 选中 X → [X](https://)', toolbarInsert('link', 'X') === '[X](https://)');
check('toolbarInsert: code + 无选中 → 围栏包着占位「代码」',
  toolbarInsert('code', '') === '\n```\n代码\n```\n');
check('toolbarInsert: code + 有选中 → 把选中文字**裹进**围栏（不吃掉它）',
  toolbarInsert('code', 'int x = 1;') === '\n```\nint x = 1;\n```\n');
check('toolbarInsert: 未知动作 → 空串（调用方据此跳过插入）', toolbarInsert('unknown', '') === '');
check('toolbarInsert: ul 交给调用方 → 空串', toolbarInsert('ul', 'x') === '');
check('toolbarInsert: anchor 交给调用方 → 空串', toolbarInsert('anchor', 'x') === '');
check('toolbarInsert: act 是 undefined → 空串（不抛）', toolbarInsert(undefined, '') === '');

/* —— 无序列表：插在**光标所在行**的行首 —— */

check('list: 光标在第二行中间 → 该行行首加 "- "，光标后移 2',
  eq(insertListMarker('a\nbc', 3), { newText: 'a\n- bc', newCursor: 5 }));
check('list: 光标刚过换行符（行首）→ 同一个结果',
  eq(insertListMarker('a\nbc', 2), { newText: 'a\n- bc', newCursor: 4 }));
check('list: 只有一行 → 行首就是文首',
  eq(insertListMarker('first line', 5), { newText: '- first line', newCursor: 7 }));
check('list: 空全文 → 只插出 "- "',
  eq(insertListMarker('', 0), { newText: '- ', newCursor: 2 }));
check('list: 光标在行尾 → 加在行首，光标落在行末之后',
  eq(insertListMarker('ab', 2), { newText: '- ab', newCursor: 4 }));
/* 记录真实行为：连点两次会得到 "- - text"（本轮不做「已有标记就跳过」的判断） */
check('list: 已经有 "- " 的行再点一次 → 变成 "- - "（本轮不做去重，如实记录）',
  eq(insertListMarker('- ab', 4), { newText: '- - ab', newCursor: 6 }));
check('list: 光标越界 → 夹到末尾（不写出 undefined）',
  eq(insertListMarker('ab', 99), { newText: '- ab', newCursor: 4 }));
check('list: 光标是 NaN → 当作 0，按第一行处理',
  eq(insertListMarker('ab', NaN), { newText: '- ab', newCursor: 2 }));
check('list: 全文不是字符串 → 当空串（不抛）',
  eq(insertListMarker(null, 0), { newText: '- ', newCursor: 2 }));

/* —— 锚点注释生成 —— */

check('anchor: 正常页号 → 约定格式的注释行',
  anchorComment('5,6', 100) === '\n<!-- pages: 5,6 -->\n');
check('anchor: 带空格的输入被规范化',
  anchorComment(' 5 , 6 ', 100) === '\n<!-- pages: 5,6 -->\n');
check('anchor: 单个页号', anchorComment('7', 100) === '\n<!-- pages: 7 -->\n');
check('anchor: 夹在中间的垃圾被过滤，合法页号保留',
  anchorComment('5,x,7', 100) === '\n<!-- pages: 5,7 -->\n');
check('anchor: 空输入 → 空串（不插）', anchorComment('', 100) === '');
check('anchor: 纯垃圾 → 空串', anchorComment('abc', 100) === '');
check('anchor: 0 与负数都不是合法页号 → 空串', anchorComment('0,-3', 100) === '');
check('anchor: 全是空白 → 空串', anchorComment('  ,  ', 100) === '');
check('anchor: null / undefined → 空串（不抛）',
  anchorComment(null, 100) === '' && anchorComment(undefined, 100) === '');
check('anchor: 页号等于总页数 → 合法（边界是闭区间）',
  anchorComment('100', 100) === '\n<!-- pages: 100 -->\n');
check('anchor: 页号超过总页数 → 空串（当场拦，不留给服务端 400）',
  anchorComment('101', 100) === '');
check('anchor: 多个页号里只要有一个越界 → 整体拒绝（不插半截锚点）',
  anchorComment('5,101', 100) === '');
check('anchor: maxPage = 0（meta 还没读到）→ 不做天花板，只校验正数',
  anchorComment('9999', 0) === '\n<!-- pages: 9999 -->\n');
check('anchor: "5.5" 按 parseInt 取整成 5（与 parsePages 同一口径）',
  anchorComment('5.5', 100) === '\n<!-- pages: 5 -->\n');

/* —— 状态条文案 —— */

check('status: 未改动 → 已加载', computeEditorStatus(false, null) === '已加载');
check('status: 改过 → 未保存', computeEditorStatus(true, null) === '未保存');
check('status: 保存中（不管脏不脏）→ 保存中…',
  computeEditorStatus(false, 'loading') === '保存中…'
  && computeEditorStatus(true, 'loading') === '保存中…');
check('status: 失败（不管脏不脏）→ 保存失败',
  computeEditorStatus(false, 'fail') === '保存失败'
  && computeEditorStatus(true, 'fail') === '保存失败');
check('status: 成功 → 覆盖脏标记显示「已保存」', computeEditorStatus(true, 'ok') === '已保存');
check('status: 覆盖率 80 → 已保存（覆盖率 80%）',
  computeEditorStatus(false, { coverage: 80 }) === '已保存（覆盖率 80%）');
check('status: 覆盖率 33.3 → 四舍五入成 33%',
  computeEditorStatus(false, { coverage: 33.3 }) === '已保存（覆盖率 33%）');
check('status: 覆盖率 66.6 → 四舍五入成 67%',
  computeEditorStatus(false, { coverage: 66.6 }) === '已保存（覆盖率 67%）');
check('status: 覆盖率 0%（草稿还能存）→ 也照实回报',
  computeEditorStatus(false, { coverage: 0 }) === '已保存（覆盖率 0%）');
check('status: 没有 coverage 的裸对象 → 当没存过（不显示 NaN%）',
  computeEditorStatus(false, {}) === '已加载');
check('status: coverage 是 NaN → 退回脏标记（不显示 NaN%）',
  computeEditorStatus(true, { coverage: NaN }) === '未保存');

/* —— 行数 / 字符数 —— */

check('counter: 三行 → 3 行 / 5 字符', updateCounter('a\nb\nc') === '3 行 / 5 字符');
check('counter: 空串 → 仍是 1 行 / 0 字符', updateCounter('') === '1 行 / 0 字符');
check('counter: 单行', updateCounter('abc') === '1 行 / 3 字符');
check('counter: 结尾换行会多出一行', updateCounter('a\n') === '2 行 / 2 字符');
check('counter: 非字符串 → 按空串算（不抛）', updateCounter(null) === '1 行 / 0 字符');
/* 中文与 emoji：按**码点**数而不是 UTF-16 码元数，否则 1 个 emoji 会显示成 2 字符 */
check('counter: 中文按字算', updateCounter('中文') === '1 行 / 2 字符');
check('counter: emoji 算 1 个字符（不是 2）', updateCounter('😀') === '1 行 / 1 字符');

/* —— HTML 转义（错误条要拼 innerHTML） —— */

check('escape: 尖括号被转义', escapeHtml('<b>') === '&lt;b&gt;');
check('escape: & 先于 < 处理（否则 &lt; 会被二次转义成 &amp;lt;）',
  escapeHtml('&lt;') === '&amp;lt;');
check('escape: 双引号', escapeHtml('"a"') === '&quot;a&quot;');
check('escape: 单引号', escapeHtml("it's") === 'it&#39;s');
check('escape: 中文 + 标签混排', escapeHtml('第 3 行：<script>') === '第 3 行：&lt;script&gt;');
check('escape: 非字符串也能转义（不抛）', escapeHtml(123) === '123');

/* —— 剥 footer（与 course_digest/footer.py 同口径） —— */

check('strip: 正文 + 票 → 只留正文，尾部规范化成单个换行',
  stripFooterInJs('正文\n<!-- course-digest: docId=foo -->\n---\n<sub>…</sub>\n') === '正文\n');
check('strip: 没有票 → 原样（只把尾部空白规范化）',
  stripFooterInJs('无 footer 正文') === '无 footer 正文\n');
check('strip: 有两张票 → 只从**最后一张**截断（前一张留在正文里）',
  stripFooterInJs('双 footer<!-- course-digest: docId=a -->\n<!-- course-digest: docId=b -->')
  === '双 footer<!-- course-digest: docId=a -->\n');
check('strip: 票前有多余空白 → 一起规范化掉',
  stripFooterInJs('正文   \n\n<!-- course-digest: docId=x -->') === '正文\n');
check('strip: 票后面没有换行也能剥',
  stripFooterInJs('正文<!-- course-digest: docId=x -->') === '正文\n');
/* 松匹配（只找 `<!-- course-digest:` 前缀）会把正文里的普通注释也当票剥掉 —— 所以要求 docId= */
check('strip: 只有前缀、没有 docId= 的注释**不是**票（不能被误剥）',
  stripFooterInJs('正文\n<!-- course-digest: 这不是票 -->\n') === '正文\n<!-- course-digest: 这不是票 -->\n');
check('strip: 空串 → 空串（与 footer.py 一致，不是 "\\n"）', stripFooterInJs('') === '');
check('strip: 纯空白 → 空串', stripFooterInJs('   \n\n') === '');
check('strip: 非字符串 → 空串（不抛）',
  stripFooterInJs(null) === '' && stripFooterInJs(undefined) === '');
/* 记录与后端的共同口径（不是本批引入的）：票之后的东西会被一起截掉 */
check('strip: 票之后还有正文 → 按后端同一口径一起截掉（口径一致，不是各自为政）',
  stripFooterInJs('正文\n<!-- course-digest: docId=a -->\n票后正文') === '正文\n');

/* —— 进编辑模式时编辑框放什么 —— */

check('editorInit: 没有草稿 → 用已保存正文并剥掉 footer',
  editorInitialText('abc\n<!-- course-digest: docId=x -->', null, false) === 'abc\n');
check('editorInit: 有未保存草稿 → 用草稿（切模式不吞用户的编辑）',
  editorInitialText('正文', '草稿内容', true) === '草稿内容');
check('editorInit: 草稿还在但已保存过 → 用最新正文（草稿作废）',
  editorInitialText('正文', '草稿内容', false) === '正文\n');
check('editorInit: 标着未保存但没有草稿 → 退回已保存正文（不能给出 undefined）',
  editorInitialText('正文', null, true) === '正文\n');
check('editorInit: 都为空 → 空串', editorInitialText('', null, false) === '');
check('editorInit: summary_md 缺失 → 空串（不抛）', editorInitialText(undefined, null, false) === '');

/* —— 渲染链 renderRichMarkdown（查看区与预览区**共用**） ——
   用假 container + 假 window 把它真跑一遍：四件事（marked / 锚点 / 高亮 / 公式）
   都做了、顺序对、边界不崩。比只测「返回了一段 HTML」强得多 ——
   「渲染链分叉」正是本批最怕的退化形态（预览与查看长得不一样 = 预览在骗人）。 */

function richPipeline(opts = {}) {
  const calls = [];
  const state = {};
  const container = {
    innerHTML: '',
    querySelectorAll: (sel) => {
      calls.push('querySelectorAll:' + sel);
      return sel === 'pre code' ? (opts.blocks || []) : [];
    },
  };
  const win = {
    marked: {
      parse: (src, o) => { calls.push('marked'); state.markedSrc = src; state.markedOpts = o; return '<p>' + src + '</p>'; },
    },
    hljs: { highlightElement: () => { calls.push('hljs'); } },
  };
  if (!opts.noMath) win.renderMathInElement = () => { calls.push('math'); };

  const fn = load('renderRichMarkdown', {
    window: win,
    attachAnchors: () => { calls.push('anchors'); },
    annotateAnchors: () => { calls.push('tooltips'); },
  });
  return { fn, container, calls, state };
}

const rich = richPipeline({ blocks: [{}] });
rich.fn(rich.container, '<!-- pages: 1 -->\n正文');
check('渲染链: marked 的结果落进 container.innerHTML',
  rich.container.innerHTML === '<p><!-- pages: 1 -->\n正文</p>');
check('渲染链: 把 gfm: true 交给 marked（与查看区同一套解析口径）',
  rich.state.markedOpts && rich.state.markedOpts.gfm === true);
check('渲染链: 原文原样交给 marked（不做预处理）',
  rich.state.markedSrc === '<!-- pages: 1 -->\n正文');
check('渲染链: 做了锚点（data-pages）', rich.calls.includes('anchors'));
check('渲染链: 挂了「点击跳转到第 N 页」悬停气泡', rich.calls.includes('tooltips'));
check('渲染链: 代码块跑了语法高亮', rich.calls.filter((c) => c === 'hljs').length === 1);
check('渲染链: 跑了公式渲染（KaTeX）', rich.calls.includes('math'));
check('渲染链: 顺序是「先高亮、后公式」（KaTeX 会插入自己的 DOM）',
  rich.calls.indexOf('hljs') < rich.calls.indexOf('math'));
check('渲染链: 高亮只认 pre code（不误伤别处）',
  rich.calls.includes('querySelectorAll:pre code'));
check('渲染链: 没有代码块就不调 hljs（空转没意义）',
  richPipeline().calls.filter((c) => c === 'hljs').length === 0);

/* 边界：KaTeX 脚本没加载（window.renderMathInElement 不存在）→ 不许抛，别的事照做 */
const noMath = richPipeline({ noMath: true, blocks: [{}] });
let mathThrew = false;
try { noMath.fn(noMath.container, '正文'); } catch (e) { mathThrew = true; }
check('渲染链: KaTeX 未加载时不抛，锚点与高亮照常',
  !mathThrew && noMath.calls.includes('anchors') && noMath.calls.includes('hljs'));
check('渲染链: KaTeX 未加载时不硬调它', !noMath.calls.includes('math'));

/* 边界：null / undefined / 空串 → 交给 marked 的是空串 */
const emptyRich = richPipeline();
emptyRich.fn(emptyRich.container, null);
check('渲染链: null 当空串（不吐 "null" 到页面上）',
  emptyRich.container.innerHTML === '<p></p>');
const undefRich = richPipeline();
undefRich.fn(undefRich.container, undefined);
check('渲染链: undefined 同样当空串', undefRich.container.innerHTML === '<p></p>');

/* 反向：某个代码块高亮抛异常，不能把整条链带崩（正文不能因为高亮失败就消失） */
const boomCalls = [];
let warns = 0;
const boomContainer = { innerHTML: '', querySelectorAll: () => [{}] };
const boomFn = load('renderRichMarkdown', {
  window: {
    marked: { parse: () => '<p>x</p>' },
    hljs: { highlightElement: () => { throw new Error('boom'); } },
    renderMathInElement: () => { boomCalls.push('math'); },
  },
  attachAnchors: () => { boomCalls.push('anchors'); },
  annotateAnchors: () => { boomCalls.push('tooltips'); },
  console: { warn: () => { warns += 1; } },   // 注入 console：既断言「有报」，也不让测试日志变脏
});
let boomThrew = false;
try { boomFn(boomContainer, 'x'); } catch (e) { boomThrew = true; }
check('渲染链: 高亮失败不中断（公式照样渲染）',
  !boomThrew && boomCalls.includes('math') && boomCalls.includes('anchors'));
check('渲染链: 高亮失败会 console.warn 报一声（不静默吞掉）', warns === 1);

/* —— 超长草稿提醒 —— */

check('draftWarnings: 没到阈值 → 不提醒', eq(draftWarnings('abc', 10), []));
check('draftWarnings: 正好等于阈值 → 不提醒（> 才算超）', eq(draftWarnings('abcdefghij', 10), []));
check('draftWarnings: 超一个字符 → 提醒并带上真实长度',
  eq(draftWarnings('abcdefghijk', 10), ['正文较长（11 字符，超过 10），预览与保存会变慢']));
check('draftWarnings: 阈值 0 + 空串 → 不提醒', eq(draftWarnings('', 0), []));
check('draftWarnings: 非字符串 → 不提醒（不抛）',
  eq(draftWarnings(null, 10), []) && eq(draftWarnings(undefined, 10), []));

/* —— 服务端回报的未锚定段落 → 人读文案 —— */

check('unanchored: 空列表 → 空', eq(unanchoredWarnings([]), []));
check('unanchored: null / 非数组 → 空（不抛）',
  eq(unanchoredWarnings(null), []) && eq(unanchoredWarnings('x'), []));
check('unanchored: 单项 → 行号 + 预览',
  eq(unanchoredWarnings([{ line: 3, preview: '一段正文' }]),
     ['第 3 行未加锚点：一段正文']));
check('unanchored: 多项保持服务端给的顺序',
  eq(unanchoredWarnings([{ line: 9, preview: 'B' }, { line: 2, preview: 'A' }]),
     ['第 9 行未加锚点：B', '第 2 行未加锚点：A']));
check('unanchored: 字段缺失 → 用占位符，不显示 undefined',
  eq(unanchoredWarnings([{}]), ['第 ? 行未加锚点：']));
check('unanchored: 非对象项不抛', eq(unanchoredWarnings(['x']), ['第 ? 行未加锚点：']));

/* ------------------------------------------------------------------ *
 * MD 编辑器 —— 接线与样式的静态断言
 *   「函数写得对但没接上」是静态检查唯一抓得到的失效形态，而它最常见。
 * ------------------------------------------------------------------ */

const renderModeSrc = extract('renderMode');
const renderEditorSrc = extract('renderEditor');
const renderViewSrc = extract('renderView');
const modeSwitchSrc = extract('onModeSwitch');
const initEditorSrc = extract('initEditor');
const saveSrc = extract('saveEditorDraft');
const cancelSrc = extract('cancelEditorDraft');
const toolbarActionSrc = extract('applyToolbarAction');
const inputSrc = extract('onEditorInput');
const previewRefreshSrc = extract('refreshEditorPreview');
const previewScheduleSrc = extract('scheduleEditorPreview');
const writeSrc = extract('writeTextarea');
const showErrSrc = extract('showEditorErrors');
const statusSrc = extract('refreshEditorStatus');

/* —— 预览重渲的防抖（行为测：连敲三下只该渲一次） —— */

const previewDebounceMs = Number((SRC.match(/const PREVIEW_DEBOUNCE_MS\s*=\s*(\d+)/) || [])[1]);
check('防抖: 窗口常量能被解析出来（150ms）', previewDebounceMs === 150);

let previewRenders = 0;
let pendingTimer = null;
const scheduleEditorPreview = load('scheduleEditorPreview', {
  PREVIEW_DEBOUNCE_MS: previewDebounceMs,
  refreshEditorPreview: () => { previewRenders += 1; },
  setTimeout: (fn, ms) => { pendingTimer = { fn, ms }; return 1; },
  clearTimeout: () => { pendingTimer = null; },
  previewTimer: null,          // 模块级句柄：与既有 setMdStatus / statusRetry 的测法一致
});
scheduleEditorPreview();
scheduleEditorPreview();
scheduleEditorPreview();
check('防抖: 连敲三下只留一个待执行回调，且窗口 = PREVIEW_DEBOUNCE_MS',
  pendingTimer !== null && pendingTimer.ms === previewDebounceMs);
pendingTimer.fn();
check('防抖: 到点只渲染一次（不是三次）', previewRenders === 1);
check('防抖: 每次都先把上一个定时器清掉（不叠加）',
  /clearTimeout\(previewTimer\)/.test(previewScheduleSrc)
  && /setTimeout\(refreshEditorPreview, PREVIEW_DEBOUNCE_MS\)/.test(previewScheduleSrc));
check('防抖: 离开编辑模式时把待执行的预览渲染清掉（别为看不见的面板白渲）',
  /clearTimeout\(previewTimer\)/.test(renderViewSrc));

check('index.html: 顶栏有 查看/编辑 分段，且排在 简化版/完整版 之前',
  /class="segmented" id="mode-switch" role="group" aria-label="模式"/.test(HTML)
  && HTML.indexOf('id="mode-switch"') < HTML.indexOf('id="version-switch"'));
check('index.html: 默认停在「查看」（与 state.mode 初值一致）',
  /data-mode="view" class="active"/.test(HTML) && /mode:\s*'view'/.test(SRC));

const toolbarHtml = (HTML.match(/<div class="md-toolbar"[\s\S]*?<\/div>/) || [''])[0];
const acts = [...toolbarHtml.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]);
check('index.html: 工具栏六个动作齐全且顺序稳定',
  eq(acts, ['bold', 'italic', 'link', 'ul', 'code', 'anchor']));
check('index.html: 工具栏每个按钮都带 aria-label（触摸设备没有 hover）',
  (toolbarHtml.match(/<button[^>]*aria-label="[^"]+"/g) || []).length === 6);
check('index.html: 工具栏带 role=toolbar 与整体标签',
  /class="md-toolbar" role="toolbar" aria-label="Markdown 工具栏"/.test(HTML));

check('index.html: #md-editor 是 #md-scroll 的**兄弟**（在 </article></div> 之后）',
  /<\/article>\s*<\/div>[\s\S]{0,400}<div id="md-editor"/.test(HTML));
check('index.html: 编辑器默认 hidden（首屏是查看态）',
  /<div id="md-editor" class="md-editor" hidden>/.test(HTML));
check('index.html: #md-textarea 关掉 spellcheck（中文正文不该有英文拼写波浪线）',
  /<textarea[^>]*id="md-textarea"[^>]*spellcheck="false"/.test(HTML));
check('index.html: 编辑器的状态条 / 错误条 / 警告条 / 计数 都在',
  /id="md-status"/.test(HTML) && /id="md-counter"/.test(HTML)
  && /id="md-errors"[^>]*hidden/.test(HTML) && /id="md-warn"[^>]*hidden/.test(HTML));
check('index.html: 保存 / 取消按钮都显式 type=button（别在别处变成 submit）',
  /id="md-save"/.test(HTML) && /id="md-cancel"/.test(HTML)
  && (HTML.match(/<button type="button" id="md-(save|cancel)"/g) || []).length === 2);

check('app.js: state 里有 mode / hasUnsaved / editorDraft',
  /mode:\s*'view'/.test(SRC) && /hasUnsaved:\s*false/.test(SRC) && /editorDraft:\s*null/.test(SRC));
check('app.js: state 里有 mdStale / viewScroll（保存后重画 + 回来时看住滚动位置）',
  /mdStale:\s*false/.test(SRC) && /viewScroll:\s*0/.test(SRC));
check('app.js: main() 里真的调用了 initEditor()', /^\s*initEditor\(\);/m.test(SRC));
check('app.js: renderMode() 分别走 renderView / renderEditor',
  /renderEditor\(\);/.test(renderModeSrc) && /renderView\(\);/.test(renderModeSrc));

check('app.js: 切编辑 = 隐藏查看区 + 显示编辑器（只切显隐，不重建 DOM）',
  /scroller\.hidden = true;/.test(renderEditorSrc) && /editor\.hidden = false;/.test(renderEditorSrc));
check('app.js: 切编辑不重画 #md（重建会丢掉它的点击监听）',
  !/renderMarkdown\(\)/.test(renderEditorSrc));
check('app.js: 切查看只切显隐；重画只在 mdStale 时做一次',
  /editor\.hidden = true;/.test(renderViewSrc) && /if \(state\.mdStale\)/.test(renderViewSrc)
  && /renderMarkdown\(\);/.test(renderViewSrc) && /buildBanners\(\);/.test(renderViewSrc));
check('app.js: 滚动位置在解除隐藏**之后**才设回去（隐藏时设它无效）',
  renderViewSrc.indexOf('scroller.hidden = false;') > -1
  && renderViewSrc.indexOf('scroller.hidden = false;') < renderViewSrc.indexOf('scroller.scrollTop = state.viewScroll;'));
check('app.js: 进编辑模式前记下查看区滚动位置', /state\.viewScroll = scroller\.scrollTop;/.test(renderEditorSrc));

check('app.js: 离开编辑模式前有草稿保护 confirm',
  /state\.mode === 'edit' && state\.hasUnsaved[\s\S]{0,60}confirm\('有未保存的修改/.test(modeSwitchSrc));
check('app.js: 点当前模式不重复渲染（mode === state.mode 直接返回）',
  /if \(mode === state\.mode\) return;/.test(modeSwitchSrc));
check('app.js: 分段高亮按点击的那个按钮切（与版本分段同一套 active 写法）',
  /classList\.toggle\('active', b === btn\)/.test(modeSwitchSrc));
check('app.js: beforeunload 拦截关页面（编辑模式 + 未保存）',
  /addEventListener\('beforeunload'/.test(initEditorSrc)
  && /state\.mode === 'edit' && state\.hasUnsaved/.test(initEditorSrc)
  && /ev\.preventDefault\(\)/.test(initEditorSrc));
check('app.js: 工具栏 / 输入 / 保存 / 取消 / 模式分段 都接上了',
  /button\[data-act\]/.test(initEditorSrc) && /'input', onEditorInput/.test(initEditorSrc)
  && /'#md-save'\)\.addEventListener\('click', saveEditorDraft\)/.test(initEditorSrc)
  && /'#md-cancel'\)\.addEventListener\('click', cancelEditorDraft\)/.test(initEditorSrc)
  && /'#mode-switch'\)\.addEventListener\('click', onModeSwitch\)/.test(initEditorSrc));
check('app.js: 取消 = 先问再丢草稿（未保存时不能静默丢）',
  /if \(state\.hasUnsaved && !confirm\('放弃未保存的修改？'\)\) return;/.test(cancelSrc)
  && /state\.editorDraft = null;/.test(cancelSrc));

check('app.js: 工具栏与键盘共用一条回写路径（回写后派发 input）',
  /dispatchEvent\(new Event\('input'\)\)/.test(writeSrc));
check('app.js: 每次输入都标脏 + 刷预览（防抖）/ 计数 / 状态条',
  /state\.hasUnsaved = true;/.test(inputSrc) && /scheduleEditorPreview\(\);/.test(inputSrc)
  && /refreshEditorCounter\(\);/.test(inputSrc) && /refreshEditorStatus\(null\);/.test(inputSrc));
check('app.js: 工具栏插入走 insertAtCursorText 纯函数',
  /insertAtCursorText\(/.test(toolbarActionSrc) && /insertListMarker\(/.test(toolbarActionSrc));
check('app.js: 锚点输入弹 prompt；取消 / 空输入什么都不做',
  /prompt\('页号（逗号分隔）：', ''\)/.test(toolbarActionSrc)
  && /if \(raw == null \|\| raw\.trim\(\) === ''\) return;/.test(toolbarActionSrc));
check('app.js: 锚点页号越界当场拦下（不留给服务端 400）',
  /anchorComment\(raw, ceiling\)/.test(toolbarActionSrc));
check('app.js: 未知工具栏动作一个字都不动', /if \(!snippet\) return;/.test(toolbarActionSrc));

/* 预览区必须与查看区**同一条渲染链**。这一条是本批最容易被改回去的东西：
   只要有人图省事把预览换回 `innerHTML = marked.parse(...)`，编辑时看到的东西
   就和保存后看到的不一样了 —— 预览当场变成谎话。 */
check('app.js: 预览区走**共用**渲染链（不是自己再拼一份 marked）',
  /renderRichMarkdown\(preview, ta\.value\)/.test(previewRefreshSrc));
check('app.js: 预览区没有再退回「只跑 marked」的老写法',
  !/preview\.innerHTML\s*=/.test(previewRefreshSrc) && !/previewHtml/.test(SRC));
check('app.js: 预览区带锚点与跳转（点锚点也跳 PDF，与查看区一致）',
  /'#md-preview'\)\.addEventListener\('click', onMdClick\)/.test(initEditorSrc));
check('app.js: 高亮会同时清掉查看区与预览区（不留两处同时亮着）',
  /#md \.md-active, #md-preview \.md-active/.test(extract('highlightMd')));

check('app.js: 保存 POST 到 /api/doc/<id>/summary（docId 过 encodeURIComponent）',
  /method: 'POST'/.test(saveSrc)
  && /'\/api\/doc\/' \+ encodeURIComponent\(state\.data\.meta\.id\) \+ '\/summary'/.test(saveSrc));
check('app.js: 保存后直接回填服务端的 summary_md（前端不自己拼 footer）',
  /state\.data\.summary_md = data\.summary_md;/.test(saveSrc)
  && !/course-digest: docId=\$\{/.test(saveSrc) && !/build_footer|buildFooter/.test(saveSrc));
check('app.js: 保存中先切「保存中…」，失败切「保存失败」',
  /refreshEditorStatus\('loading'\);/.test(saveSrc) && /refreshEditorStatus\('fail'\);/.test(saveSrc));
check('app.js: 保存成功清脏标记 + 让查看区重画',
  /state\.hasUnsaved = false;/.test(saveSrc) && /state\.mdStale = true;/.test(saveSrc));
check('app.js: 失败时把服务端的 errors 逐条列出来（不是只扔一个「失败」）',
  /data\.errors/.test(saveSrc) && /showEditorErrors\(errors\);/.test(saveSrc));
check('app.js: 覆盖率不满 100% 用黄条列未锚段落（不阻止保存）',
  /showEditorWarnings\(unanchoredWarnings\(data\.unanchored\)\);/.test(saveSrc));
check('app.js: 网络异常也落到「保存失败」而不是静默',
  /catch \(err\)[\s\S]{0,200}refreshEditorStatus\('fail'\);/.test(saveSrc));
check('app.js: 错误条拼 innerHTML 前先转义', /escapeHtml\(e\)/.test(showErrSrc));
check('app.js: 编辑器用自有 #md-status（不再借 PDF 的状态条）',
  /\$\('#md-status'\)/.test(statusSrc) && !/pdf-status/.test(statusSrc));

const maxDraftChars = Number((SRC.match(/const MAX_DRAFT_CHARS\s*=\s*(\d+)/) || [])[1]);
check('app.js: 超长草稿阈值 = 100000（设计 §4：100KB 内流畅）', maxDraftChars === 100000);
check('app.js: 输入与进编辑模式都拿这个阈值去算提醒',
  /draftWarnings\(ta\.value, MAX_DRAFT_CHARS\)/.test(inputSrc)
  && /draftWarnings\(ta\.value, MAX_DRAFT_CHARS\)/.test(renderEditorSrc));

check('回归: 编辑器不碰 PDF 侧（不改版本 / 不重排 / 不重载）',
  !/switchVersion|loadPdf|layoutPages|relayoutPdfKeepingPosition/.test(
    toolbarActionSrc + renderEditorSrc + saveSrc));
check('回归: app.js 不构造 footer（格式只由 footer.py 定义）',
  !/course-digest: docId=\$\{/.test(SRC) && !/'<sub>/.test(SRC) && !/build_footer|buildFooter/.test(SRC));
check('回归: MD → PDF 点击监听仍在 #md 上（编辑器没把它顶掉）',
  /#md'\)\.addEventListener\('click',\s*onMdClick\)/.test(SRC));

check('style.css: 编辑态靠 [hidden] 真隐藏（flex 容器上 hidden 会被 display 覆盖）',
  /#md-editor\[hidden\],\s*#md-scroll\[hidden\]\s*\{[^}]*display:\s*none/.test(CSS));
check('style.css: 编辑器纵向铺满（.md-editor 是 flex 列 + height 100%）',
  /\.md-editor\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*height:\s*100%/.test(CSS));
check('style.css: 编辑区两栏 = textarea + 预览（grid 1fr 1fr）',
  /\.md-split\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr/.test(CSS));
check('style.css: textarea 等宽字体 + 跟着 --md-font-size（编辑排面 = 查看排面）',
  /#md-textarea\s*\{[^}]*font-family:\s*ui-monospace[^}]*font-size:\s*var\(--md-font-size\)/.test(CSS));
check('style.css: 预览区字号与查看区同一套变量',
  /#md-preview\s*\{[^}]*font-size:\s*var\(--md-font-size\)/.test(CSS));
check('style.css: textarea / 预览都 min-width: 0（分栏拖到极窄也不撑爆）',
  /#md-textarea\s*\{[^}]*min-width:\s*0/.test(CSS) && /#md-preview\s*\{[^}]*min-width:\s*0/.test(CSS));
check('style.css: 错误条红、警告条黄（两种反馈不混淆）',
  /#md-errors\s*\{[^}]*color:\s*#c00/.test(CSS) && /#md-warn\s*\{[^}]*color:\s*#8a5a00/.test(CSS));
check('style.css: 两个条也走 [hidden] 隐藏',
  /#md-errors\[hidden\],\s*#md-warn\[hidden\]\s*\{[^}]*display:\s*none/.test(CSS));
check('style.css: 保存按钮用品牌色 --accent',
  /#md-save\s*\{[^}]*var\(--accent\)/.test(CSS));
check('style.css: ≤900px 编辑区也改上下叠（触摸设备的主战场）',
  /@media \(max-width:\s*900px\)[\s\S]*?\.md-split\s*\{[^}]*grid-template-columns:\s*1fr[^}]*grid-template-rows/.test(CSS));

/* —— 预览区的锚点标记：必须与查看区一个观感（两边共用渲染链，样式也得跟上） —— */

check('style.css: 预览区也有 ▸ 锚点标记（不是「一边有一边没有」）',
  /\.md-preview \[data-pages\]::before\s*\{[^}]*content:\s*"▸"/.test(CSS));
check('style.css: 预览区 ▸ 默认透明、悬停显形（与查看区同一套反馈）',
  /\.md-preview \[data-pages\]::before\s*\{[^}]*opacity:\s*0[;\s]/.test(CSS)
  && /\.md-preview \[data-pages\]:hover::before\s*\{[^}]*opacity:\s*\.6/.test(CSS));
check('style.css: 预览区锚点光标是手型',
  /\.md-preview \[data-pages\]\s*\{[^}]*cursor:\s*pointer/.test(CSS));
check('style.css: 预览区 ▸ 用 --accent 主题色',
  /\.md-preview \[data-pages\]::before\s*\{[^}]*var\(--accent\)/.test(CSS));
check('style.css: 预览区 ▸ 不吃鼠标事件（点击要落到段落上）',
  /\.md-preview \[data-pages\]::before\s*\{[^}]*pointer-events:\s*none/.test(CSS));
check('style.css: 触摸设备（无 hover）下预览区 ▸ 常显',
  /@media \(hover:\s*none\)\s*\{[^}]*\.md-preview \[data-pages\]::before/.test(CSS));
check('style.css: 预览区也有跳转命中高亮（.md-active）',
  /\.md-preview \.md-active\s*\{[^}]*#fff4d6/.test(CSS));

/* 几何不变量（与查看区那条同一个道理）：▸ 悬挂在 padding 里的距离必须**小于**左内边距，
   否则会被 #md-preview 的 overflow 裁掉、或挤出横向滚动条。
   写成 px 而不是 em 也是刻意的：字号调到 24 时 em 会跟着变大 → 越界。 */
const previewHang = Number(
  (CSS.match(/\.md-preview \[data-pages\]::before\s*\{[^}]*left:\s*-(\d+(?:\.\d+)?)px/) || [])[1]);
const previewPad = (CSS.match(/#md-preview\s*\{[^}]*padding:\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/) || []);
const previewPadLeft = Number(previewPad[4]);
check('几何: 解析得到预览区 ▸ 悬挂距离与左内边距',
  Number.isFinite(previewHang) && Number.isFinite(previewPadLeft));
check(`几何: 预览区 ▸ 悬挂 ${previewHang}px < 左内边距 ${previewPadLeft}px → 不会被裁掉`,
  previewHang > 0 && previewHang < previewPadLeft);
/* 编辑器的 #md-* 规则同样受「不许绝对 px 字号」约束 —— 否则字号控件带不动它们 */
const editorPxFont = [...CSS.matchAll(
  /#md-(?:editor|textarea|preview|errors|warn|save|cancel|status|counter)[^{]*\{[^}]*?font-size:\s*(\d+(?:\.\d+)?)px/g)];
check('style.css: 编辑器里的 #md-* 规则没有绝对 px 字号（必须 var()/em）',
  editorPxFont.length === 0);

if (failed) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\nALL PASS');

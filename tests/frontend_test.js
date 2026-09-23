#!/usr/bin/env node
/* 前端纯逻辑冒烟测试（plain node，零依赖）。
 *
 * 为什么不做浏览器测试：本项目的老规矩是「**用真函数源码 + 合成数据在 node 里跑**」
 * （见交接包 05-验证清单 §三）。真函数源码是从 app.js 里**读出来再 eval** 的，
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
 * 只有 module 报错」，而且服务端日志全是 200（坑 #5 的形态）。这里先拦一道。
 * import 必须写在顶层，所以摘掉 import 行再整体编译。
 * ------------------------------------------------------------------ */

try {
  new Function(SRC.replace(/^\s*import .*$/gm, ''));
  check('app.js 语法可编译', true);
} catch (err) {
  check(`app.js 语法可编译（${err.message}）`, false);
}

/* ------------------------------------------------------------------ *
 * 下载文件名（F5）
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
 * 锚点三级回退（§三）—— 现有逻辑，真数据只触发得到规则 1
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
 * 锚点提示：文案 + 挂载（ADR-016）
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
 * 完全取决于这一步（坑 #10：引导句 + 空行 + 表格是两个块，表格前必须再补一行锚点）。
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
check('marked: 表格前的锚点 → 落在 <table>（坑 #10）', eq(hosts[1], ['6', '<table']));
check('marked: 代码块前的锚点 → 落在 <pre>', eq(hosts[2], ['7', '<pre']));

check('style.css: ▸ 通用选择器能覆盖表格（不写死 p）',
  !/#md p\[data-pages\]/.test(CSS) && /#md \[data-pages\]/.test(CSS));

/* ------------------------------------------------------------------ *
 * 分栏拖拽（F8，ADR-017：不设限位）
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
check('splitPercent: 拖到最左 → 夹到 0%（ADR-017 允许，但值不能为负）',
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
/* 「函数写了但没调用」是纯静态检查唯一抓得到的失效形态，而它恰恰最常见 */
check('app.js: main() 里真的调用了 initSplitDrag()',
  /^\s*initSplitDrag\(\);/m.test(SRC));
check('app.js: main() 里真的调用了 annotateAnchors()',
  /annotateAnchors\(article\);/.test(SRC));

/* 手柄轨道宽度必须与 JS 里的常量一致，否则 splitPercent 会算偏 */
const trackPx = Number(
  (CSS.match(/grid-template-columns:\s*var\(--split-left,[^;]*?\)\s*(\d+)px\s+1fr/) || [])[1]);
const jsHandlePx = Number(
  (SRC.match(/const SPLIT_HANDLE_PX\s*=\s*(\d+)/) || [])[1]);
check(`几何: CSS 手柄轨道(${trackPx}px) 与 JS 常量(${jsHandlePx}px) 一致`,
  trackPx > 0 && trackPx === jsHandlePx);

/* index.html 的按钮接线在 http_test.py 里查（那边本来就在做静态资产检查） */

if (failed) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\nALL PASS');

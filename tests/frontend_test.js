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

if (failed) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\nALL PASS');

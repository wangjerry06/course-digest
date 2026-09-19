# vendor 库版本

全部本地化，**不引 CDN**（ADR-004：断网可用）。版本号写死，不要用 `latest`，避免漂移。
下载方式：`npm pack <包名>@<版本>` 取官方发行 tarball，解包后只拷需要的文件。

| 库 | 版本 | 官方来源 | 本地路径 | 取的文件 |
|---|---|---|---|---|
| PDF.js（pdfjs-dist） | **6.3.289** | <https://www.npmjs.com/package/pdfjs-dist> · <https://github.com/mozilla/pdf.js> | `vendor/pdfjs/` | `build/pdf.min.mjs`（ESM）、`build/pdf.worker.min.mjs`、`web/pdf_viewer.css`、`cmaps/`、`standard_fonts/`、`wasm/` |
| marked | **18.0.13** | <https://www.npmjs.com/package/marked> · <https://github.com/markedjs/marked> | `vendor/marked/` | `lib/marked.umd.js` |
| KaTeX | **0.18.7** | <https://www.npmjs.com/package/katex> · <https://github.com/KaTeX/KaTeX> | `vendor/katex/` | `dist/katex.min.js`、`dist/katex.min.css`、`dist/contrib/auto-render.min.js`、`dist/fonts/` |
| highlight.js | **11.12.0** | <https://www.npmjs.com/package/@highlightjs/cdn-assets> · <https://github.com/highlightjs/highlight.js> | `vendor/highlight.js/` | `highlight.min.js`、`styles/github.min.css` |

## 三个取包时的坑（记下来，升级时别踩第二遍）

1. **highlight.js 不能从 `highlight.js` 包取浏览器单文件**。该包的 `es/*.js` 只是
   `import ... from '../lib/xx.js'` 的转发壳，而 `lib/` 是 CommonJS —— 浏览器里当 ESM
   加载会直接报错。浏览器单文件在官方另一个包 **`@highlightjs/cdn-assets`** 里，
   本目录取的就是它（同为 11.12.0）。
2. **PDF.js 的 worker 路径必须自己指定**。默认值是 `./pdf.worker.mjs`，相对的是
   `pdf.min.mjs` 所在目录；我们在 `app.js` 里显式设 `GlobalWorkerOptions.workerSrc`。
3. **`cmaps/` / `standard_fonts/` / `wasm/` 要一起拷**。少了 cmaps 中日韩课件会缺字，
   少了 standard_fonts 未内嵌字体的 PDF 会走替代字体，少了 wasm 则在 JBIG2 /
   JPEG2000 图像页上运行时报错。三个目录加起来约 3.9 MB，对本地工具可以接受。

## 加载方式

- PDF.js：**ESM**，`app.js` 顶部 `import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs'`；
  页面是 HTTP 提供的（不是 `file://`），ESM 与 worker 都能正常工作 —— 这正是
  ADR-002/003 选 HTTP 的收益之一。
- marked / KaTeX / highlight.js：**UMD 经典 `<script>`**，在 `index.html` 里先于
  `<script type="module">` 执行，全局 `marked` / `katex` / `renderMathInElement` / `hljs`
  在 `app.js` 运行时已就绪。
- `vendor/pdfjs/pdf_viewer.css` 是官方原文。它里面绝大多数规则挂在 `.pdfViewer` /
  `.annotationLayer` / 编辑器类名上，我们的自有 canvas 列表不会命中；真正用到的是
  顶层的 **`.textLayer`** 规则（文字可选中）。它依赖的 `--scale-factor` /
  `--total-scale-factor` / `--scale-round-x|y` 由 `style.css` 的 `.cd-page` 自己声明
  （官方是挂在 `.pdfViewer .page` 上的，不会命中我们的元素）。

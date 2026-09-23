# 版本历史

## [0.2.0] — 2026-09-23

**一项主题：Windows 兼容（ADR-016）。无 breaking change** —— CLI 命令、产物格式、
回程票的机器可读段、`~/.course-digest/` 既有内容全部不变；macOS 行为零变化。

### 支持平台：macOS → macOS + Windows

v0.1.x 的代码底子（pathlib、`Path.home()`、`webbrowser`、子进程 detached 分支、显式 UTF-8 文件 IO）
本来就近跨平台，这次只修真正会坏掉的五个点：

1. **`_pid_alive` 地雷拆除**：Windows 上 `os.kill(pid, 0)` 不是探活，而是
   `TerminateProcess(pid, 0)` —— 会把目标进程**真的杀掉**。拆成 `_pid_alive_posix`
   （原逻辑不动）与 `_pid_alive_windows`（`tasklist` 只读查询，按 `"<pid>"` 精确匹配）。
   `stop()` 的终止在 Windows 上语义为 TerminateProcess（硬杀；本地 HTTP 服务无状态，安全），
   轮询间隔放宽到 0.5s（tasklist 子进程不便宜）。
2. **CLI stdout/stderr 强制 UTF-8**：中文 Windows 管道输出默认跟随 locale（cp936），
   footer 里的 📄、stderr 里的 →/… 会直接 `UnicodeEncodeError`，破坏 agent 依赖的
   stdout 契约。入口统一 `reconfigure(encoding="utf-8", errors="replace")`。
3. **展示命令按平台给**：Windows 没有 `python3`（常是 Store 占位假命令）。回程票人读段、
   报错提示里的命令前缀改为按平台取 `python3`（posix）/ `python`（nt）；
   机器可读段（docId 注释）两平台完全一致。真正起子进程仍一律 `sys.executable`。
4. **原子写抗文件锁**：Windows 上 `replace` 一个正被读取的目标文件会 `PermissionError`
   （macOS 不会）。新增 `paths.atomic_replace`（3 次 × 0.1s 短重试），
   publish / simplify 的四处 tmp→目标 替换统一走它。
5. **mimetypes 补 `.html`/`.htm`**：Windows 上 mimetypes 会读注册表，个别机器把 .html
   登记成奇怪类型 → SPA 入口被发错 Content-Type 白屏。显式登记压住。

### 明确不做（诚实降级）

- **视觉补丁保持 macOS-only**：渲染工具 `tools/pdfrender.swift` 依赖 PDFKit + swiftc。
  Windows 上按纯文本层写总结并注明「未做视觉补丁」—— 不为渲染引入 PyMuPDF 之类依赖，
  零依赖原则不破（`references/visual-patch.md` 已标注边界）。
- Linux 未测：路径与 macOS 同源，理论可用，但不承诺。

### 环境自检（SKILL.md 新增）

两平台（尤其 Windows）都**不自带 Python**，而本 skill 的检测逻辑没法用 Python 自己写
（没有 Python 时代码跑不起来）—— 所以落点是给 agent 的自检指令：
首次使用先跑 `python3 --version`（Windows：`python`/`py`），识别三种失败形态
（Windows 的 Store 假命令、macOS 缺 python3、版本 < 3.10），
**引导用户安装而不擅自代装**；`README.md` 同步补了「首次使用装 Python」三步说明。

### 不变的事

- CLI 命令、stdout/stderr 契约、产物格式（summary.md / page-map.json / meta.json / simplified.pdf）
- 回程票的机器可读注释格式（`<!-- course-digest: docId=... -->`）—— 老文档的票依然有效
- `~/.course-digest/` 数据目录语义（Windows 上即 `C:\Users\<用户名>\.course-digest\`）
- 三套测试基线全部保留，另补 Windows 分支的纯逻辑测试（platform mock，macOS 上也能跑）

## [0.1.3] — 2026-09-23

**四项改动：一项纯文档（写总结的风格偏好升硬约定）+ 一项前端交互新增（联动改双向）+ 一项新 API 端点（编辑器保存的后端链路）+ 一项前端新增（页面上的 MD 编辑器）。无 breaking change** —— 命令、产物格式、`~/.course-digest/` 既有内容都不变。

### 变更：写总结的风格偏好升为硬约定

把「agent 写总结时按用户偏好持久化」从 `SKILL.md` 里的**软建议升为硬契约**：

- **临时偏好**（「这次短一点」「这次别配例子」）→ 只对本次生效，**不写回** `style.md`
- **持久偏好**（「以后都这样」「记住这个风格」「以后总结要 XX」「默认 XX」）→ **必须改**
  `~/.course-digest/style.md` 的「当前偏好」段，**写回文件才算完成**
- 改动 / 恢复默认之后，**必须**用一句话告诉用户「已记下：×××」

`SKILL.md` 第 0 步改写成强约束（含「临时 vs 持久」对照表 + agent 自查清单），
`README.md` 补了用户视角的说明。不改文件格式、不加 CLI 子命令。

### 受影响 / 受益的场景

- agent 以前偶尔「记在心里不写盘」的偏好 → 现在必须落盘，下次总结仍按它写
- 换一台机器 / 换一个 agent harness → 偏好仍生效（文件在 `~/.course-digest/`，ADR-014）

### 不变的事

- `~/.course-digest/style.md` 的文件格式（仍是人读 md）
- CLI 命令、产物格式、`~/.course-digest/` 里的既有文档库
- 三套测试基线（**v0.1.2 → v0.1.3 新增 297 条**：smoke 194 一字不差，http 56→107，frontend 114→360 —— **基线不破基线**；commit history 里 `extract.json` / `page-map.json` / `simplified.pdf` 的 sha256 与 v0.1.2 完全一致）

### 新增：点 PDF 的任意一页，跳到对应总结（联动从单向升为双向）

v0.1.2 之前联动是**单向**的：点总结里的段落 → 跳到 PDF 对应页。反过来走不通。
现在**点左侧 PDF 的任意一页 → 右侧总结自动滚到「标注了这一原始页号的第一段」并高亮**，
状态条同时提示「已跳到第 N 页对应总结」。

- **简化版 PDF**：页序号先经 `page-map.json` 的 `simp_to_orig` 反查回原始页号，再去总结里找
- **完整版 PDF**：页序号本身就是原始页号，直接找（不依赖 `page-map.json`）
- **两版规则统一**：都是「直接跳、找第一个匹配段」，没有三级回退那一套
- **找不到就轻提示**：该页没被任何一段总结引用时，底部状态条提示「第 N 页未在总结中出现」，
  1.5 秒自动消失 —— **不报错、不弹窗**（简化版里很多页本来就没被引用，这是正常情况）
- **可访问性**：每页可 Tab 聚焦，`aria-label` 为「点击跳到第 N 页对应总结」，
  Enter / Space 与鼠标点击同效；悬停时有浅色内框 + `cursor: pointer`

新立 **ADR-015** 取代 ADR-007「只做单向」的旧条款（ADR-007 已标注为被取代）。
实现上**纯前端本地遍历 `[data-pages]`**：没有新增服务端接口、没有新增依赖、没有新增产物。

已知取舍：命中层要盖在 canvas 之上才拿得到 `cursor: pointer` 与 hover 反馈，
因此 PDF 原文的**文字拖选会被它挡住**（ADR-005 的文本层仍在，只是指针够不到）。
要保留选字，就得把点击监听挪到页容器上、并接受文字上光标变 I 形 —— 两者不能兼得。

### 新增：`POST /api/doc/<id>/summary` —— 编辑器保存的后端链路

页面上的 MD 编辑器要把改过的总结存回去，服务端提供这条写接口：

```
POST /api/doc/<id>/summary    body: {"summary_md": "..."}
      ↓ strip_footer → validate_summary → anchor_coverage → 落盘 summary.md
200 → {ok: true,  coverage, anchored, total, unanchored, summary_md}
400 → {ok: false, errors, coverage, anchored, total, unanchored}
```

- **与命令行 publish 同一套口径**：复用抽出来的纯函数 `_write_summary_md`，落盘字节
  就是 `strip_footer(正文) + build_footer(docId)`。于是「在页面上保存」和「用命令发布」
  不会产出两种不同的 `summary.md`，也不会把回程票叠成两张
- **回程票由服务端管**：前端送上来带票、不带票都行 —— 服务端自己剥、自己补一张；
  响应里的 `summary_md` 是**可直接回填前端**的最终形态，前端不必也不该自己拼 footer
- **锚点不合规 → 400 阻止**（格式非法 / 页号越界）；**覆盖率不满 100% → 200 不阻止**，
  只把 `coverage` 和未锚段落（行号 + 预览）报回来 —— 编辑器是草稿场景，半成品必须存得下
- **只改 `summary.md`**：`simplified.pdf` / `page-map.json` / `extract.json` / `meta.json`
  一个字节都不动（测试里逐个 sha256 见证）
- **路径防御与读接口同一道闸**：docId 白名单不合法 → 400；resolve 后越出 `docs/` → 403
- **不改既有 HTTP 契约**：读接口仍然只有 GET，只读资源上的 POST 仍然 405；
  `GET /api/doc/<id>` 的返回字段名一个没动；不开 CORS（ADR-002）

顺带把 `publish.py` 里「正文 + 回程票」的落盘口径抽成纯函数，两条路径共用一份写法。
抽完用**4 份真实文档**在旧 / 新代码上各跑一次 publish：`summary.md` / `meta.json` /
`page-map.json` / `simplified.pdf` 的 sha256 与 stdout **全部相同** —— 是逐字节等价，
不是「看起来一样」。

测试：`tests/http_test.py` 由 **56 条增至 107 条**（正常 / 边界 / 反向三类都覆盖，
含「带票不叠票」「同路径重发幂等」「400 不落盘」「只动 summary.md」等）。

### 新增：页面上的 MD 编辑器（顶栏「查看 / 编辑」）

顶栏多了一组「查看 / 编辑」分段。切到「编辑」，右栏就从渲染好的总结变成
**textarea 编辑器 + 实时预览**：左边改 Markdown，右边立刻看到渲染结果。

- **工具栏六个动作**：粗体 / 斜体 / 链接 / 无序列表 / 代码块 / 插入锚点。都是「在光标处插入」——
  有选中文字时把选中内容**包进**片段里（不复制、不吞掉），插入后光标落在片段之后。
  「插入锚点」弹一个小输入框要页号（逗号分隔），当场规范化成 `<!-- pages: 5,6 -->`；
  页号越界（大于总页数）**当场**红条拦下，不留给服务端去拒
- **实时预览**：输入即更新，且**与查看模式走同一条渲染链**（marked → 锚点 → 代码高亮 →
  公式）。也就是说编辑时看到的代码配色、`$公式$` 排版、段首 ▸ 锚点标记、悬停气泡、
  点锚点跳 PDF，与保存后查看模式里**完全一样** —— 预览不会骗人。
  重渲带 150ms 防抖：高亮与公式在长文档上不便宜，每个按键都跑一遍会把手感拖垮
- **状态条**：`已加载 / 未保存 / 保存中… / 已保存（覆盖率 NN%）/ 保存失败`，
  右侧实时显示行数与字符数
- **草稿保护**：编辑模式下有未保存改动时，**切回查看**与**关页面 / 刷新**都会先拦一道
  （前者 `confirm`，后者浏览器原生提示）；切走再切回来，没保存的草稿还在
- **保存**：走 `POST /api/doc/<id>/summary`（与命令行 `publish` 同一条校验链）。
  保存成功后**留在编辑模式**，由用户点「取消」回查看；查看区在切回去时才重画，
  所以「同一篇文档看哪儿」的位置不会丢
- **两种反馈分色**：锚点不合法 → **红条**逐条列出错误、**不落盘**；覆盖率不满 100% →
  **黄条**列出未锚段落（行号 + 预览）但**照存** —— 编辑器是草稿场景，半成品必须存得下
- **只动 `summary.md`**：`simplified.pdf` / `page-map.json` / `extract.json` / `meta.json`
  一个字节都不变
- **不动既有交互**：查看区与编辑器是右栏里的两个**兄弟节点**，切模式只切显隐 ——
  查看区不重建，所以「点总结段落跳 PDF」「点 PDF 跳总结」两条链都没被碰
- **可访问性 / 触摸**：工具栏按钮是真 `<button>`（带 `aria-label`，触摸下可点），
  编辑模式全程键盘可用；≤900px 时编辑框与预览改成上下叠

已知取舍：预览区不画「此处略过原 PX–PY」提示条（那是查看区专属的阅读辅助，
编辑时反而占地方）。除此之外预览与查看一致 —— 渲染链是同一条函数，
两边不可能再各长各的。

测试：`tests/frontend_test.js` 由 **172 条增至 360 条**（**+188**），其中编辑器自身
百余条纯函数用例（插入与光标 / 工具栏片段 / 锚点规范化 / 状态条 / 剥回程票 / 计数 / 转义），
渲染链与预览防抖按行为测（假 container + 假 timer 真跑一遍），
其余为接线与样式的静态断言（含「切模式不重建查看区」「预览与查看共用同一条渲染链」
「预览区 ▸ 的悬挂距离小于左内边距」三条回归）。
另有**两层真发请求的补测**（不进仓库）：用本机浏览器走完「切模式 → 工具栏 → 预览 →
草稿保护 → 保存 → 红条 / 黄条反馈 → 字号 → 极端分栏 → 触摸」，以及用 node 真 fetch
打一遍保存接口并核对磁盘产物（`summary.md` 变、其余四个产物 sha256 不变）。

## [0.1.2] — 2026-09-23

**一个修复，无 breaking change** —— 命令、产物格式、`~/.course-digest/` 里的既有文档库都不变。

### 修复：下载的 summary 恒带回程票，存量文档无需重发

v0.1.1 引入的**回程票**只在 `publish` 时写入磁盘，而 `open` 刻意「不重新生成任何
东西」—— 于是在 v0.1.1 **之前** publish 的存量文档，磁盘上的 `summary.md` 没有票，
页面「下载 MD」下到的文件也就没有票，`open <md路径>` 重开并排页面这条功能对它们
**全部失效**。

现在改为**在服务出口统一补票**：`GET /api/doc/<id>` 返回的 `summary_md` 恒为
「规范形正文 + 恰好一张回程票」。由此：

- **存量文档不用重发**：打开页面后下载到的 md 就带票；磁盘上的文档数据一个字节都没被改
- **已按 v0.1.1 发布过的文档不受影响**：磁盘内容本就是「正文 + 票」，出口变换逐字节
  等价（幂等），不会叠加、不会漂
- **出口只读不写**：用户数据仍然只由 `publish` 写，这与「`summary.md` 的唯一最终写入者
  是 publish」这条规矩一致

为什么能保证幂等：落盘口径是 `strip_footer(正文) + build_footer(docId)`，出口再套一次
同样的变换，对已成规范形的文件结果不变。这条等价性由 `tests/http_test.py` 的新用例
（无票老文档 → 带票、请求前后磁盘 sha256 不变、已带票文档逐字节一致、连请求两次一致、
正文段落数/锚点数不变）钉住。

实现上把回程票的三个纯函数拆到了 `course_digest/footer.py`（`publish` 已 import
`serve`，`serve` 再 import `publish` 会循环导入），`publish` 仍从原处同名可导入。

## [0.1.1] — 2026-09-23

**八项增量改进，全部不碰压缩算法。无 breaking change** —— 老命令、老产物、
`~/.course-digest/` 里的既有文档库一律照旧可用。

### 新增：下载的总结能「一条命令重开」

`publish` 现在会在落盘的 `summary.md` **尾部追加一张回程票**（一行 HTML 注释写 docId +
一段人读说明）。于是下载到本地、改了名字、放到任何目录的总结：

```bash
python3 -m course_digest open ~/Downloads/我的课程总结.md
```

一条命令就把并排页面重新打开 —— 不必记得 docId，也不必重新生成任何东西。

- 回程票里**只写 docId 不写 URL**：端口会变、服务会停、pid 会换，写 URL 等于埋一张过期车票；
  docId 是稳定标识（ADR-014）
- 幂等：同一份 summary 连发两次，`meta.json` / `summary.md` / `simplified.pdf` /
  `page-map.json` 指纹不变（回程票「先剥后写」，重复 publish 不叠加）
- 回程票由工具管理：手改会被重建（docId 以命令行为准），手删会补回；
  但**删掉就失去了重开线索** —— 这是用户的文件，工具不替用户保管
- `open` 只认注释内容，不要求文件名叫 `summary.md`；没票的 md 会明确报错而不是含糊失败

### 新增：覆盖率不满 100% 时，直接告诉你「改哪里」

以前 `publish` 只报一个百分比，还得自己通读一遍找漏锚点的段落。现在 stderr 会逐条列出
**行号 + 前 30 字符预览**（上限 10 条，超出打「…等 N 段」），按提示逐个补锚点后重发即可，
一轮修完，不用整份重写。stdout 契约不变（仍然只输出 URL）。

### 新增：查看页面的四项交互

- **锚点可点击提示**：可点段落/表格/代码块左侧悬停显一个小三角 `▸`，
  并带「点击跳转到第 N 页」气泡。触摸设备没有 hover，`▸` 常显（发现性不丢）
- **左右分栏可拖拽**：捏住中间分界线左右拉，**不设限位**（可以拉到任一侧全屏，
  拖过头也能拉回来）；比例按文档存 `localStorage`
- **字号调整**：顶栏两组独立控件 —— `PDF` 80%–160% 五档（走 PDF.js 缩放）、
  `MD` 12–24 逐档（走 CSS 变量）；点中间的数字即重置。两者互不影响
- **下载 PDF**：与「下载 MD」并列，存简化版 PDF（文件名 `<docId>-simplified.pdf`）

### 实测数字（真实课件，与 v0.1.0 逐字节一致）

| 课件 | 页数 | 压缩后 | 正文压缩 |
|---|---|---|---|
| CSC 3200 Lecture 2（文字密集） | 285 | 52 页 | 106,343 → 28,150 字符（**−73.5%**） |
| 网络编程 03 Transport（图密集） | 39 | 37 页 | 6,856 → 6,614 字符（−3.5%） |

本期没动 `compress.py`，所以 `extract.json` / `page-map.json` / `simplified.pdf` 的
sha256 与 v0.1.0 完全一致 —— 上面这组数字是回归验证，不是新测的。

### 测试

- `tests/smoke_test.py` 108 → **193** 条
- `tests/http_test.py` 32 → **44** 条
- `tests/frontend_test.js` **新增 113 条**（零依赖的纯 Node 测试，从 `app.js` 里读真函数源码
  再跑；覆盖锚点回退三级规则、分栏比例换算、字号档位、CSS 几何不变量等）
- 每条 commit 都做了变异测试（故意把 bug 改回去，确认用例真的抓得到）

### 已知限制（新增部分）

- **MD 正文字号默认从 14px 变成 16px**，因此总结看起来比 v0.1.0 大一号。
  这是「MD 字号」这个功能的默认档位；想回到旧观感，把顶栏 `MD` 那组按到 14 即可
- 下载的 md 只在**同一台机器**上能重开（页面依赖本机仓库 + `~/.course-digest/` 数据）；
  换机器仍可读 md，但失去「点段落跳页」
- 分栏比例 / 字号存在浏览器 `localStorage`，换浏览器或清缓存会回默认值
- PDF 缩放会重渲可见页（285 页课件约 200–500ms，肉眼可感）—— 这是 PDF.js 的本征代价，不修复
- 窄窗口（≲1100px）顶栏控件会挤，移动端布局仍未优化

### 本期定的四条设计取舍

这四条不写进 [`DECISIONS.md`](./DECISIONS.md)（那里收录的是 v0.1.0 的 14 条架构决策），
但它们解释了本期几个「为什么这么选」：

1. **回程票里写 docId，不写 URL** —— 端口、pid、服务生命周期都是易腐的；往里写
   `http://127.0.0.1:PORT/...` 等于埋一张过期车票，而 docId 是稳定标识
2. **悬停气泡用原生 `title`，不自己画** —— 零依赖、屏幕阅读器天然支持；自绘 tooltip
   要额外处理移动端 hover、边界裁剪、ARIA，收益不抵成本。真正的主信号是段首那个 `▸`
3. **分栏拖拽不设最小宽度** —— 用户控制权 > 防误操作。手柄是独立的一列，拖到任一侧
   全屏之后手柄仍在，永远拉得回来
4. **字号按「内容载体」分两路** —— MD 是流式 HTML，改 CSS 变量即可（零重渲成本）；
   PDF 是 canvas，CSS 改不动，只能走 PDF.js 的 `scale` 重画。语义不同，所以两组独立控件

## [0.1.0] — 2026-09-19

**首个可用版本（MVP）**：把一份 PDF 课件变成**带页锚点的总结**，在本地浏览器里与 PDF 并排查看、点击段落跳到对应页。

### 能做什么

- 四步流程：`import` 纳入 PDF → `extract` 提文本并**自动合并渐进重复页** → `text` 输出压缩后正文 → agent 写总结 →
  `publish` 校验锚点、生成简化版 PDF、起服务、打开页面
- 前端：左侧 PDF 用 PDF.js 渲染进**自有 canvas**（带虚拟化，几百页也不爆内存），右侧 Markdown 总结；
  点总结任一段跳到对应页；标出「此处略过原 PX–PY」并可一键切回完整版
- 总结风格可配置（`~/.course-digest/style.md`）：语言 / 篇幅 / 实例密度 / 公式 / 复习导向 —— 用户临时提要求只生效一次，
  说「以后都…」才记住，说「恢复默认」即回默认值
- 服务按需启动、脱离终端常驻；数据与代码分离（`~/.course-digest/`），升级/重装不丢历史文档库

### 实测数字（真实课件）

| 课件 | 页数 | 压缩后 | 正文压缩 |
|---|---|---|---|
| CSC 3200 Lecture 2（文字密集） | 285 | 52 页 | 106,343 → 28,150 字符（**−73.5%**） |
| 网络编程 03 Transport（图密集） | 39 | 37 页 | 6,856 → 6,614 字符（−3.5%，重复页本来就少） |

两门不同课程、不同版式，**流程与代码零改动**。285 页课件的前端内存从 ≈1.7 GB 量级降到 ≈300 MB 量级。

### 安装

```bash
openclaw skills install git:https://github.com/wangjerry06/course-digest
# 或者 clone 到任意目录，cd 进仓库直接用 CLI
```

### 快速开始

对 agent 说一句：**「用 course-digest 总结这份课件：/路径/xxx.pdf」**（未显式点名时它不会介入）。

手动跑：

```bash
python3 -m course_digest import /path/to/lecture.pdf
python3 -m course_digest extract <docId>
python3 -m course_digest text <docId>          # 读压缩后的正文
# …… 写一份带 <!-- pages: N,M --> 锚点的总结到 /tmp/summary.md ……
python3 -m course_digest publish <docId> --summary /tmp/summary.md
```

### 环境

macOS；Python 3.10+；**零额外依赖** —— `pypdf` 与前端库（PDF.js / marked / KaTeX / highlight.js）都已本地 vendor，断网可用。

### 已知限制

- 只保证 macOS（Windows 未验证，明确不做）
- 扫描件 / 图片型 PDF 没有 OCR；这类课件靠**视觉补丁**（按需渲染几页交给模型看，需要 `swiftc`）
- 简化版只做「删掉重复页」，不做「多页重排合并成一页」
- 服务只绑 `127.0.0.1`，不开 CORS、不申请任何公网资源

### 设计取舍

14 条设计决策见 [`DECISIONS.md`](./DECISIONS.md)。最关键的三条：

1. **压缩只做算法，不让 LLM 编辑文本** —— 写总结本身就是"合并与提炼"，再让模型编辑一遍等于同一件事做两遍
2. **同时产出简化版 PDF，但完整版永不删** —— 删页是有损的，所以必须标出略过范围、能一键切回
3. **核心流程收敛成 CLI** —— 确定性的事交给命令，判断性的事留给 agent；换一个 agent harness 只需要一份 `SKILL.md`

### 许可证

MIT

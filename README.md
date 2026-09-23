# course-digest · 课件总结

把一份 PDF 课件变成**带页锚点的总结**，在浏览器里与 PDF **并排查看**：左边是课件（默认显示简化版），
右边是总结，**点总结里的任一段就跳到对应那几页**。

为课程学习者做的：两三百页的课件里往往大半是渐进重复页（后一页只比前一页多两行），
翻起来累、喂给模型又贵。这里先用算法删掉重复页，再写总结，并且**完整版永远保留**。

```
┌────────────────────────┬──────────────┐
│                        │  总结（MD）    │
│   PDF（简化版）   ←────│  ← 点击跳页    │
│                        │              │
└────────────────────────┴──────────────┘
```

## 环境

- **macOS**（MVP 只保证 macOS；Windows 明确不做）
- **Python 3.10+**（代码里用了 `str | None` 这类注解，运行时求值需要 3.10；本机实测 3.13），
  **零额外依赖** —— `pypdf`、PDF.js、marked、KaTeX、highlight.js 都已随仓库本地化，断网可用
- **用**这个工具不需要 Node / 构建工具 / 数据库。
  （只有想跑 `tests/frontend_test.js` 那套前端纯逻辑测试时才需要 Node 18+，且它零依赖；
  不想跑也无妨，不影响使用与 `SKILL.md` 那条链路。）

## 安装

```bash
git clone <本仓库地址> ~/course-digest      # 或直接把这个目录放哪都行
cd ~/course-digest
```

> `course_digest/web/fixture/*.pdf` 不入库（第三方课件版权），只在本地跑前端 mock 模式时才需要，
> 补法见 `course_digest/web/fixture/README.md`。

## 用法

### 方式一：交给 agent（推荐）

对本机的 agent（OpenClaw / Claude Code / Codex 等）说一句：

> **用 course-digest 总结这份课件：`/路径/lecture-02.pdf`**

agent 会读 `SKILL.md` 走四步：`import → extract → 读压缩正文写总结 → publish`，最后把页面打开。

它**只在被显式点名时**才会动（`SKILL.md` 里的触发门禁），不会因为你说到"课件"就自己跑起来。

### 方式二：自己动手

```bash
python3 -m course_digest import "~/Desktop/网络编程/03-transport.pdf"   # stdout 打出 docId
python3 -m course_digest extract 2026-09-19-03-transport                # 看压缩比
python3 -m course_digest text 2026-09-19-03-transport > /tmp/正文.txt    # 压缩后的正文
#   ……用 /tmp/正文.txt 写一份带 <!-- pages: N,M --> 锚点的总结到 /tmp/summary.md……
python3 -m course_digest publish 2026-09-19-03-transport --summary /tmp/summary.md
```

`publish` 会校验锚点、生成简化版 PDF、起服务并打开页面。

### 下载之后还能一条命令重开

页面右上角的「下载 MD」把总结存到本地时，文件尾会带一张**回程票**（一张 `docId` 的
HTML 注释 + 一句人读说明）。之后不论文件被放到哪、改成什么名字：

```bash
python3 -m course_digest open ~/Downloads/我的课程总结.md
```

一条命令就把并排页面重新打开 —— **不必记得 docId，也不必重新生成任何东西**。
（前提是同一台机器、`~/.course-digest/` 里的数据还在。换机器恢复不了页面，
但 md 本身仍是完整可读的总结。）

### 查看页面里能做什么

- **点总结的任一段 → 跳到对应那几页**；段/表/代码块左侧悬停会显一个小三角 `▸`，
  提示「这里可以点」（触摸设备上 `▸` 常显，因为没有 hover）
- **左右分栏可拖拽**：捏住中间那条分界线左右拉，比例按文档记住，刷新不丢
- **字号可调**：顶栏两组控件 —— `PDF` 那组调 PDF 缩放（80%–160%，五档），
  `MD` 那组调总结正文字号（12–24）；点中间那个数字即回到默认值
- **下载**：「下载 MD」存总结（带上面那张回程票），「下载 PDF」存简化版 PDF

## 命令卡

| 命令 | 作用 |
|---|---|
| `import <pdf>` | 把 PDF 纳入文档库，**stdout 只输出 docId** |
| `extract <docId>` | 提文本 + 压缩（渐进重复页只留最全的一张），落盘 `extract.json` |
| `text <docId> [--pages 1-30]` | 打印**压缩后**的正文（只含保留页，带页码标记） |
| `simplify <docId> [--drop "3,7-9"]` | 生成简化版 PDF + 页码映射（`publish` 内部也会调） |
| `publish <docId> --summary <md> [--drop ...]` | 校验锚点 → 落盘（尾部写回程票）→ 起服务 → 打开页面 |
| `open <docId>` | 重新打开已有文档（不重新生成任何东西） |
| `open <md路径>` | 用下载到本地的 `summary.md` 重开页面（读它的回程票拿 docId，随便改名都认） |
| `list` | 列出文档库（纯文件操作，不起服务） |
| `serve` / `stop` | 前台起服务 / 停服务（服务是**脱离终端**常驻的，关终端窗口杀不掉） |

## 数据与代码分开放

```
~/.course-digest/                 ← 用户数据（skill 升级永不碰，ADR-014）
├── docs/<docId>/
│   ├── source.pdf        原始课件（永不修改/删除）
│   ├── simplified.pdf    简化版（删掉重复页）
│   ├── extract.json      逐页文本 + 分组判定
│   ├── page-map.json     页码映射（原页 ↔ 简化版页、删了哪些页及原因）
│   ├── summary.md        总结（带页锚点；**尾部有由工具管理的回程票**，别手改）
│   └── meta.json         标题 / 页数 / 创建时间
├── style.md              总结偏好（语言、篇幅、实例密度、公式、复习导向）
├── port / pid            服务端口与进程号
└── 本仓库/                        ← 代码（可被升级覆盖）
    ├── course_digest/            CLI + 服务
    ├── course_digest/web/        前端（含本地 vendor 库）
    ├── tools/                    视觉补丁用的渲染源码
    ├── tests/                    冒烟测试（纯逻辑 + HTTP 层 + 前端纯函数）
    └── SKILL.md                  给 agent 的说明书
```

## 设计上的三个取舍

- **压缩只做算法，不让 LLM 编辑文本**（ADR-012）：写总结本身就是"合并与提炼"，再让模型编辑一遍是
  把同一件事做两遍，多花约 80% token。
- **同时给简化版 PDF**（ADR-013）：把重复页从 PDF 里也去掉，前端内存从 ≈1.7 GB 降到 ≈300 MB；
  但**必须**标出"此处略过原 PX–PY"并能一键切回完整版 —— 删页是有损操作，信任靠可追溯。
- **核心流程收敛成 CLI**（ADR-011）：确定性的事（提文本、压缩、落盘、起服务）交给命令，
  判断性的事（写总结、判无关页）留给 agent。这样换 harness 只需一份 `SKILL.md`。

全部 14 条设计决策的摘要在 [`DECISIONS.md`](./DECISIONS.md) —— 代码注释里引用的 `ADR-0xx` 编号在那里能查到。

## 已知限制

- 只保证 macOS；Windows 部署未验证（代码里已避免平台专有工具，但没机器可测）
- 扫描件/图片型 PDF 没有 OCR：这类课件文本层是空的，压缩不起作用，需要**视觉补丁**按需看页面图（见
  `references/visual-patch.md`；它需要本机有 `swiftc`，没有就只能在总结里如实标注"未做视觉补丁"）
- 简化版 PDF 不做"多页合并成一页"（那等于重做 PPT）
- 服务只绑 `127.0.0.1`，不申请任何公网资源，也不开 CORS
- **换一台机器恢复不了并排页面**：页面依赖本机仓库 + `~/.course-digest/` 里的数据。
  从 A 机器下载的 `summary.md` 拿到 B 机器上，`open` 会找不到对应文档 ——
  但 **md 文件本身仍是完整总结**，只是失去了"点段落跳页"这一层
- 分栏拖拽、字号调整、PDF 缩放都是**按文档**记在浏览器 `localStorage` 里的；
  换浏览器或清缓存会回到默认值

## 第二版规划

- **导出 PDF**：把总结 MD 直接导成 PDF
- **拖拽分栏双击重置**：现在只能手动把比例拖回去
- **PDF 端响应式布局**：窄窗口下顶栏控件会挤，移动端布局也还没优化
- 算法侧（改动前必须先落合成 PDF 回归语料）：非相邻整页去重、页眉页脚剔除

> v0.1.1 已交付的「锚点可点击提示」「分栏可拖拽」「字号调整」「下载 PDF」原在本节，
> 现已完成，见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 版本历史

见 [`CHANGELOG.md`](./CHANGELOG.md)（当前 **v0.1.1** — 无 breaking change）。

## 许可证

MIT

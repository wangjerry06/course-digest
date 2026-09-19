# 版本历史

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

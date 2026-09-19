# fixture — 前端 mock 模式的数据

`?mock=1` 时前端只读这里的 `mock.json`，不发任何 `/api` 请求（M4 的服务还没写出来时，
也能用 `python3 -m http.server` 单独自测前端）。

## 两个 PDF 不入仓库（第三方版权）

`sample-full.pdf` / `sample-simplified.pdf` 是**真实课件**及其简化产物，属于第三方材料，
本仓库将来会公开发布（ADR-009），所以它们被 `.gitignore` 排除。

**克隆后跑 mock 模式之前，先补这两个文件**：

```bash
cd course_digest/web/fixture
cp "/Users/wangjian/Desktop/CSC3200/lecture-02-cpp-fundamentals.pdf" sample-full.pdf
cp ~/.course-digest/docs/2026-09-18-lecture-02-cpp-fundamentals/simplified.pdf sample-simplified.pdf
```

（第二条要求本地已对该课件跑过 `import` + `extract` + `simplify`。）

这两份文件**只是开发/手测用的假数据**，不属于 skill 运行所需 —— skill 正式跑起来时，
PDF 走 `/api/doc/<id>/pdf?version=...`，数据在 `~/.course-digest/`（ADR-014）。

## mock.json

- `page_map` 是**真跑出来的**产物（285 → 52 页、233 条 `dropped`、48 段 `dropped_ranges`），
  不是手写的 —— 「此处略过原 PX–PY」提示条和三级回退规则都靠它验证
- `meta` 的字段值也与真实课件一致
- `summary_md` 是示例文案，但**锚点落在真实页码上**，且覆盖三类情形：
  指向保留页 / 指向已删页（测回退）/ 跨多个页号
- 字段名与 `GET /api/doc/<id>` 的返回体一致（见 `实施方案.md` §三），
  只有 `pdf_full` / `pdf_simplified` 是本地文件路径而非 API URL

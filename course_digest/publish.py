"""publish / open / list：文档落盘与呈现（ADR-011 CLI 契约）。

    publish <docId> --summary <md路径> [--drop "3,7-9"]
        校验锚点 → simplify → 落盘 summary.md → 补全 meta.json → ensure_server → 开浏览器
    open <docId|summary.md 路径>    已有文档：ensure_server + 打开，**不重新生成任何东西**
    list            列文档库，**纯文件操作，不起服务**（ADR-011：按需）

meta.json 的**唯一最终写入者**是 publish：import 只写初版，之后由这里补全
simplified_pages / has_simplified / title；id 与 created 保持 import 时的值不变
（created 是「创建时间」，不随 publish 刷新）。

summary.md 的口径同样收敛在这里：落盘时在正文尾部追加回程票 footer
（只写 docId 不写 URL —— 端口会变、pid 会换，docId 稳定；供 `open <md路径>` 恢复
页面）。footer 的格式与读写见 `footer.py`。读入先 strip 再写，重复 publish 不叠加；
校验与覆盖率统计一律在剥离后的正文上做。

编辑器保存（`POST /api/doc/<id>/summary`，见 serve.py）不另起一套写法，而是复用
下面的 `_write_summary_md` —— 「唯一最终写入者」升级为「唯一写入函数」：口径只有
一份，谁写都幂等。
"""

import json
import re
import sys
from pathlib import Path

from . import paths
from . import serve
from . import simplify
# 回程票 footer 三件套：格式与读写搬到独立模块（serve 出口补票也要用，见 footer.py）
from .footer import build_footer, parse_footer_doc_id, strip_footer

# <!-- pages: 5,6 -->：内容必须只有 "pages:" 加一串数字
_ANCHOR_RE = re.compile(r"^\s*pages\s*:\s*(\d+(?:\s*,\s*\d+)*)\s*$")
_COMMENT_RE = re.compile(r"<!--(.*?)-->", re.DOTALL)
# 分块：空行切段
_BLANK_RE = re.compile(r"\n[ \t]*\n")
_HR_RE = re.compile(r"^[-*_]{3,}$")

# meta.json 的规范字段与顺序（对外契约：改这里等于改前端读法）
_META_FIELDS = ("id", "title", "created", "original_pages", "simplified_pages", "has_simplified")

# 覆盖率低于这个值就额外告警
_COVERAGE_WARN = 50.0

# 未锚定段落的预览长度，以及 stderr 里最多列几条
_PREVIEW_LEN = 30
_UNANCHORED_MAX = 10

# 标题截断长度（取首个非空页的前两行）
_TITLE_MAX = 80


def _fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


# ----------------------------------------------------------------------
# 锚点校验
# ----------------------------------------------------------------------

def _leading_anchor(block: str):
    """块首是不是一个合法锚点注释；是则返回 match。"""
    m = _COMMENT_RE.match(block)
    if not m:
        return None
    return _ANCHOR_RE.match(m.group(1))


def validate_summary(text: str, original_pages: int):
    """返回 (anchors, errors)。anchors 元素含 start/end/pages。

    规则：注释格式合法、页码为数字、落在 [1, original_pages]、且后面紧跟非空内容。
    不含 "pages" 的普通注释放行（它只是注释，不是锚点）。
    """
    anchors = []
    errors = []

    for m in _COMMENT_RE.finditer(text):
        raw = m.group(1)
        if "pages" not in raw.lower():
            continue                      # 不是锚点注释
        am = _ANCHOR_RE.match(raw)
        if not am:
            errors.append(
                f"锚点注释格式不合法：<!--{raw}-->（应为 <!-- pages: 5,6 -->）"
            )
            continue
        pages = [int(x) for x in am.group(1).split(",")]
        out_of_range = [p for p in pages if p < 1 or p > original_pages]
        if out_of_range:
            errors.append(
                f"锚点页码越界：<!-- pages: {am.group(1)} --> 不在 1..{original_pages} 内"
                f"（越界页号 {out_of_range}）"
            )
            continue
        anchors.append({"start": m.start(), "end": m.end(), "pages": pages})

    # 每个锚点后面必须紧跟非空内容
    for i, a in enumerate(anchors):
        stop = anchors[i + 1]["start"] if i + 1 < len(anchors) else len(text)
        if not _has_content(text[a["end"]:stop]):
            errors.append(
                f"锚点 <!-- pages: {','.join(str(p) for p in a['pages'])} --> "
                f"后面没有内容（锚点必须紧接它标注的那一段）"
            )

    return anchors, errors


def _has_content(segment: str) -> bool:
    """分段里除了空行和分隔线之外还有东西吗。"""
    for line in segment.splitlines():
        s = line.strip()
        if s and not _HR_RE.match(s):
            return True
    return False


def _split_blocks(text: str):
    """按空行切块，产出 (块文本, 块在 text 里的起始偏移)。

    与 `_BLANK_RE.split(text)` 的切法完全一致，只是多带一个偏移量 ——
    算未锚定段落的**起始行号**要用它。
    """
    pos = 0
    for m in _BLANK_RE.finditer(text):
        yield text[pos:m.start()], pos
        pos = m.end()
    yield text[pos:], pos


def _preview(block: str, limit: int = _PREVIEW_LEN) -> str:
    """单行预览：折叠空白、截断，超长时加省略号（让人知道后面还有）。"""
    one = re.sub(r"\s+", " ", block).strip()
    return one[:limit] + ("…" if len(one) > limit else "")


def anchor_coverage(text: str) -> tuple[int, int, list[dict]]:
    """返回 (带锚点段落, 总段落, 未锚定段落列表)。

    段落 = 空行分隔的正文块，不含标题、分隔线与锚点注释本身。
    「带锚点」= 该块紧跟在锚点注释之后 —— 前端只给带 data-pages 的元素绑跳转，
    所以只有这样的段落是真的可点的。

    unanchored 每项 `{"line": 起始行号(1 起), "preview": 前 30 字符}`：
    publish 靠它告诉 agent「改哪里」，而不是只扔一个百分比出来让人盲改。
    """
    total = anchored = 0
    prev_is_anchor = False
    unanchored: list[dict] = []

    for block, start in _split_blocks(text):
        s = block.strip()
        if not s:
            continue
        if _leading_anchor(s):
            if _COMMENT_RE.match(s).end() == len(s):
                prev_is_anchor = True      # 整块就是一个锚点注释
                continue
            total += 1                     # 注释与正文同块，也算带锚点
            anchored += 1
            prev_is_anchor = False
            continue
        if s.startswith("#") or _HR_RE.match(s):
            prev_is_anchor = False         # 标题 / 分隔线不算段落，也断开锚点
            continue
        total += 1
        if prev_is_anchor:
            anchored += 1
        else:
            unanchored.append({
                "line": text.count("\n", 0, start) + 1,
                "preview": _preview(s),
            })
        prev_is_anchor = False

    return anchored, total, unanchored


# ----------------------------------------------------------------------
# 三级回退（与前端 app.js 的 resolveAnchor 同一套规则）
# ----------------------------------------------------------------------

def resolve_fallback(first: int, page_map: dict) -> int | None:
    total = page_map["total_original"]
    kept = lambda p: page_map["orig_to_simp"].get(str(p)) is not None
    for p in range(first, total + 1):
        if kept(p):
            return p
    for p in range(first - 1, 0, -1):
        if kept(p):
            return p
    return None


# ----------------------------------------------------------------------
# title / meta
# ----------------------------------------------------------------------

def title_from_extract(extract: dict) -> str | None:
    """取首个非空页的**前两行**，用 " — " 连接、截断到 ~80 字符。

    首个非空页就是封面，第一行是课程名、第二行才是「Lecture 2: C++ Fundamentals」
    这类副标题 —— 只取第一行会把副标题丢掉（2026-09-19 起改成两行）。
    只有一个非空行时不加分隔符。
    """
    for page in extract.get("pages", []):
        text = (page.get("text") or "").strip()
        if not text:
            continue
        lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
        lines = [line for line in lines if line][:2]
        if lines:
            return " — ".join(lines)[:_TITLE_MAX]
    return None


def _write_meta(doc_dir: Path, doc_id: str, old: dict, page_map: dict, title: str | None):
    """按固定字段与顺序重写 meta.json；id / created 沿用旧值。"""
    new = {
        "id": old.get("id") or doc_id,
        "title": title or old.get("title") or doc_id,
        "created": old.get("created") or "",
        "original_pages": old.get("original_pages"),
        "simplified_pages": page_map["total_simplified"],
        "has_simplified": True,
    }
    # 契约外的字段不丢（当前没有，留着防将来加字段被这里抹掉）
    for key, value in old.items():
        if key not in _META_FIELDS:
            new[key] = value

    tmp = doc_dir / "meta.json.tmp"
    tmp.write_text(json.dumps(new, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(doc_dir / "meta.json")
    return new


# ----------------------------------------------------------------------
# summary.md 落盘（publish 与编辑器保存共用同一处口径）
# ----------------------------------------------------------------------

def _write_summary_md(doc_dir: Path, body: str, doc_id: str) -> None:
    """把规范形正文 + 回程票 footer 原子地写到 docs/<doc_id>/summary.md。

    publish 与编辑器保存（`POST /api/doc/<id>/summary`）共用的**唯一写入口径**：
    - publish：body = strip_footer(读入) + 锚点校验通过
    - editor ：body = strip_footer(请求体) + 锚点校验通过

    调用方必须传**已经剥过 footer 的规范形正文** —— footer 由这里按 doc_id 统一重建，
    所以「同一个 docId 反复写」天然幂等（不叠加、不漂）。写入走 tmp → rename
    原子替换（红线 4）：半途中断也不会留下半截 summary.md。

    **只碰 summary.md**：PDF / page-map / extract / meta 是 publish 的事，这里不伸手。
    """
    dest = (doc_dir / "summary.md").resolve()
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_text(body + build_footer(doc_id), encoding="utf-8")
    tmp.replace(dest)


# ----------------------------------------------------------------------
# publish
# ----------------------------------------------------------------------

def run(args) -> int:
    try:
        doc_dir = paths.doc_dir(args.doc_id)
    except ValueError as exc:
        return _fail(str(exc))
    if not doc_dir.is_dir():
        return _fail(f"doc not found: {args.doc_id}")

    meta = serve._read_json(doc_dir / "meta.json")
    if meta is None:
        return _fail(f"cannot read {doc_dir / 'meta.json'}")
    extract = serve._read_json(doc_dir / "extract.json")
    if extract is None:
        return _fail(f"cannot read {doc_dir / 'extract.json'}; run extract first")

    original_pages = int(meta.get("original_pages") or 0)
    if original_pages <= 0:
        return _fail("meta.json 缺 original_pages；先跑 import")

    summary_path = Path(args.summary).expanduser()
    if not summary_path.is_file():
        return _fail(f"summary 文件不存在：{summary_path}")
    text = summary_path.read_text(encoding="utf-8")

    # 0) 读入即剥离回程票：锚点校验与覆盖率统计都在**剥离后**的正文上做，
    #    否则 footer 会被当成无锚段落拉低覆盖率。同路径重发也走这条路 → 天然幂等。
    body = strip_footer(text)

    # 1) 锚点校验：不合格就报错退出，不静默通过
    anchors, errors = validate_summary(body, original_pages)
    if errors:
        for err in errors:
            print(f"error: {err}", file=sys.stderr)
        return _fail(f"summary.md 锚点校验未通过（{len(errors)} 处），已中止")

    # 2) simplify（直接 import 调用，不 spawn 子进程）
    try:
        page_map = simplify.simplify_doc(doc_dir, args.drop)
    except simplify.SimplifyError as exc:
        return _fail(str(exc))
    print(
        f"simplified: {page_map['total_original']} → {page_map['total_simplified']} 页"
        f"（删 {len(page_map['dropped'])} 页 / {len(page_map['dropped_ranges'])} 段）",
        file=sys.stderr,
    )

    # 3) 锚点指向已删页 → 不算错，但记 warning（前端有回退规则）
    for a in anchors:
        first = a["pages"][0]
        if page_map["orig_to_simp"].get(str(first)) is None:
            target = resolve_fallback(first, page_map)
            if target is None:
                print(
                    f"warning: 锚点 pages={a['pages']} 指向的页在简化版里都已删，"
                    f"且整份都没有保留页可回退 → 前端只高亮不滚动",
                    file=sys.stderr,
                )
            else:
                print(
                    f"warning: 锚点 pages={a['pages']} 的首个页号 P{first} 在简化版里已删 "
                    f"→ 前端将回退到 P{target}",
                    file=sys.stderr,
                )

    # 4) 锚点覆盖率：不满 100% 就把「哪里没锚点」列出来，agent 才能一轮修完
    anchored, total, unanchored = anchor_coverage(body)
    pct = (100.0 * anchored / total) if total else 0.0
    print(f"锚点覆盖率：带锚点段落 {anchored} / 总段落 {total} = {pct:.0f}%", file=sys.stderr)
    if pct < 100 and unanchored:
        print(
            f"warning: 以下 {len(unanchored)} 段没有锚点（行号指向 summary.md 原文，"
            f"预览截到 {_PREVIEW_LEN} 字符），逐个补 <!-- pages: N --> 后重发即可：",
            file=sys.stderr,
        )
        for item in unanchored[:_UNANCHORED_MAX]:
            print(f"  L{item['line']}: {item['preview']}", file=sys.stderr)
        if len(unanchored) > _UNANCHORED_MAX:
            print(f"  …等 {len(unanchored)} 段", file=sys.stderr)
    if pct < _COVERAGE_WARN:
        print(
            f"warning: 锚点覆盖率 < {_COVERAGE_WARN:.0f}% —— 联动的可用性直接取决于锚点密度，"
            f"建议给更多段落补 <!-- pages: ... -->",
            file=sys.stderr,
        )

    # 5) summary.md 落盘：正文 + 回程票 footer（docId 的真相源是命令行参数，
    #    不信任旧 footer 里写的值）；footer 不回流到 agent 输入的临时 md
    _write_summary_md(doc_dir, body, args.doc_id)
    print(f"summary.md -> {(doc_dir / 'summary.md').resolve()}", file=sys.stderr)

    # 6) meta.json 补全（publish 是唯一最终写入者）
    title = title_from_extract(extract)
    if title is None:
        print("warning: extract.json 里没有非空页，title 沿用旧值", file=sys.stderr)
    new_meta = _write_meta(doc_dir, args.doc_id, meta, page_map, title)
    print(f"meta.json: title={new_meta['title']!r} "
          f"simplified_pages={new_meta['simplified_pages']}", file=sys.stderr)

    # 7) 起服务（若未起）+ 打开页面
    try:
        port = serve.ensure_server()
    except RuntimeError as exc:
        return _fail(str(exc))
    url = serve.open_browser(args.doc_id, port)
    print(url)                     # stdout 只放约定产物
    return 0


# ----------------------------------------------------------------------
# open
# ----------------------------------------------------------------------

def open_doc(args) -> int:
    # 参数可以是 docId，也可以是**下载到本地的 summary.md 路径**（回程票的配套：
    # 没有这条，回程票是死的）。只认注释内容，不要求文件名叫 summary.md ——
    # 用户下载后随便改名都能开。
    raw = args.target
    path = Path(raw).expanduser()
    if path.is_file() and path.suffix.lower() == ".md":
        doc_id = parse_footer_doc_id(path.read_text(encoding="utf-8"))
        if doc_id is None:
            return _fail(
                "该 md 没有 course-digest 回程票（不是本工具生成的，或 footer 已被删）"
            )
    elif path.suffix.lower() == ".md" or path.parent != Path("."):
        # 看着像路径但不是（存在的）md 文件：给一句人话，别退化成「invalid docId」
        return _fail(f"文件不存在：{path}")
    else:
        doc_id = raw

    try:
        doc_dir = paths.doc_dir(doc_id)
    except ValueError as exc:
        return _fail(str(exc))
    if not doc_dir.is_dir():
        return _fail(f"doc not found: {doc_id}")

    # 不重新生成任何东西，只确认该有的都在
    missing = [
        name
        for name in ("summary.md", "page-map.json", "simplified.pdf")
        if not (doc_dir / name).is_file()
    ]
    if missing:
        return _fail(
            f"文档尚未 publish（缺 {', '.join(missing)}）；先跑 "
            f"publish {doc_id} --summary <md路径>"
        )

    try:
        port = serve.ensure_server()
    except RuntimeError as exc:
        return _fail(str(exc))
    url = serve.open_browser(doc_id, port)
    print(url)
    return 0


# ----------------------------------------------------------------------
# list（纯文件操作，绝不起服务）
# ----------------------------------------------------------------------

def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - len(text))


def run_list(_args=None) -> int:
    docs = serve.list_docs()
    if not docs:
        print("(文档库为空)", file=sys.stderr)
        return 0

    rows = []
    for d in docs:
        original = d.get("pages")
        simplified = d.get("simplified_pages")
        pages = f"{original} → {simplified}" if simplified else f"{original}"
        rows.append([
            d["id"],
            d["title"],
            pages,
            "有" if d["has_summary"] else "无",
            d["created"],
        ])

    headers = ["docId", "标题", "页数", "summary", "created"]
    widths = [
        max(len(headers[i]), *(len(r[i]) for r in rows))
        for i in range(len(headers))
    ]
    print("  ".join(_pad(h, widths[i]) for i, h in enumerate(headers)).rstrip())
    for r in rows:
        print("  ".join(_pad(c, widths[i]) for i, c in enumerate(r)).rstrip())
    return 0

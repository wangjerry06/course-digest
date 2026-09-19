"""simplify <docId> [--drop "..."]：生成简化版 PDF + 页码映射。

这是**纯读命令**：只读 docs/<docId>/extract.json 里的 groups，不重算相似度判定
（自己重算会和 extract 的 kept_page 不一致，导致简化版 PDF 与总结锚点错位），
用 pypdf 按页号取子集生成 simplified.pdf，并落盘 page-map.json（ADR-013）。
本命令不写除 simplified.pdf / page-map.json 之外的任何文件 —— 阈值属于 extract：

    python3 -m course_digest extract <docId> --threshold 0.9
    python3 -m course_digest simplify <docId>

保留规则：
1. 每个 group 只保留 kept_page
2. 不在任何 group 的页全部保留
3. is_progressive_dup=true 的页删除，reason="dup"
4. --drop 指定的页额外删除，reason="manual"（agent 判定的无关页，F1）

一页同时命中 3 和 4 时记 "dup"：算法判定在先，而 "manual" 要严格等于「算法本会保留、
只因 agent 判定而删掉」的页，这样前端的两种文案才不会互相矛盾。

原 PDF 绝不修改、不删除、不移动（ADR-013：完整版始终保留）。
"""

import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter

from . import paths


def parse_drop(spec: str, total: int) -> list[int]:
    """解析 --drop 规格："3,7,9-11" → 升序去重的页号列表；非法或越界抛 ValueError。"""
    pages: set[int] = set()
    for raw in spec.split(","):
        token = raw.strip()
        if not token:
            continue
        lo_s, sep, hi_s = token.partition("-")
        try:
            if sep:
                lo, hi = int(lo_s), int(hi_s)
            else:
                lo = hi = int(token)
        except ValueError:
            raise ValueError(f"invalid page spec {token!r} in --drop (want '3' or '9-11')")
        if lo > hi:
            raise ValueError(f"invalid range {token!r} in --drop (from > to)")
        if lo < 1 or hi > total:
            raise ValueError(
                f"page spec {token!r} out of range in --drop: valid pages are 1-{total}"
            )
        pages.update(range(lo, hi + 1))
    return sorted(pages)


def merge_ranges(dropped: list[dict]) -> list[dict]:
    """把 dropped 合并成区间；只有 reason 相同且页号连续才可合并。"""
    ranges: list[dict] = []
    for item in dropped:
        last = ranges[-1] if ranges else None
        if (
            last is not None
            and item["reason"] == last["reason"]
            and item["page"] == last["to"] + 1
        ):
            last["to"] = item["page"]
        else:
            ranges.append(
                {"from": item["page"], "to": item["page"], "reason": item["reason"]}
            )
    return ranges


def build_page_map(total: int, groups: list[dict], manual: set[int]) -> dict:
    """按保留规则算出 page-map.json 的结构；全部页被删时抛 ValueError。"""
    in_group: set[int] = set()
    kept: set[int] = set()
    for g in groups:
        in_group.update(g["pages"])
        kept.add(g["kept_page"])

    # 规则 1 + 2：保留页 + 不属于任何 group 的页。余下的都是算法判定的重复页。
    retained = kept | {p for p in range(1, total + 1) if p not in in_group}
    dup_dropped = {p for p in range(1, total + 1) if p not in retained}

    all_dropped = dup_dropped | manual
    if len(all_dropped) >= total:
        raise ValueError(
            f"refusing to write an empty PDF: all {total} pages are dropped"
        )

    orig_to_simp: dict[str, int | None] = {}
    simp_to_orig: dict[str, int] = {}
    for page in range(1, total + 1):
        if page in all_dropped:
            orig_to_simp[str(page)] = None
        else:
            simp_to_orig[str(len(simp_to_orig) + 1)] = page
            orig_to_simp[str(page)] = len(simp_to_orig)

    dropped = [
        {"page": p, "reason": "dup" if p in dup_dropped else "manual"}
        for p in sorted(all_dropped)
    ]

    return {
        "total_original": total,
        "total_simplified": len(simp_to_orig),
        "orig_to_simp": orig_to_simp,
        "simp_to_orig": simp_to_orig,
        "dropped": dropped,
        "dropped_ranges": merge_ranges(dropped),
    }


def _write_subset(source: Path, orig_pages: list[int], dest: Path) -> None:
    """把 source 的指定页（1-based 原页号）按顺序写成新 PDF。

    只复制页对象，不做任何渲染 —— 页尺寸与文字可选中性由原内容流原样保留。
    """
    writer = PdfWriter()
    # 必须在源文件句柄关闭前写盘：writer 里的页对象仍指向 reader 的流。
    with open(source, "rb") as src_fh:
        reader = PdfReader(src_fh)
        for page in orig_pages:
            writer.add_page(reader.pages[page - 1])
        with open(dest, "wb") as out_fh:
            writer.write(out_fh)


def _fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def run(args) -> int:
    try:
        doc_dir = paths.doc_dir(args.doc_id)
    except ValueError as exc:
        return _fail(str(exc))

    source = doc_dir / "source.pdf"
    extract_path = doc_dir / "extract.json"
    if not source.is_file():
        return _fail(f"source.pdf not found for doc '{args.doc_id}'")
    if not extract_path.is_file():
        return _fail(f"extract.json not found for doc '{args.doc_id}'; run extract first")

    # 纯读：extract.json 是判定结果的唯一来源，simplify 不重算、也不改写它。
    try:
        result = json.loads(extract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(f"cannot read {extract_path}: {exc}")

    total = len(result["pages"])
    try:
        with open(source, "rb") as fh:
            source_pages = len(PdfReader(fh).pages)
    except Exception as exc:
        return _fail(f"cannot read {source}: {exc}")
    if source_pages != total:
        return _fail(
            f"source.pdf has {source_pages} pages but extract.json describes {total}; "
            f"re-run extract"
        )

    try:
        manual = set(parse_drop(args.drop, total)) if args.drop else set()
    except ValueError as exc:
        return _fail(str(exc))

    try:
        page_map = build_page_map(total, result["groups"], manual)
    except ValueError as exc:
        return _fail(str(exc))

    # 要写进 PDF 的原页号直接由映射反查得出，保证 PDF 与 page-map 不可能对不上。
    kept_orig = [
        page_map["simp_to_orig"][str(i)]
        for i in range(1, page_map["total_simplified"] + 1)
    ]

    # 约束：写盘前先校验一致性。
    non_null = sum(1 for v in page_map["orig_to_simp"].values() if v is not None)
    if not (
        non_null == page_map["total_simplified"] == len(kept_orig) == len(page_map["simp_to_orig"])
    ):
        return _fail(
            f"inconsistent page-map: {non_null} kept entries vs "
            f"total_simplified={page_map['total_simplified']} vs {len(kept_orig)} pages to write"
        )

    # 先写临时文件、校验通过再原子替换 —— 重复执行幂等，失败不留半成品。
    tmp_pdf = doc_dir / "simplified.pdf.tmp"
    try:
        _write_subset(source, kept_orig, tmp_pdf)
        with open(tmp_pdf, "rb") as fh:
            actual = len(PdfReader(fh).pages)
        if actual != page_map["total_simplified"]:
            raise RuntimeError(
                f"written PDF has {actual} pages, expected {page_map['total_simplified']}"
            )
        tmp_pdf.replace(doc_dir / "simplified.pdf")
    except Exception as exc:
        tmp_pdf.unlink(missing_ok=True)
        return _fail(f"failed to write simplified.pdf: {exc}")

    tmp_map = doc_dir / "page-map.json.tmp"
    tmp_map.write_text(
        json.dumps(page_map, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp_map.replace(doc_dir / "page-map.json")

    by_reason = {"dup": 0, "manual": 0}
    for item in page_map["dropped"]:
        by_reason[item["reason"]] += 1
    print(
        f"total_original={page_map['total_original']} "
        f"total_simplified={page_map['total_simplified']} "
        f"dropped={len(page_map['dropped'])} "
        f"(dup={by_reason['dup']} manual={by_reason['manual']}) "
        f"dropped_ranges={len(page_map['dropped_ranges'])}"
    )
    print(f"simplified.pdf -> {doc_dir / 'simplified.pdf'}")
    print(f"page-map.json -> {doc_dir / 'page-map.json'}")
    return 0

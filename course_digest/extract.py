"""extract <docId> [--threshold 0.85] [--out <path>]：逐页提文本 + 渐进页压缩。

- 落盘 docs/<docId>/extract.json（simplify 的唯一输入来源）
- stdout 只打印摘要（stats + 前几个 progressive group），不打印完整 JSON
- --out 额外把完整 JSON 写到指定路径（供调试/自测取用）
"""

import json
import sys
from pathlib import Path

from pypdf import PdfReader

from . import compress
from . import paths

# stdout 摘要里打印的 progressive group 数量上限。
_SUMMARY_PROGRESSIVE = 5


def extract_page_texts(source: Path) -> list[str]:
    """逐页提取文本；无文本层的页返回 ""。"""
    with open(source, "rb") as fh:
        reader = PdfReader(fh)
        texts = []
        for page in reader.pages:
            try:
                text = page.extract_text()
            except Exception:
                text = None
            texts.append(text or "")
    return texts


def build_doc_extract(doc_dir: Path, threshold: float) -> tuple[dict, list[int]]:
    """读 source.pdf → 压缩 → 落盘 extract.json，返回 (结果, 被校验拆出的页号)。

    extract.json 只有这一个写入口径，避免序列化方式漂移。拆出的页号只用于告警，
    不进 JSON。
    """
    source = doc_dir / "source.pdf"
    result, split_pages = compress.build_extract_with_splits(
        source, extract_page_texts(source), threshold
    )
    (doc_dir / "extract.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result, split_pages


def _warn_guard_splits(split_pages: list[int]) -> None:
    """组内一致性校验真拆了页才告警（正常轮次恒为 0，此时 stderr 不得有输出）。"""
    if not split_pages:
        return
    pages = ", ".join(f"P{p}" for p in split_pages)
    print(
        f"warning: coverage guard split {len(split_pages)} page(s) out of their "
        f"groups: {pages} (text not fully covered by the kept page; ADR-012 safety net)",
        file=sys.stderr,
    )


def _print_summary(result: dict) -> None:
    stats = result["stats"]
    print(
        f"total_pages={stats['total_pages']} groups={stats['groups']} "
        f"kept_pages={stats['kept_pages']} kept_override={stats['kept_override']} "
        f"chars_before={stats['chars_before']} chars_after={stats['chars_after']}"
    )
    progressive = [g for g in result["groups"] if g["reason"] == "progressive"]
    for g in progressive[:_SUMMARY_PROGRESSIVE]:
        print(
            f"progressive group={g['group']} pages={g['pages']} "
            f"kept_page={g['kept_page']} diff_lines={g['diff_lines']}"
        )


def run(args) -> int:
    doc_dir = paths.doc_dir(args.doc_id)
    source = doc_dir / "source.pdf"
    if not source.is_file():
        print(f"error: source.pdf not found for doc '{args.doc_id}'", file=sys.stderr)
        return 1

    # 落盘：simplify 只读这里，绝不重算。
    result, split_pages = build_doc_extract(doc_dir, args.threshold)

    if args.out:
        out_path = Path(args.out).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"full json -> {out_path}", file=sys.stderr)

    # 告警在摘要之前：stdout 是交付契约（6 个字段），异常信息一律走 stderr。
    _warn_guard_splits(split_pages)
    _print_summary(result)
    return 0

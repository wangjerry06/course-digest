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


def _extract_page_texts(source: Path) -> list[str]:
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

    texts = _extract_page_texts(source)
    result = compress.build_extract(source, texts, args.threshold)

    # 落盘：simplify 只读这里，绝不重算。
    extract_path = doc_dir / "extract.json"
    extract_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    if args.out:
        out_path = Path(args.out).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"full json -> {out_path}", file=sys.stderr)

    _print_summary(result)
    return 0

"""import <pdf路径>：把 PDF 纳入文档库。

- 生成 docId（YYYY-MM-DD-<slug>，重名加 -2/-3 后缀）
- 建 ~/.course-digest/docs/<docId>/
- 拷贝 PDF 为 source.pdf（用拷贝，不动用户原文件）
- 写初版 meta.json
- stdout 只输出 docId（一行）
"""

import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

from pypdf import PdfReader

from . import paths

# 截断上限：slug 最多 40 字符。
_SLUG_MAX = 40


def slugify(name: str) -> str:
    """小写、非字母数字转 '-'、去首尾 '-'、截断到 40 字符。"""
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:_SLUG_MAX]


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def generate_doc_id(pdf_stem: str) -> str:
    """返回一个尚不存在的 docId；若 base 已存在则加 -2/-3 后缀。"""
    slug = slugify(pdf_stem)
    base = f"{_today()}-{slug}"
    candidate = base
    n = 2
    while (paths.DOCS_DIR / candidate).exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def run(args) -> int:
    src = Path(args.pdf_path).expanduser().resolve()
    if not src.is_file():
        print(f"error: not a file: {src}", file=sys.stderr)
        return 1

    doc_id = generate_doc_id(src.stem)
    doc_dir = paths.doc_dir(doc_id)
    doc_dir.mkdir(parents=True, exist_ok=False)

    dest = doc_dir / "source.pdf"
    shutil.copy2(src, dest)

    try:
        with open(dest, "rb") as fh:
            original_pages = len(PdfReader(fh).pages)
    except Exception as exc:  # 拷贝成功但读不出页数时不应留半成品
        shutil.rmtree(doc_dir, ignore_errors=True)
        print(f"error: cannot read page count from {src}: {exc}", file=sys.stderr)
        return 1

    meta = {
        "id": doc_id,
        "title": src.stem,
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "original_pages": original_pages,
        "has_simplified": False,
    }
    (doc_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"source.pdf -> {dest}", file=sys.stderr)

    # stdout 只输出 docId，供脚本取用。
    print(doc_id)
    return 0

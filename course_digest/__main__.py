"""argparse 子命令分发。"""

import argparse
import sys

from . import extract
from . import import_pdf
from . import simplify


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="course_digest",
        description="本地课件总结查看器",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_import = sub.add_parser("import", help="把 PDF 纳入文档库（stdout 输出 docId）")
    p_import.add_argument("pdf_path", help="PDF 文件路径")
    p_import.set_defaults(func=import_pdf.run)

    p_extract = sub.add_parser(
        "extract", help="逐页提文本 + 渐进页压缩（落盘 extract.json）"
    )
    p_extract.add_argument("doc_id", help="import 产出的 docId")
    p_extract.add_argument(
        "--threshold",
        type=float,
        default=0.85,
        help="相邻页相似度合并阈值（默认 0.85）",
    )
    p_extract.add_argument(
        "--out",
        metavar="PATH",
        help="额外把完整 JSON 写到该路径（调试用）",
    )
    p_extract.set_defaults(func=extract.run)

    p_simplify = sub.add_parser(
        "simplify",
        help="读 extract.json 生成 simplified.pdf + page-map.json（不改原 PDF）",
    )
    p_simplify.add_argument("doc_id", help="import 产出的 docId")
    p_simplify.add_argument(
        "--drop",
        metavar="SPEC",
        help='额外删除的页码（agent 判定的无关页），如 "3,7,9-11"',
    )
    p_simplify.set_defaults(func=simplify.run)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

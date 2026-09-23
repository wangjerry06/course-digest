"""argparse 子命令分发。"""

import argparse
import sys

from . import extract
from . import import_pdf
from . import publish
from . import serve
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

    p_text = sub.add_parser(
        "text", help="打印压缩后正文（只含保留页，带页码标记）—— agent 写总结读这个"
    )
    p_text.add_argument("doc_id", help="import 产出的 docId")
    p_text.add_argument(
        "--pages",
        metavar="SPEC",
        help='只输出这些页，如 "1-5,9"（默认全部保留页）',
    )
    p_text.set_defaults(func=extract.run_text)

    p_publish = sub.add_parser(
        "publish", help="校验锚点 → simplify → 落盘 summary/meta → 起服务并打开页面"
    )
    p_publish.add_argument("doc_id", help="import 产出的 docId")
    p_publish.add_argument("--summary", required=True, metavar="MD路径", help="总结 Markdown 路径")
    p_publish.add_argument(
        "--drop",
        metavar="SPEC",
        help='额外删除的页码（agent 判定的无关页），如 "3,7,9-11"；透传给 simplify',
    )
    p_publish.set_defaults(func=publish.run)

    p_open = sub.add_parser("open", help="打开已有文档（ensure server + 开浏览器，不重新生成）")
    p_open.add_argument(
        "target",
        metavar="docId|md路径",
        help="已 publish 的 docId，或 summary.md 文件路径",
    )
    p_open.set_defaults(func=publish.open_doc)

    p_list = sub.add_parser("list", help="列出文档库（纯文件操作，不起服务）")
    p_list.set_defaults(func=publish.run_list)

    p_serve = sub.add_parser("serve", help="只起服务（前台）")
    p_serve.set_defaults(func=serve.serve)

    p_stop = sub.add_parser("stop", help="按 pid 文件停掉服务")
    p_stop.set_defaults(func=serve.stop)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

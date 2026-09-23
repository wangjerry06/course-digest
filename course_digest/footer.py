"""回程票 footer：summary.md 尾部的「重开线索」，格式与读写都在这里。

把 summary.md 下载到本地后，用户要能用一条命令重开并排页面：

    python3 -m course_digest open ~/Downloads/我的课程总结.md

md 里只写 **docId**、不写 URL —— 端口会变、pid 会换、服务会停，URL 是易腐的；
docId 稳定（ADR-014：数据目录与代码分离，docId 是文档在 `~/.course-digest/docs/`
下的稳定标识）。

format 分两段：
    ① HTML 注释（机器可读、渲染不可见，`key=value` 便于将来加字段）
    ② `---` + `<sub>` 人读段（下载后翻到底就知道怎么重开）

三个函数都不碰 IO，可全量单测；格式常量只在 build_footer 里定义一次。

为什么单独成一个模块（而不是留在 publish 里）：`publish` 已经 import `serve`，
`serve` 又要用这三个函数来统一补票，若 `serve` 再 import `publish` 就会循环导入。
"""

import os
import re

# 回程票人读段里的 open 命令按平台给真实的那个（ADR-016）：Windows 没有
# python3（常是 Store 占位假命令），posix 上 python 未必存在。
# 只影响展示文案；机器可读段只有 docId，两平台格式完全一致。
_OPEN_CMD = (
    "python -m course_digest open" if os.name == "nt"
    else "python3 -m course_digest open"
)

# 回程票 footer 的机器可读行（写 docId，**不写 URL**：URL 易腐，docId 稳定）
_FOOTER_ANCHOR_RE = re.compile(r"<!--\s*course-digest:\s*docId=([^\s\n]+)[^>]*-->")


def _iter_footer_matches(text: str):
    return _FOOTER_ANCHOR_RE.finditer(text)


def parse_footer_doc_id(text: str) -> str | None:
    """取**最后一个**回程票注释里的 docId；没有则 None。

    取最后一个：正文里万一出现同形态的注释（概率≈0），真正生效的仍是尾部的票。
    """
    found = None
    for m in _iter_footer_matches(text):
        found = m
    return found.group(1) if found else None


def strip_footer(text: str) -> str:
    """剥掉尾部回程票，返回**规范形正文**：尾部空白规范化、以单个 \\n 结尾。

    规范形是幂等的前提。落盘口径是「规范形 + build_footer」，若剥离后正文的
    尾部形态随是否带 footer 而变（无票时原文可能没有尾换行，带票时有多余空行），
    两次 publish 的字节就会漂，「连发两次指纹不变」直接失败。
    """
    last = None
    for m in _iter_footer_matches(text):
        last = m
    body = text[: last.start()] if last else text
    body = body.rstrip()
    return body + "\n" if body else ""


def build_footer(doc_id: str) -> str:
    """拼回程票 footer。格式常量只在这一处定义，改格式改这里。

    两段：① HTML 注释（机器可读、渲染不可见，`key=value` 便于将来加字段）
         ② `---` + `<sub>` 人读段（下载后翻到底就知道怎么重开）
    人读段如实注明依赖本机仓库 + 数据目录 —— md 拷到别的机器就恢复不了页面，
    此时 md 本身仍是完整总结。诚实比万能重要。
    """
    return (
        f"\n<!-- course-digest: docId={doc_id} -->\n"
        "\n---\n"
        f"<sub>📄 由 course-digest 生成 · docId `{doc_id}` ·\n"
        f"重新打开页面：`{_OPEN_CMD} 本md文件路径`"
        "（需本机仓库与 ~/.course-digest 数据）</sub>\n"
    )

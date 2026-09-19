"""路径常量集中于此。其他模块一律从这里取路径，不得硬编码路径。"""

import re
from pathlib import Path

# 用户数据目录（与 skill 代码分离，ADR-014）。跨平台：基于 $HOME，禁止 /Users/... 硬编码。
DATA_DIR = Path.home() / ".course-digest"

# 文档库目录：每个 docId 一个子目录。
DOCS_DIR = DATA_DIR / "docs"

# 服务实际端口 / 服务进程号（ADR-010：agent 读 port 构造 URL，stop 读 pid 停服务）。
PORT_FILE = DATA_DIR / "port"
PID_FILE = DATA_DIR / "pid"

# 前端静态资源目录（skill 包内，ADR-014；服务只读不写）。
WEB_DIR = Path(__file__).resolve().parent / "web"

# docId 白名单（防路径遍历）。
DOC_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def doc_dir(doc_id: str) -> Path:
    """返回 docId 对应的文档目录，并做格式白名单校验。"""
    if not DOC_ID_RE.match(doc_id):
        raise ValueError(f"invalid docId: {doc_id!r}")
    return DOCS_DIR / doc_id

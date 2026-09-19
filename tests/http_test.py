"""HTTP 层冒烟测试：真起一个服务（内存内、随机端口），检查前端要的每个请求。

为什么要有这个文件（2026-09-19 的一次真实事故）：
    index.html / app.js 里写了相对路径（`./app.js`、`./vendor/...`），
    页面在 /doc/<docId> 下时被浏览器解析成 /doc/app.js、/doc/vendor/...，
    而 SPA 路由把 /doc/* 一律返回 index.html —— 模块脚本拿到 text/html 被拒执行，
    前端一个请求都不发，页面永远停在「加载中…」，而且**服务端日志全是 200**，
    从日志完全看不出问题。

    纯逻辑冒烟测试（smoke_test.py）抓不到这类问题：它不碰 HTTP。
    所以这里补一层：**静态检查 + 真发请求**。

运行：cd <repo root> && python3 tests/http_test.py
"""

import json
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from course_digest import paths, serve  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "course_digest" / "web"


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"ok: {name}")


class QuietHandler(serve.Handler):
    """测试期间不要刷请求日志。"""

    def log_message(self, fmt, *args):
        pass


def fetch(base, path):
    """返回 (状态码, Content-Type, 正文)。4xx/5xx 不抛异常。"""
    req = urllib.request.Request(base + path)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, res.headers.get("Content-Type", ""), res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), exc.read()


def make_doc(docs_dir: Path, doc_id: str) -> None:
    d = docs_dir / doc_id
    d.mkdir(parents=True)
    (d / "meta.json").write_text(
        json.dumps(
            {
                "id": doc_id,
                "title": "测试文档",
                "created": "2026-09-19T00:00:00+08:00",
                "original_pages": 2,
                "simplified_pages": 1,
                "has_simplified": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (d / "summary.md").write_text("<!-- pages: 1 -->\n内容\n", encoding="utf-8")
    (d / "page-map.json").write_text(
        json.dumps(
            {
                "total_original": 2,
                "total_simplified": 1,
                "orig_to_simp": {"1": 1, "2": None},
                "simp_to_orig": {"1": 1},
                "dropped": [{"page": 2, "reason": "dup"}],
                "dropped_ranges": [{"from": 2, "to": 2, "reason": "dup"}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (d / "source.pdf").write_bytes(b"%PDF-1.4\n")
    (d / "simplified.pdf").write_bytes(b"%PDF-1.4\n")


# ----------------------------------------------------------------------
# 1) 静态检查：前端不许再出现相对路径（这次事故的直接原因）
# ----------------------------------------------------------------------

def check_no_relative_assets():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    rel_html = re.findall(r'(?:src|href)\s*=\s*"(\./[^"]*)"', html)
    check("index.html 没有 ./ 相对资产路径", rel_html == [])

    js = (WEB / "app.js").read_text(encoding="utf-8")
    bad_import = re.findall(r"""(?:from|import)\s+['"](\.{1,2}/[^'"]+)['"]""", js)
    check("app.js 没有 ./ 相对 import", bad_import == [])
    bad_fetch = re.findall(r"""fetch\(\s*['"](\.{1,2}/[^'"]+)['"]""", js)
    check("app.js 没有 ./ 相对 fetch", bad_fetch == [])


# ----------------------------------------------------------------------
# 2) 真发请求：前端声明的每个资产都要 200 + 正确 MIME
# ----------------------------------------------------------------------

def check_http(base: str, doc_id: str):
    def expect(path, status, ctype_prefix=None):
        got_status, got_type, _ = fetch(base, path)
        check(
            f"{path} → {status}" + (f" ({ctype_prefix})" if ctype_prefix else ""),
            got_status == status
            and (ctype_prefix is None or got_type.startswith(ctype_prefix)),
        )

    # 页面本体
    expect(f"/doc/{doc_id}", 200, "text/html")
    expect("/", 200, "text/html")
    expect("/health", 200, "application/json")

    # 页面里声明的资产（从 index.html 抓，避免手写清单漏项）
    html = (WEB / "index.html").read_text(encoding="utf-8")
    assets = re.findall(r'(?:src|href)\s*=\s*"(/[^"]*)"', html)
    check("index.html 声明了资产", len(assets) >= 5)
    for path in assets:
        ctype = {
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".css": "text/css",
        }.get(Path(path).suffix, None)
        expect(path, 200, ctype)

    # app.js 里要加载的 worker 与 mock 数据
    expect("/vendor/pdfjs/pdf.worker.min.mjs", 200, "text/javascript")
    expect("/fixture/mock.json", 200, "application/json")

    # 数据接口
    status, ctype, body = fetch(base, f"/api/doc/{doc_id}")
    check("/api/doc/<id> → 200 json", status == 200 and ctype.startswith("application/json"))
    check("返回体字段与前端约定一致",
          sorted(json.loads(body).keys()) ==
          ["meta", "page_map", "pdf_full", "pdf_simplified", "summary_md"])
    expect(f"/api/doc/{doc_id}/pdf?version=simplified", 200, "application/pdf")
    expect(f"/api/doc/{doc_id}/pdf?version=full", 200, "application/pdf")
    expect("/api/docs", 200, "application/json")

    # 关键回归：错的路径必须"大声失败"，不能静默返回 HTML
    expect("/doc/app.js", 404)                    # 相对路径残留 → 不能当 docId
    expect("/doc/style.css", 404)
    expect("/doc/vendor/pdfjs/pdf.min.mjs", 404)
    expect("/doc/no-such-doc", 404)
    expect("/api/doc/..%2f..%2fetc%2fpasswd", 403)
    expect("/api/doc/bad%20id", 400)

    # 类型正确性：静态 JS/CSS 绝不能是 text/html（这次事故的形态）
    for path in ["/app.js", "/style.css", "/vendor/pdfjs/pdf.min.mjs"]:
        _, got_type, _ = fetch(base, path)
        check(f"{path} 不是 text/html", not got_type.startswith("text/html"))


def main() -> None:
    check_no_relative_assets()

    saved_docs = paths.DOCS_DIR
    tmp = Path(tempfile.mkdtemp(prefix="cd-http-test-"))
    docs = tmp / "docs"
    doc_id = "2026-09-19-demo-doc"
    make_doc(docs, doc_id)
    paths.DOCS_DIR = docs

    srv = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        check_http(base, doc_id)
    finally:
        srv.shutdown()
        srv.server_close()
        paths.DOCS_DIR = saved_docs

    print("ALL PASS")


if __name__ == "__main__":
    main()

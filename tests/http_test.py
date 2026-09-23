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


def fetch_headers(base, path):
    """返回 (状态码, 小写化的响应头字典)。用来断言「没有某个头」。"""
    req = urllib.request.Request(base + path)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            status, headers = res.status, res.headers
    except urllib.error.HTTPError as exc:
        status, headers = exc.code, exc.headers
    return status, {k.lower(): v for k, v in headers.items()}


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
    (d / "summary.md").write_text(
        "<!-- pages: 1 -->\n内容\n\n"
        f"<!-- course-digest: docId={doc_id} -->\n"
        "\n---\n<sub>📄 由 course-digest 生成</sub>\n",
        encoding="utf-8",
    )
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


def check_buttons_wired():
    """按钮存在 ≠ 按钮能用：id 改了 / 忘了绑事件都是静默失效（与「前端资产用相对路径」那类事故同一个形态：静默失效）。

    只做静态接线检查（HTML 里有这个 id、app.js 里引用了它），不值得起浏览器。
    """
    html = (WEB / "index.html").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    for btn in ("btn-download", "btn-pdf"):
        check(f"index.html 有 #{btn}", f'id="{btn}"' in html)
        check(f"app.js 引用了 #{btn}", f"#{btn}" in js)


def check_pdf_download_route(base: str, doc_id: str):
    """v0.1.1「下载 PDF」按钮走的就是这条路由，单独把契约钉住。"""
    path = f"/api/doc/{doc_id}/pdf?version=simplified"
    status, ctype, body = fetch(base, path)
    check(f"{path} → 200", status == 200)
    check("简化版 PDF → Content-Type application/pdf", ctype.startswith("application/pdf"))
    check("简化版 PDF 有内容", body.startswith(b"%PDF"))

    status, headers = fetch_headers(base, path)
    check("简化版 PDF 响应无 Accept-Ranges（本项目不做 206）",
          status == 200 and "accept-ranges" not in headers)

    # 完整版同样无 Accept-Ranges；且不接受未知 version
    _, full_headers = fetch_headers(base, f"/api/doc/{doc_id}/pdf?version=full")
    check("完整版 PDF 响应同样无 Accept-Ranges", "accept-ranges" not in full_headers)
    check("未知 version → 400",
          fetch(base, f"/api/doc/{doc_id}/pdf?version=weird")[0] == 400)

    # 回程票 footer 落盘后，服务必须**原样透传**（前端只渲染，不解析也不该丢）
    _, _, payload = fetch(base, f"/api/doc/{doc_id}")
    served = json.loads(payload)["summary_md"]
    on_disk = (paths.DOCS_DIR / doc_id / "summary.md").read_text(encoding="utf-8")
    check("summary_md 与磁盘逐字节一致（含回程票 footer）", served == on_disk)
    check("透传内容里带着回程票", "course-digest: docId=" in served)


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
    check_buttons_wired()

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
        check_pdf_download_route(base, doc_id)
    finally:
        srv.shutdown()
        srv.server_close()
        paths.DOCS_DIR = saved_docs

    print("ALL PASS")


if __name__ == "__main__":
    main()

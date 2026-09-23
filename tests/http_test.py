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

import hashlib
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

from course_digest import footer, paths, publish, serve  # noqa: E402

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


# 一份「v0.1.1 之前 publish 出来」的老文档正文：尾部**没有**回程票
LEGACY_SUMMARY = "<!-- pages: 1 -->\n老文档正文\n\n<!-- pages: 2 -->\n第二段正文\n"


def make_doc(docs_dir: Path, doc_id: str, summary: str | None = None) -> Path:
    """造一个「已 publish 过」的文档目录。

    summary 传 None 时用**真实落盘口径** `strip_footer(正文) + build_footer(docId)` 写盘
    —— 这样磁盘上的文件就是 v0.1.1 publish 的真实产物，而不是手写的近似 footer。
    传显式 summary 时用来模拟磁盘上的任意形态（例如存量老文档：没有票）。
    """
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
    if summary is None:
        summary = footer.strip_footer("<!-- pages: 1 -->\n内容\n\n") + footer.build_footer(doc_id)
    (d / "summary.md").write_text(summary, encoding="utf-8")
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
    return d


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

    # 已 publish 的文档（磁盘 = 规范形正文 + 一张票）经服务出口后必须**逐字节不变**
    # （出口也会跑一遍 strip+build，但对已成规范形的文件是幂等的）
    _, _, payload = fetch(base, f"/api/doc/{doc_id}")
    served = json.loads(payload)["summary_md"]
    on_disk = (paths.DOCS_DIR / doc_id / "summary.md").read_text(encoding="utf-8")
    check("summary_md 与磁盘逐字节一致（含回程票 footer）", served == on_disk)
    check("透传内容里带着回程票", "course-digest: docId=" in served)


def check_summary_footer_outlet(base: str, real_id: str):
    """出口补票契约：`GET /api/doc/<id>` 的 summary_md 恒为「正文 + 恰好一张回程票」。

    为什么要有这层（v0.1.1 的真实缺陷）：回程票只在 `publish` 时写入磁盘，而 `open`
    不重新生成任何东西 —— 于是 v0.1.1 之前 publish 的**存量文档**磁盘上没有票，前端
    「下载 MD」下到的文件就没票，`open <md路径>` 重开页面这条功能对它们全部失效。
    修法是在服务出口统一补票，**只读不写**（用户数据只能由 publish 写）。
    """
    # 1) 存量文档：磁盘上确实没票 → API 返回带票
    legacy_id = "2026-09-18-legacy-doc"
    legacy_dir = make_doc(paths.DOCS_DIR, legacy_id, summary=LEGACY_SUMMARY)
    disk = legacy_dir / "summary.md"
    check("存量文档：磁盘上确实没有票",
          footer.parse_footer_doc_id(disk.read_text(encoding="utf-8")) is None)
    before = hashlib.sha256(disk.read_bytes()).hexdigest()

    status, _, payload = fetch(base, f"/api/doc/{legacy_id}")
    check("存量文档（磁盘无票）→ 200", status == 200)
    served = json.loads(payload)["summary_md"]
    check("存量文档：summary_md 带票", "course-digest: docId=" in served)
    check("存量文档：票里的 docId 正确", footer.parse_footer_doc_id(served) == legacy_id)
    check("存量文档：票恰好一张（不叠加）", served.count("course-digest: docId=") == 1)

    # 2) 副作用检查：这个请求**没写盘**（磁盘 sha256 前后一致）
    after = hashlib.sha256(disk.read_bytes()).hexdigest()
    check("存量文档：请求不写盘（磁盘 sha256 前后一致）", before == after)

    # 3) 幂等：同一 doc 连请求两次，返回体完全一致
    _, _, payload2 = fetch(base, f"/api/doc/{legacy_id}")
    check("存量文档：连请求两次返回完全一致（幂等）", payload == payload2)

    # 4) footer 不干扰正文：正文逐字节相等 + 段落数 / 锚点数不变
    served_body = footer.strip_footer(served)
    disk_body = footer.strip_footer(disk.read_text(encoding="utf-8"))
    check("footer 不干扰正文：剥离后正文逐字节一致", served_body == disk_body)
    check("footer 不干扰正文：锚点数量不变",
          served_body.count("<!-- pages:") == disk_body.count("<!-- pages:"))
    check("footer 不干扰正文：段落数 / 带锚点段落数不变",
          publish.anchor_coverage(served_body)[:2] == publish.anchor_coverage(disk_body)[:2])

    # 5) 已带票的真实产物：API 返回与磁盘逐字节一致（且连请求两次也一致）
    on_disk = (paths.DOCS_DIR / real_id / "summary.md").read_text(encoding="utf-8")
    _, _, p3 = fetch(base, f"/api/doc/{real_id}")
    _, _, p4 = fetch(base, f"/api/doc/{real_id}")
    check("已带票文档：API 返回与磁盘逐字节一致", json.loads(p3)["summary_md"] == on_disk)
    check("已带票文档：连请求两次也完全一致", p3 == p4)


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

    # 硬规矩：测试绝不碰真实的 ~/.course-digest/ —— 把四个路径全重定向到临时目录
    saved = (paths.DATA_DIR, paths.DOCS_DIR, paths.PORT_FILE, paths.PID_FILE)
    tmp = Path(tempfile.mkdtemp(prefix="cd-http-test-"))
    docs = tmp / "docs"
    doc_id = "2026-09-19-demo-doc"
    make_doc(docs, doc_id)
    paths.DATA_DIR = tmp
    paths.DOCS_DIR = docs
    paths.PORT_FILE = tmp / "port"
    paths.PID_FILE = tmp / "pid"

    srv = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        check_http(base, doc_id)
        check_pdf_download_route(base, doc_id)
        check_summary_footer_outlet(base, doc_id)
    finally:
        srv.shutdown()
        srv.server_close()
        paths.DATA_DIR, paths.DOCS_DIR, paths.PORT_FILE, paths.PID_FILE = saved

    print("ALL PASS")


if __name__ == "__main__":
    main()

"""HTTP 服务：把 ~/.course-digest/docs/ 下的文档发给浏览器（ADR-002/010/011）。

只绑 127.0.0.1（ADR-002：不出本机、不触发防火墙弹窗），只用标准库
（ThreadingHTTPServer），零额外依赖。

寻址必须与前端对齐：index.html / app.js 用的是**根路径相对寻址**
（`./app.js`、`./vendor/**`、`./fixture/mock.json`），所以 web/ 下的文件要服务在
**根下同名路径**上，不能只挂在 /static/。

    GET /                                        → web/index.html
    GET /doc/<id>                                → web/index.html（SPA 路由）
    GET /<web 下的其余文件>                        → web/<path>
    GET /static/<path>                           → web/<path>（兼容别名）
    GET /health                                  → {"ok": true}
    GET /api/docs                                → 文档列表
    GET /api/doc/<id>                            → 前端约定的返回体（字段名见 doc_payload）；
                                                   其中 summary_md **恒为「正文 + 恰好一张回程票」**
    GET /api/doc/<id>/pdf?version=full|simplified → PDF 文件

回程票（footer）只在 `publish` 时写入磁盘，而 `open` 不重新生成任何东西 —— 于是
v0.1.1 之前 publish 的**存量文档**磁盘上没有票，前端「下载 MD」拿到的东西没票，
`open <md路径>` 重开页面这条功能对它们全部失效。修法是在这个出口统一补票：读到的
summary 一律走 `strip_footer + build_footer`。**只读不写** —— 用户数据只能由 publish
写；对已 publish 过的文档，磁盘本就是「正文 + 票」，再套一次逐字节等价（幂等）。

安全：docId 白名单 → 400；所有拼出来的路径 resolve() 后必须落在各自
前缀内 → 403；不发 CORS 头；只处理 GET。
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import paths
from .footer import build_footer, strip_footer

HOST = "127.0.0.1"
PORT_START = 7317
PORT_TRIES = 20
HEALTH_TIMEOUT = 5.0        # ensure_server 轮询 /health 的上限
STOP_WAIT = 3.0             # stop 等进程退出的上限

# 代码仓库根目录：detached 子进程要在这里跑 `python3 -m course_digest`
REPO_ROOT = Path(__file__).resolve().parent.parent


# ----------------------------------------------------------------------
# 文档读取（纯文件操作，不起服务；list / api 共用）
# ----------------------------------------------------------------------

def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def list_docs() -> list[dict]:
    """文档列表，按 created 倒序（新的在前）。"""
    out: list[dict] = []
    if not paths.DOCS_DIR.is_dir():
        return out
    for entry in sorted(paths.DOCS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        meta = _read_json(entry / "meta.json") or {}
        out.append(
            {
                "id": entry.name,
                "title": meta.get("title") or entry.name,
                "created": meta.get("created") or "",
                "pages": meta.get("original_pages"),
                "simplified_pages": meta.get("simplified_pages"),
                "has_summary": (entry / "summary.md").is_file(),
            }
        )
    out.sort(key=lambda d: d["created"], reverse=True)
    return out


class NotPublished(Exception):
    """文档还没 publish，缺必要产物 —— 报 404 并说清缺什么。"""

    def __init__(self, missing: list[str]):
        super().__init__("missing: " + ", ".join(missing))
        self.missing = missing


def doc_payload(doc_dir: Path) -> dict:
    """拼 `GET /api/doc/<id>` 的返回体（字段名与前端 web/fixture/mock.json 严格一致）。

    契约：返回的 `summary_md` **恒为「规范形正文 + 恰好一张回程票」** —— 出口统一
    补票，存量文档（磁盘上没票）也能拿到带票的下载件。这里**只读不写**：用户数据
    只能由 publish 写。对已被 publish 过的文档，磁盘内容就是
    `strip_footer(x) + build_footer(docId)`，再套一次同样的变换结果逐字节不变（幂等）。
    """
    doc_id = doc_dir.name
    missing = [
        name
        for name in ("summary.md", "page-map.json", "simplified.pdf")
        if not (doc_dir / name).is_file()
    ]
    if missing:
        raise NotPublished(missing)

    meta = _read_json(doc_dir / "meta.json") or {"id": doc_id}
    raw = (doc_dir / "summary.md").read_text(encoding="utf-8")
    summary = strip_footer(raw) + build_footer(doc_id)
    page_map = _read_json(doc_dir / "page-map.json")

    return {
        "meta": meta,
        "summary_md": summary,
        "page_map": page_map,
        "pdf_full": f"/api/doc/{doc_id}/pdf?version=full",
        "pdf_simplified": f"/api/doc/{doc_id}/pdf?version=simplified",
    }


# ----------------------------------------------------------------------
# 请求处理
# ----------------------------------------------------------------------

# Python 的 mimetypes 在个别版本上不认 .mjs，显式登记 —— ESM 被发成
# application/octet-stream 时浏览器会直接拒绝执行。
for _ext, _type in (
    (".mjs", "text/javascript"),
    (".js", "text/javascript"),
    (".css", "text/css"),
    (".json", "application/json"),
    (".map", "application/json"),
    (".wasm", "application/wasm"),
    (".bcmap", "application/octet-stream"),
    (".pfb", "application/octet-stream"),
    (".ttf", "font/ttf"),
    (".woff2", "font/woff2"),
    (".svg", "image/svg+xml"),
):
    import mimetypes
    mimetypes.add_type(_type, _ext)


class Handler(BaseHTTPRequestHandler):
    server_version = "course-digest"
    protocol_version = "HTTP/1.1"      # 允许多个 vendor 小文件复用连接

    # ---- 只处理 GET：任何带请求体的方法一律拒绝 ----
    def do_POST(self):
        self._method_not_allowed()

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_POST

    def _method_not_allowed(self):
        # 请求体一律不读；但连接上可能还留着没读完的字节，会被当成下一个请求
        # 解析（keep-alive 下会串包）—— 所以这里直接关连接。
        self.close_connection = True
        body = json.dumps({"error": "only GET is allowed"}).encode("utf-8")
        self._send(405, body, "application/json; charset=utf-8",
                   extra={"Allow": "GET", "Connection": "close"})

    # ---- 统一出口：一定带 Content-Length（HTTP/1.1 keep-alive 的前提）----
    def _send(self, status, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 不接受 MIME 嗅探：类型发了什么就是什么（错就让它错得明显）
        self.send_header("X-Content-Type-Options", "nosniff")
        # 不发 Access-Control-Allow-Origin：本服务不开放给其他源
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass                     # 浏览器提前断开（切页/刷新）不算错

    def _json(self, status: int, obj, extra: dict | None = None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        headers = {"Cache-Control": "no-store"}
        headers.update(extra or {})
        self._send(status, body, "application/json; charset=utf-8", headers)

    def _error(self, status: int, message: str):
        self._json(status, {"error": message})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/health":
            return self._json(200, {"ok": True})
        if path == "/api/docs":
            return self._json(200, list_docs())
        if path.startswith("/api/doc/"):
            return self._api_doc(path[len("/api/doc/"):], query)
        if path.startswith("/api/"):
            return self._error(404, "unknown api endpoint")

        # SPA：只有 / 与 /doc/<id>（允许结尾斜杠）返回 index.html。
        # 更深一层（/doc/app.js、/doc/vendor/...）一律 404 —— 这类请求只可能来自
        # 「页面里写了相对路径」，必须大声失败，不能静默回一份 HTML（2026-09-19 踩过）。
        if path == "/":
            return self._serve_static("index.html")
        if path.startswith("/doc/"):
            rest = path[len("/doc/"):].strip("/")
            if not rest or "/" in rest:
                return self._error(404, "not found (SPA 路由只认 /doc/<id>)")
            if not paths.DOC_ID_RE.match(rest):
                return self._error(400, "invalid docId")
            # 文档不存在就直接 404。否则 /doc/app.js 这种「相对路径残留」会被当成 docId，
            # 静默返回一份 HTML，前端又卡在「加载中…」（2026-09-19 的坑）。
            if not (paths.DOCS_DIR / rest).is_dir():
                return self._error(404, f"doc not found: {rest}")
            return self._serve_static("index.html")

        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        return self._serve_static(path.lstrip("/"))

    # ---- /api/doc/<id> 与 /api/doc/<id>/pdf ----

    def _api_doc(self, rest: str, query: dict):
        doc_id = rest.split("/")[0]
        # 1) 白名单：格式不合法直接 400
        if not paths.DOC_ID_RE.match(doc_id):
            return self._error(400, f"invalid docId: {doc_id!r}")
        # 2) 解析后必须仍在 docs/ 前缀内，否则 403
        #    （正则允许 ".."，这一道是真正拦住路径遍历的地方）
        docs_root = paths.DOCS_DIR.resolve()
        doc_dir = (paths.DOCS_DIR / doc_id).resolve()
        if doc_dir != docs_root and docs_root not in doc_dir.parents:
            return self._error(403, "forbidden")

        tail = rest[len(doc_id):].strip("/")
        if tail == "":
            return self._doc_json(doc_dir)
        if tail == "pdf":
            return self._pdf(doc_dir, query)
        return self._error(404, "unknown api endpoint")

    def _doc_json(self, doc_dir: Path):
        if not doc_dir.is_dir():
            return self._error(404, "doc not found")
        try:
            return self._json(200, doc_payload(doc_dir))
        except NotPublished as exc:
            return self._error(
                404, f"doc not published yet (missing {', '.join(exc.missing)}); run publish first"
            )

    def _pdf(self, doc_dir: Path, query: dict):
        version = (query.get("version") or ["simplified"])[0]
        names = {"full": "source.pdf", "simplified": "simplified.pdf"}
        if version not in names:
            return self._error(400, f"unknown version: {version!r} (want full|simplified)")
        target = (doc_dir / names[version]).resolve()
        if doc_dir not in target.parents:
            return self._error(403, "forbidden")
        if not target.is_file():
            return self._error(404, f"{names[version]} not found")

        # 取舍：不做 206 —— 不发 Accept-Ranges，让 PDF.js 整份下载。
        # 半吊子的字节范围比没有更糟；全量 200 一定是对的。
        data = target.read_bytes()
        self._send(200, data, "application/pdf", {"Cache-Control": "no-store"})

    # ---- 静态资源：web/ 只读 ----

    def _serve_static(self, rel: str):
        if not rel:
            return self._error(404, "not found")
        base = paths.WEB_DIR.resolve()
        target = (base / rel).resolve()
        if target != base and base not in target.parents:
            return self._error(403, "forbidden")
        if not target.is_file():
            return self._error(404, "not found")

        import mimetypes
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        # no-cache：改完前端刷新就能拿到新的，不用清浏览器缓存
        self._send(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})


# ----------------------------------------------------------------------
# 端口 / pid 文件
# ----------------------------------------------------------------------

def _read_int(path: Path) -> int | None:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def port_file() -> int | None:
    return _read_int(paths.PORT_FILE)


def pid_file() -> int | None:
    return _read_int(paths.PID_FILE)


def _install_files(port: int) -> None:
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    paths.PORT_FILE.write_text(f"{port}\n", encoding="utf-8")
    paths.PID_FILE.write_text(f"{os.getpid()}\n", encoding="utf-8")


def _remove_files_if_ours(port: int | None, pid: int | None) -> None:
    """只删还指向自己的文件 —— 免得把后来那个服务的信息抹掉。"""
    for path, expected in ((paths.PORT_FILE, port), (paths.PID_FILE, pid)):
        if expected is None:
            continue
        try:
            if path.is_file() and path.read_text(encoding="utf-8").strip() == str(expected):
                path.unlink()
        except OSError:
            pass


# ----------------------------------------------------------------------
# 起服务（前台）
# ----------------------------------------------------------------------

def _bind(port_start: int = PORT_START, tries: int = PORT_TRIES):
    last_exc = None
    for port in range(port_start, port_start + tries):
        try:
            return ThreadingHTTPServer((HOST, port), Handler), port
        except OSError as exc:
            last_exc = exc
    raise RuntimeError(
        f"no free port in {port_start}..{port_start + tries - 1}: {last_exc}"
    )


def serve(_args=None) -> int:
    server, port = _bind()
    _install_files(port)

    # stdout 只放约定产物：这一行就是调用方要的 URL
    print(f"http://{HOST}:{port}", flush=True)
    print(f"serving {paths.WEB_DIR} (pid {os.getpid()})", file=sys.stderr, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        _remove_files_if_ours(port, os.getpid())
    return 0


# ----------------------------------------------------------------------
# ensure_server：探活 + 按需启动（ADR-010）
# ----------------------------------------------------------------------

def _health_ok(port: int, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/health", timeout=timeout) as res:
            if res.status != 200:
                return False
            return json.loads(res.read().decode("utf-8")).get("ok") is True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def launch_server():
    """启动**脱离父进程**的服务进程（ADR-010 的可替换钩子）。

    以后想换 launchd / Windows 任务计划，只改这一个函数，别处不动。
    """
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        )
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(
        [sys.executable, "-m", "course_digest", "serve"],
        cwd=str(REPO_ROOT),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kwargs,
    )


def ensure_server() -> int:
    """服务活着就返回端口，否则起一个并等它就绪。超时抛 RuntimeError。"""
    port = port_file()
    if port is not None and _health_ok(port):
        return port

    proc = launch_server()
    deadline = time.time() + HEALTH_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"服务进程启动后立即退出（exit={proc.returncode}）；"
                f"可用 `python3 -m course_digest serve` 前台跑一次看报错"
            )
        port = port_file()
        if port is not None and _health_ok(port):
            return port
        time.sleep(0.1)
    raise RuntimeError(f"服务启动超时（{HEALTH_TIMEOUT:.0f}s）")


def open_browser(doc_id: str, port: int) -> str:
    """打开浏览器（跨平台用 webbrowser，不用 macOS 的 open 命令）。"""
    url = f"http://{HOST}:{port}/doc/{doc_id}"
    webbrowser.open(url)
    return url


# ----------------------------------------------------------------------
# stop
# ----------------------------------------------------------------------

def _process_command(pid: int) -> str | None:
    """返回 pid 的命令行；进程不存在返回 None；无法判定返回 ""。"""
    try:
        if os.name == "nt":
            # tasklist 拿不到命令行，用 PowerShell 查；查不到就返回 ""（= 不杀）
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"],
                capture_output=True, text=True, timeout=5,
            )
        else:
            out = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True, text=True, timeout=5,
            )
    except (OSError, subprocess.SubprocessError):
        return ""
    text = (out.stdout or "").strip()
    if text:
        return text
    # ps 对不存在的 pid 返回空 + 非 0 退出码
    return None if out.returncode != 0 else ""


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop(_args=None) -> int:
    pid = pid_file()
    if pid is None:
        print("服务未在运行（没有 pid 文件）", file=sys.stderr)
        _remove_files_if_ours(port_file(), None)
        return 0

    command = _process_command(pid)
    if command is None:
        print(f"服务未在运行（pid {pid} 已不存在，pid 文件是陈旧的）", file=sys.stderr)
        _remove_files_if_ours(port_file(), pid)
        return 0

    # pid 会被系统复用：命令行不像本程序就**不要杀**
    if not command or ("course_digest" not in command and "serve" not in command):
        print(
            f"warning: pid {pid} 的命令行不像本程序，未终止（pid 可能已被复用）："
            f"\n  {command or '(无法读取命令行)'}"
            f"\n  已清理陈旧的 pid/port 文件；如确认是残留服务请手动 kill {pid}",
            file=sys.stderr,
        )
        _remove_files_if_ours(port_file(), pid)
        return 1

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        print(f"warning: 发送 SIGTERM 失败：{exc}", file=sys.stderr)
        return 1

    deadline = time.time() + STOP_WAIT
    while time.time() < deadline:
        if not _pid_alive(pid):
            _remove_files_if_ours(port_file(), pid)
            print(f"服务已停止（pid {pid}）", file=sys.stderr)
            return 0
        time.sleep(0.1)

    print(f"warning: pid {pid} 在 {STOP_WAIT:.0f}s 内未退出，pid/port 文件保留", file=sys.stderr)
    return 1

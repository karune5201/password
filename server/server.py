#!/usr/bin/env python3
"""server —— 自建密码查询服务（纯标准库，无 Flask 依赖）。

接口
  GET  /health                 健康检查
  GET  /query/<md5>            查密码 → 200 {"md5","password"} / 404
  POST /upload                 上传一条 {"md5"|"password","password"?}
  POST /bulk                   批量导入 {"entries":{md5:password}}  需 token
  GET  /db                     导出整库 {"entries":{...}}           需 token
  GET  /stats                  数据统计
  GET  /                       简易网页面板

安全默认值
  * 未设置 PWDASH_TOKEN 时，写接口只允许来自本机回环地址；
  * 设置后所有写接口 + /db 都必须带 Authorization: Bearer <token>；
  * 请求体上限 8 MiB（/bulk 放宽到 32 MiB），读接口按 IP 限流；
  * 日志只记录路径与状态码，绝不打密码。

用法
  PWDASH_TOKEN=你的口令 python3 server/server.py --port 5000
  curl -s localhost:5000/query/<md5>
  curl -s -X POST localhost:5000/upload -H 'Content-Type: application/json' \\
       -d '{"password":"pwd123"}' -H "Authorization: Bearer 你的口令"
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import socketserver
import sys
import threading
import time
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "tools"))
import pwlib  # noqa: E402

VERSION = "2.0"
MAX_BODY = 32 * 1024 * 1024
READ_LIMIT = 240        # 每分钟每 IP 读请求数
WRITE_LIMIT = 60        # 每分钟每 IP 写请求数


class RateLimiter:
    """按 IP 的滑动窗口限流。"""

    def __init__(self) -> None:
        self._hits: "dict[tuple[str, str], deque[float]]" = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, ip: str, bucket: str, limit: int, window: float = 60.0) -> bool:
        now = time.time()
        key = (ip, bucket)
        with self._lock:
            dq = self._hits[key]
            while dq and now - dq[0] > window:
                dq.popleft()
            if len(dq) >= limit:
                return False
            dq.append(now)
            return True


class App:
    """与 HTTP 无关的业务部分，方便单测。"""

    def __init__(self, db_path: "str | None" = None, token: str = ""):
        self.store = pwlib.Store(db_path)
        self.token = token

    # ---- 鉴权 ----
    def auth_ok(self, header: "str | None", client_ip: str) -> bool:
        if self.token:
            if not header:
                return False
            supplied = header[7:].strip() if header.lower().startswith("bearer ") else header.strip()
            return hmac.compare_digest(supplied, self.token)
        # 没配 token：只信本机
        return client_ip in ("127.0.0.1", "::1", "localhost")

    # ---- 业务 ----
    def query(self, md5: str) -> "str | None":
        try:
            return self.store.get(md5)
        except ValueError:
            raise
        except pwlib.DBError as exc:
            raise RuntimeError(str(exc)) from exc

    def upload(self, payload: "dict") -> "tuple[int, dict]":
        password = payload.get("password")
        md5 = payload.get("md5")
        if not isinstance(password, str) or not password:
            return HTTPStatus.BAD_REQUEST, {"error": "缺少 password"}
        if md5 is None:
            # 兼容老客户端：只给密码，服务端算 MD5
            md5 = pwlib.md5_of(password)
        try:
            md5 = pwlib.normalize_md5(str(md5))
        except ValueError as exc:
            return HTTPStatus.BAD_REQUEST, {"error": str(exc)}
        if len(password) > 512:
            return HTTPStatus.BAD_REQUEST, {"error": "密码过长"}

        changed = self.store.put(md5, password)
        return (
            HTTPStatus.CREATED if changed else HTTPStatus.OK,
            {"status": "created" if changed else "exists", "md5": md5},
        )

    def bulk(self, payload: "dict") -> "tuple[int, dict]":
        entries = payload.get("entries")
        if not isinstance(entries, dict):
            return HTTPStatus.BAD_REQUEST, {"error": "entries 必须是对象"}
        clean = {str(k): str(v) for k, v in entries.items() if isinstance(v, str) and v}
        stats = self.store.merge(clean, overwrite=bool(payload.get("overwrite")))
        return HTTPStatus.OK, {"ok": True, **stats}

    def dump(self) -> dict:
        return {"entries": self.store.load(), "stats": self.store.stats()}


class Handler(BaseHTTPRequestHandler):
    server_version = f"pwdash/{VERSION}"
    sys_version = ""
    app: App
    limiter: RateLimiter
    cors_origin: str

    # ---- 基础工具 ----
    def log_message(self, fmt: str, *args) -> None:  # 屏蔽默认日志（可能含 query）
        sys.stderr.write(
            "%s  %s %s\n" % (self.log_date_time_string(), self.command, self.path.split("?")[0])
        )

    def _client_ip(self) -> str:
        # 仅在明确信任代理时才看 X-Forwarded-For
        if os.environ.get("PWDASH_TRUST_PROXY") == "1":
            fwd = self.headers.get("X-Forwarded-For")
            if fwd:
                return fwd.split(",")[0].strip()
        return self.client_address[0]

    def _send(self, status: int, body: "dict | bytes", ctype: str = "application/json") -> None:
        if isinstance(body, dict):
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        else:
            raw = body
        self.send_response(status)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.cors_origin:
            self.send_header("Access-Control-Allow-Origin", self.cors_origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _read_json(self) -> "tuple[dict | None, str | None]":
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, "Content-Length 非法"
        if length <= 0:
            return None, "请求体为空"
        if length > MAX_BODY:
            return None, "请求体过大"
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, "JSON 解析失败"
        if not isinstance(parsed, dict):
            return None, "请求体必须是 JSON 对象"
        return parsed, None

    # ---- 路由 ----
    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(HTTPStatus.NO_CONTENT, b"")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        ip = self._client_ip()
        if not self.limiter.allow(ip, "read", READ_LIMIT):
            self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "请求过于频繁，稍后再试"})
            return

        path = unquote(urlparse(self.path).path).rstrip("/") or "/"

        if path in ("/", "/index.html"):
            self._send(HTTPStatus.OK, DASHBOARD.encode("utf-8"), "text/html")
            return
        if path == "/health":
            self._send(
                HTTPStatus.OK,
                {"status": "ok", "version": VERSION, "entries": len(self.app.store.load())},
            )
            return
        if path == "/stats":
            self._send(HTTPStatus.OK, self.app.store.stats())
            return
        if path == "/db":
            if not self.app.auth_ok(self.headers.get("Authorization"), ip):
                self._send(HTTPStatus.UNAUTHORIZED, {"error": "需要有效 token"})
                return
            self._send(HTTPStatus.OK, self.app.dump())
            return
        if path.startswith("/query/"):
            raw = path[len("/query/") :]
            try:
                password = self.app.query(raw)
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except RuntimeError as exc:
                self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
                return
            if not password:
                self._send(HTTPStatus.NOT_FOUND, {"error": "未找到该 MD5"})
                return
            self._send(HTTPStatus.OK, {"md5": raw.strip().lower(), "password": password})
            return

        self._send(HTTPStatus.NOT_FOUND, {"error": "未知接口"})

    def do_POST(self) -> None:  # noqa: N802
        ip = self._client_ip()
        if not self.limiter.allow(ip, "write", WRITE_LIMIT):
            self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "写入过于频繁，稍后再试"})
            return

        path = urlparse(self.path).path.rstrip("/") or "/"
        payload, err = self._read_json()
        if err:
            self._send(HTTPStatus.BAD_REQUEST, {"error": err})
            return
        assert payload is not None

        if path == "/upload":
            if not self.app.auth_ok(self.headers.get("Authorization"), ip):
                self._send(
                    HTTPStatus.UNAUTHORIZED,
                    {"error": "写接口需要 token（未配置 token 时仅允许本机）"},
                )
                return
            status, body = self.app.upload(payload)
            self._send(status, body)
            return
        if path == "/bulk":
            if not self.app.auth_ok(self.headers.get("Authorization"), ip):
                self._send(HTTPStatus.UNAUTHORIZED, {"error": "需要有效 token"})
                return
            status, body = self.app.bulk(payload)
            self._send(status, body)
            return

        self._send(HTTPStatus.NOT_FOUND, {"error": "未知接口"})


DASHBOARD = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>pwdash 服务</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0f1115;color:#e6e6e6;font:15px/1.6 system-ui,sans-serif;display:grid;
place-items:center;min-height:100vh;margin:0}main{background:#181c24;padding:32px 28px;border-radius:14px;
max-width:520px}a{color:#4caf50}code{background:#0d1014;padding:2px 6px;border-radius:5px}</style>
<main><h1>🔑 pwdash</h1><p>服务运行中。可用接口：</p>
<ul><li><code>GET /health</code></li><li><code>GET /query/&lt;md5&gt;</code></li>
<li><code>POST /upload</code>（需 token）</li><li><code>GET /db</code>（需 token）</li></ul>
<p>网页版查询界面见仓库根目录的 <code>index.html</code>。</p></main></html>"""


class FastBindHTTPServer(ThreadingHTTPServer):
    """跳过 server_bind() 里的 socket.getfqdn()。

    标准库绑定端口后会做一次反向 DNS 解析；在某些受限网络（无外网 DNS、
    容器 / PRoot 环境）里这会阻塞十几秒甚至更久，表现为「进程活着但连不上」。
    我们不需要那个 FQDN，直接跳过。
    """

    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


def make_server(bind: str, port: int, db: "str | None", token: str, cors: str) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {})
    handler.app = App(db, token)
    handler.limiter = RateLimiter()
    handler.cors_origin = cors
    return FastBindHTTPServer((bind, port), handler)


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(
        prog="server", description="pwdash 本地密码查询服务（零依赖）"
    )
    ap.add_argument("--bind", default="127.0.0.1", help="监听地址，默认 127.0.0.1（仅本机）")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--db", help="数据库路径")
    ap.add_argument("--cors", default="", help="允许的跨域来源，如 https://example.com")
    args = ap.parse_args(argv)

    token = os.environ.get("PWDASH_TOKEN", "")
    if not token:
        print("⚠️  未设置 PWDASH_TOKEN：写接口仅允许本机回环地址调用", file=sys.stderr)
    if args.bind not in ("127.0.0.1", "localhost", "::1") and not token:
        print("❌ 监听非本机地址必须设置 PWDASH_TOKEN", file=sys.stderr)
        return 2

    httpd = make_server(args.bind, args.port, args.db, token, args.cors)
    store = pwlib.Store(args.db)
    print(f"🚀 pwdash {VERSION} 已启动 → http://{args.bind}:{args.port}", flush=True)
    print(f"📚 数据库: {store.path}（{len(store.load())} 条）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "tools"))
import pwlib  # noqa: E402

VERSION = "2.0"
MAX_BODY = 32 * 1024 * 1024
READ_LIMIT = 240        # 每分钟每 IP 读请求数
WRITE_LIMIT = 60        # 每分钟每 IP 写请求数
CONTRIB_LIMIT = 10      # 每 IP 每小时最多投稿数（防灌库）
CONTRIB_WINDOW = 3600.0


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

    def __init__(
        self,
        db_path: "str | None" = None,
        token: str = "",
        *,
        contrib_mode: str = "queue",
        contrib_max_pending: int = 500,
        pending_path: "str | None" = None,
        dbs: "list[tuple[str, str]] | None" = None,
        contrib_db: str = "community",
    ):
        # 多库：名字 -> Store。查询按顺序合并，靠前的优先。
        if dbs:
            self.dbs = [(name, pwlib.Store(path)) for name, path in dbs]
        else:
            self.dbs = [("main", pwlib.Store(db_path))]
        if not self.dbs:
            raise ValueError("至少需要一个数据库")

        self.store = self.dbs[0][1]      # 兼容旧代码：默认主库
        self.token = token
        self.contrib_mode = contrib_mode
        self.contrib_max_pending = contrib_max_pending
        # 陌生人的投稿默认落到独立的 community 库
        names = [n for n, _ in self.dbs]
        self.contrib_db = contrib_db if contrib_db in names else names[-1]

        base_dir = os.path.dirname(self.store.path) or "."
        self.pending = pwlib.Store(pending_path or os.path.join(base_dir, "pending_uploads.json.gz"))

    # ---- 多库读写 ----
    def store_of(self, name: "str | None") -> pwlib.Store:
        """按名字取库；name 为空时返回主库。"""
        if not name:
            return self.dbs[0][1]
        for n, st in self.dbs:
            if n == name:
                return st
        raise ValueError(f"没有名为 {name} 的库（可用: {', '.join(n for n, _ in self.dbs)}）")

    def db_names(self) -> "list[str]":
        return [n for n, _ in self.dbs]

    def find(self, md5: str) -> "tuple[str, str] | None":
        """在所有库里找，返回 (库名, 密码)。靠前的库优先。"""
        key = pwlib.normalize_md5(md5)
        for name, st in self.dbs:
            pwd = st.load().get(key)
            if pwd:
                return name, pwd
        return None

    def find_any(self, md5: str) -> "str | None":
        hit = self.find(md5)
        return hit[1] if hit else None

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
    def query(self, md5: str, db: "str | None" = None) -> "dict | None":
        """db 为空时跨库查找；指定则只查那个库。返回 {db, password}。"""
        try:
            if db:
                pwd = self.store_of(db).get(md5)
                return {"db": db, "password": pwd} if pwd else None
            hit = self.find(md5)
            return {"db": hit[0], "password": hit[1]} if hit else None
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

        try:
            target = self.store_of(payload.get("db"))
        except ValueError as exc:
            return HTTPStatus.BAD_REQUEST, {"error": str(exc)}
        changed = target.put(md5, password)
        return (
            HTTPStatus.CREATED if changed else HTTPStatus.OK,
            {"status": "created" if changed else "exists", "md5": md5, "db": payload.get("db") or self.db_names()[0]},
        )

    def bulk(self, payload: "dict") -> "tuple[int, dict]":
        entries = payload.get("entries")
        if not isinstance(entries, dict):
            return HTTPStatus.BAD_REQUEST, {"error": "entries 必须是对象"}
        clean = {str(k): str(v) for k, v in entries.items() if isinstance(v, str) and v}
        try:
            target = self.store_of(payload.get("db"))
        except ValueError as exc:
            return HTTPStatus.BAD_REQUEST, {"error": str(exc)}
        stats = target.merge(clean, overwrite=bool(payload.get("overwrite")))
        return HTTPStatus.OK, {"ok": True, **stats}

    def dump(self, db: "str | None" = None) -> dict:
        store = self.store_of(db)
        return {
            "db": db or self.db_names()[0],
            "dbs": [{"name": n, "entries": len(st.load())} for n, st in self.dbs],
            "entries": store.load(),
            "stats": store.stats(),
        }

    # ---- 公开投稿：任何人都能提交，默认进审核队列 ----
    def contribute(self, payload: "dict", client_ip: str) -> "tuple[int, dict]":
        """mode=off 拒绝 / queue 进待审列表 / auto 直接入库。"""
        if self.contrib_mode == "off":
            return HTTPStatus.FORBIDDEN, {"error": "本站未开放投稿"}

        password = payload.get("password")
        md5 = payload.get("md5")
        if not isinstance(password, str) or not password.strip():
            return HTTPStatus.BAD_REQUEST, {"error": "请填写密码"}
        password = password.strip()
        if len(password) > 256:
            return HTTPStatus.BAD_REQUEST, {"error": "密码过长（>256）"}
        if md5 in (None, ""):
            md5 = pwlib.md5_of(password)
        try:
            md5 = pwlib.normalize_md5(str(md5))
        except ValueError as exc:
            return HTTPStatus.BAD_REQUEST, {"error": str(exc)}

        # 想写进哪个库：默认 community（陌生人的投稿单独一个库）
        try:
            target_name = payload.get("db") or self.contrib_db
            target = self.store_of(target_name)
        except ValueError as exc:
            return HTTPStatus.BAD_REQUEST, {"error": str(exc)}

        # 任何一个库里已经有了：不重复收
        try:
            if self.find_any(md5):
                return HTTPStatus.OK, {"status": "exists", "md5": md5}
        except pwlib.DBError as exc:
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

        # 待审里也不能重复堆积
        try:
            if self.pending.get(md5):
                return HTTPStatus.OK, {"status": "already_pending", "md5": md5}
        except pwlib.DBError as exc:
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}

        if self.contrib_mode == "auto":
            target.put(md5, password)
            return HTTPStatus.CREATED, {"status": "accepted", "md5": md5, "db": target_name}

        # 队列模式：容量上限，防止被刷爆磁盘
        pending_count = len(self.pending.load())
        if pending_count >= self.contrib_max_pending:
            return HTTPStatus.TOO_MANY_REQUESTS, {
                "error": "待审队列已满，请稍后再试",
                "pending": pending_count,
            }

        # pending 的值编码为 "库名\t密码"，这样审核时能知道该进哪个库
        self.pending.put(md5, f"{target_name}\t{password}")
        return HTTPStatus.ACCEPTED, {
            "status": "pending",
            "md5": md5,
            "db": target_name,
            "message": "已提交，等管理员审核后生效",
            "pending": pending_count + 1,
        }

    @staticmethod
    def _split_pending(raw: str) -> "tuple[str, str]":
        """pending 值兼容两种格式："db\tpassword" 或老的纯密码。"""
        if "\t" in raw:
            db, _, pwd = raw.partition("\t")
            return db, pwd
        return "", raw

    def pending_view(self) -> dict:
        """返回 {md5: password} 便于人看，同时给出明细（含目标库）。"""
        raw = self.pending.load()
        entries = {}
        detail = []
        for md5, val in raw.items():
            db, pwd = self._split_pending(val)
            entries[md5] = pwd
            detail.append({"md5": md5, "password": pwd, "db": db or self.contrib_db})
        return {"count": len(raw), "entries": entries, "detail": detail}

    def review(self, payload: "dict", *, approve: bool) -> "tuple[int, dict]":
        """审核：approve=True 入库，False 丢弃。ids 支持列表或 all=true。"""
        pending = self.pending.load()
        if payload.get("all"):
            targets = list(pending.keys())
        else:
            ids = payload.get("ids")
            if isinstance(ids, str):
                ids = [ids]
            if not isinstance(ids, list) or not ids:
                return HTTPStatus.BAD_REQUEST, {"error": "需要 ids 列表或 all=true"}
            targets = [str(i).strip().lower() for i in ids]

        done, skipped = [], []
        by_db = {}
        for md5 in targets:
            val = pending.get(md5)
            if val is None:
                skipped.append(md5)
                continue
            db, pwd = self._split_pending(val)
            if approve:
                try:
                    target = self.store_of(db)
                except ValueError:
                    target = self.store_of(self.contrib_db)
                target.put(md5, pwd)
                by_db[target.path] = by_db.get(target.path, 0) + 1
            self.pending.delete(md5)
            done.append(md5)

        return HTTPStatus.OK, {
            "approved": len(done) if approve else 0,
            "rejected": 0 if approve else len(done),
            "done": done,
            "skipped": skipped,
            "pending": len(self.pending.load()),
            "dbs": [{"name": n, "entries": len(st.load())} for n, st in self.dbs],
        }


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
                {
                    "status": "ok",
                    "version": VERSION,
                    "entries": sum(len(st.load()) for _, st in self.app.dbs),
                    "dbs": [{"name": n, "entries": len(st.load())} for n, st in self.app.dbs],
                },
            )
            return
        if path == "/stats":
            want_db = (parse_qs(urlparse(self.path).query).get("db") or [""])[0] or None
            try:
                store = self.app.store_of(want_db)
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            payload = store.stats()
            payload["dbs"] = [{"name": n, "entries": len(st.load()), "path": st.path} for n, st in self.app.dbs]
            self._send(HTTPStatus.OK, payload)
            return
        if path == "/db":
            if not self.app.auth_ok(self.headers.get("Authorization"), ip):
                self._send(HTTPStatus.UNAUTHORIZED, {"error": "需要有效 token"})
                return
            want_db = (parse_qs(urlparse(self.path).query).get("db") or [""])[0] or None
            try:
                self._send(HTTPStatus.OK, self.app.dump(want_db))
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path == "/contrib/count":
            self._send(HTTPStatus.OK, {"pending": len(self.app.pending.load())})
            return
        if path == "/contrib/pending":
            if not self.app.auth_ok(self.headers.get("Authorization"), ip):
                self._send(HTTPStatus.UNAUTHORIZED, {"error": "需要有效 token"})
                return
            self._send(HTTPStatus.OK, self.app.pending_view())
            return
        if path.startswith("/query/") or path == "/query":
            raw = path[len("/query/") :] if path.startswith("/query/") else (parse_qs(urlparse(self.path).query).get("md5") or [""])[0]
            want_db = (parse_qs(urlparse(self.path).query).get("db") or [""])[0] or None
            try:
                hit = self.app.query(raw, want_db)
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except RuntimeError as exc:
                self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
                return
            if not hit:
                self._send(HTTPStatus.NOT_FOUND, {"error": "未找到该 MD5"})
                return
            self._send(
                HTTPStatus.OK,
                {"md5": raw.strip().lower(), "password": hit["password"], "db": hit["db"]},
            )
            return

        self._send(HTTPStatus.NOT_FOUND, {"error": "未知接口"})

    def do_POST(self) -> None:  # noqa: N802
        ip = self._client_ip()
        if not self.limiter.allow(ip, "write", WRITE_LIMIT):
            self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "写入过于频繁，稍后再试"})
            return

        path = urlparse(self.path).path.rstrip("/") or "/"

        # 公开投稿单独限流（比普通写接口更严），且不需要 token
        if path == "/contribute":
            if not self.limiter.allow(ip, "contrib", CONTRIB_LIMIT, window=CONTRIB_WINDOW):
                self._send(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "投稿太频繁，请稍后再试"},
                )
                return
            payload, err = self._read_json()
            if err:
                self._send(HTTPStatus.BAD_REQUEST, {"error": err})
                return
            assert payload is not None
            status, body = self.app.contribute(payload, ip)
            self._send(status, body)
            return

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
        if path in ("/contrib/approve", "/contrib/reject"):
            if not self.app.auth_ok(self.headers.get("Authorization"), ip):
                self._send(HTTPStatus.UNAUTHORIZED, {"error": "审核需要有效 token"})
                return
            status, body = self.app.review(payload, approve=(path == "/contrib/approve"))
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


def parse_dbs(spec: str) -> "list[tuple[str, str]]":
    """解析 --dbs：'main=a.json.gz,community=b.json.gz'（也接受单一路径）。"""
    if not spec:
        return []
    out = []
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            name, _, path = item.partition("=")
            out.append((name.strip(), path.strip()))
        else:
            out.append(("main", item))
    return out


def make_server(
    bind: str,
    port: int,
    db: "str | None",
    token: str,
    cors: str,
    contrib_mode: str = "queue",
    pending_path: "str | None" = None,
    dbs: "list[tuple[str, str]] | None" = None,
    contrib_db: str = "community",
) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {})
    handler.app = App(
        db,
        token,
        contrib_mode=contrib_mode,
        pending_path=pending_path,
        dbs=dbs,
        contrib_db=contrib_db,
    )
    handler.limiter = RateLimiter()
    handler.cors_origin = cors
    return FastBindHTTPServer((bind, port), handler)


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(
        prog="server", description="pwdash 本地密码查询服务（零依赖）"
    )
    ap.add_argument("--bind", default="127.0.0.1", help="监听地址，默认 127.0.0.1（仅本机）")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--db", help="主数据库路径（单库模式）")
    ap.add_argument(
        "--dbs",
        default=os.environ.get("PWDASH_DBS", ""),
        help="多库配置：'main=passwords_local.json.gz,community=community.json.gz'；靠前的库优先",
    )
    ap.add_argument(
        "--contrib-db",
        default=os.environ.get("PWDASH_CONTRIB_DB", "community"),
        help="陌生人投稿默认写入哪个库（默认 community，不存在则用最后一个库）",
    )
    ap.add_argument("--cors", default="", help="允许的跨域来源，如 * 或 https://example.com")
    ap.add_argument(
        "--contrib-mode",
        choices=["queue", "auto", "off"],
        default=os.environ.get("PWDASH_CONTRIB_MODE", "queue"),
        help="公开投稿模式：queue=进审核队列（默认），auto=直接入库，off=关闭",
    )
    ap.add_argument(
        "--pending",
        default=os.environ.get("PWDASH_PENDING"),
        help="待审队列文件路径（默认与主库同目录的 pending_uploads.json.gz）",
    )
    args = ap.parse_args(argv)

    token = os.environ.get("PWDASH_TOKEN", "")
    if not token:
        print("⚠️  未设置 PWDASH_TOKEN：写接口仅允许本机回环地址调用", file=sys.stderr)
    if args.bind not in ("127.0.0.1", "localhost", "::1") and not token:
        print("❌ 监听非本机地址必须设置 PWDASH_TOKEN", file=sys.stderr)
        return 2

    db_list = parse_dbs(args.dbs)
    if not db_list and args.db:
        # 单库时也给出约定：主库 + 同目录的 community 库（自动创建）
        base_dir = os.path.dirname(os.path.abspath(args.db)) or "."
        community = os.path.join(base_dir, "community_passwords.json.gz")
        db_list = [("main", args.db)]
        if os.path.basename(args.db) != os.path.basename(community):
            db_list.append(("community", community))

    httpd = make_server(
        args.bind,
        args.port,
        args.db,
        token,
        args.cors,
        contrib_mode=args.contrib_mode,
        pending_path=args.pending,
        dbs=db_list or None,
        contrib_db=args.contrib_db,
    )
    store = pwlib.Store(args.db)
    print(f"🚀 pwdash {VERSION} 已启动 → http://{args.bind}:{args.port}", flush=True)
    print(f"📚 数据库: {store.path}（{len(store.load())} 条）")
    print(f"📝 投稿模式: {args.contrib_mode}（待审 {len(httpd.RequestHandlerClass.app.pending.load())} 条）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

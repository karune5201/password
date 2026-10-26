#!/usr/bin/env python3
"""serve —— 本地预览网页版（带正确的 MIME 与禁缓存头，纯标准库）。

    python3 tools/serve.py            # http://127.0.0.1:8080
    python3 tools/serve.py --port 9000 --bind 0.0.0.0

注意：只用于本地开发预览。正式部署直接扔 GitHub Pages / Cloudflare Pages 即可。
"""

from __future__ import annotations

import argparse
import os
import socketserver
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self) -> None:
        # 开发时不要缓存，避免改了文件看不到效果
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


class FastBindHTTPServer(ThreadingHTTPServer):
    """跳过 server_bind() 的 getfqdn 反向解析（受限网络下会卡住启动）。"""

    daemon_threads = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(prog="serve", description="本地预览网页版")
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--root", default=ROOT)
    args = ap.parse_args(argv)

    handler = partial(Handler, directory=args.root)
    httpd = FastBindHTTPServer((args.bind, args.port), handler)
    print(f"🌐 预览: http://{args.bind}:{args.port}  (Ctrl+C 停止)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

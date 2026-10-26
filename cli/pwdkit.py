#!/usr/bin/env python3
"""pwdkit —— 压缩包密码工具（查询 / 维护 / 解压 / 同步），零第三方依赖。

子命令
  hash    计算文件或字符串的 MD5
  query   按 MD5 查密码（支持 --file 直接算文件 MD5、stdin 批量）
  add     手动登记 MD5 → 密码
  remove  删除记录
  list    列出记录（默认打码）
  stats   数据体检
  export  导出库
  import  合并外部库
  extract 用密码解压（可自动查库、可回传服务器）
  sync    与自建服务端同步（push / pull）
  doctor  环境体检
  menu    交互式菜单（老 1.py 的操作方式）

退出码：0 成功 / 2 用法错误 / 3 库错误 / 4 未找到 / 5 解压失败 / 6 缺依赖 / 7 网络错误
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "tools"))
sys.path.insert(0, HERE)

import pwlib  # noqa: E402
import archive  # noqa: E402

EXIT_OK, EXIT_USAGE, EXIT_DB, EXIT_NOTFOUND, EXIT_EXTRACT, EXIT_DEPS, EXIT_NET = (
    0,
    2,
    3,
    4,
    5,
    6,
    7,
)

DEFAULT_SERVER = os.environ.get("PWDASH_SERVER", "http://127.0.0.1:5000")


# --------------------------------------------------------------------------
# 输出小工具
# --------------------------------------------------------------------------
def _supports_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


class C:
    GREEN = "\033[1;32m" if _supports_color() else ""
    RED = "\033[1;31m" if _supports_color() else ""
    YELLOW = "\033[1;33m" if _supports_color() else ""
    BLUE = "\033[1;34m" if _supports_color() else ""
    DIM = "\033[2m" if _supports_color() else ""
    RESET = "\033[0m" if _supports_color() else ""


def info(msg: str) -> None:
    print(msg)


def warn(msg: str) -> None:
    print(f"{C.YELLOW}⚠️  {msg}{C.RESET}", file=sys.stderr)


def fail(msg: str) -> None:
    print(f"{C.RED}❌ {msg}{C.RESET}", file=sys.stderr)


def ok(msg: str) -> None:
    print(f"{C.GREEN}✅ {msg}{C.RESET}")


def ask_password(prompt: str) -> str:
    """TTY 下不回显；管道输入则按行读。"""
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    return sys.stdin.readline().rstrip("\n")


# --------------------------------------------------------------------------
# 远程
# --------------------------------------------------------------------------
def http_json(
    url: str, *, method: str = "GET", payload: "dict | None" = None, token: str = "", timeout: float = 8.0
) -> "tuple[int, dict]":
    data = None
    headers = {"Accept": "application/json", "User-Agent": "pwdkit/2.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, {"error": body[:200]}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ConnectionError(str(exc)) from exc


def remote_query(server: str, md5: str, token: str = "") -> "str | None":
    url = f"{server.rstrip('/')}/query/{md5}"
    status, data = http_json(url, token=token)
    if status == 200:
        return data.get("password")
    if status == 404:
        return None
    raise ConnectionError(data.get("error", f"HTTP {status}"))


def remote_push(server: str, md5: str, password: str, token: str = "") -> "tuple[bool, str]":
    url = f"{server.rstrip('/')}/upload"
    status, data = http_json(
        url, method="POST", payload={"md5": md5, "password": password}, token=token
    )
    if status in (200, 201):
        return True, data.get("status", "ok")
    return False, data.get("error", f"HTTP {status}")


# --------------------------------------------------------------------------
# 子命令实现
# --------------------------------------------------------------------------
def cmd_hash(args: argparse.Namespace) -> int:
    if args.file:
        if not os.path.exists(args.file):
            fail(f"文件不存在: {args.file}")
            return EXIT_USAGE
        digest = file_md5(args.file)
        target = args.file
    else:
        if not args.text:
            fail("请提供文件路径或要计算 MD5 的文本")
            return EXIT_USAGE
        digest = pwlib.md5_of(args.text)
        target = args.text
    if args.json:
        print(json.dumps({"target": target, "md5": digest}, ensure_ascii=False))
    else:
        print(digest)
    return EXIT_OK


def file_md5(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _lookup(store: "pwlib.Store", md5: str, args: argparse.Namespace) -> "str | None":
    """本地优先，其次远端（--server 或 --no-remote 控制）。"""
    pwd = store.get(md5)
    if pwd:
        return pwd
    if args.no_remote:
        return None
    try:
        pwd = remote_query(args.server or DEFAULT_SERVER, md5, args.token)
    except ConnectionError:
        return None
    if pwd:
        # 远端命中缓存到本地，便于离线复用
        try:
            store.put(md5, pwd)
        except Exception:  # noqa: BLE001
            pass
    return pwd


def cmd_query(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)

    targets: "list[str]" = []
    if args.file:
        if not os.path.exists(args.file):
            fail(f"文件不存在: {args.file}")
            return EXIT_USAGE
        targets.append(file_md5(args.file))
        info(f"{C.DIM}文件 MD5: {targets[0]}{C.RESET}")
    elif args.md5:
        if args.md5 == ["-"]:
            targets = [line.strip() for line in sys.stdin if line.strip()]
        else:
            targets = list(args.md5)

    if not targets:
        fail("请提供 MD5、--file 或从 stdin 传入")
        return EXIT_USAGE

    results = []
    code = EXIT_OK
    for raw in targets:
        try:
            md5 = pwlib.normalize_md5(raw)
        except ValueError as exc:
            results.append({"md5": raw, "found": False, "error": str(exc)})
            code = max(code, EXIT_NOTFOUND)
            continue
        pwd = _lookup(store, md5, args)
        results.append({"md5": md5, "found": bool(pwd), "password": pwd})
        if not pwd:
            code = max(code, EXIT_NOTFOUND)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return code

    for row in results:
        if row.get("error"):
            print(f"{C.RED}✗ {row['md5']}: {row['error']}{C.RESET}")
        elif row["found"]:
            if args.quiet:
                print(row["password"])
            else:
                print(f"{C.GREEN}🔑 {row['md5']}{C.RESET} → {row['password']}")
        else:
            print(f"{C.YELLOW}✗ {row['md5']}: 未找到{C.RESET}")
    return code


def cmd_add(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    md5 = args.md5
    pwd = args.password

    if args.from_password:
        pwd = args.from_password
        md5 = pwlib.md5_of(pwd)
        info(f"{C.DIM}按密码计算出的 MD5: {md5}{C.RESET}")
    if not md5:
        md5 = input("MD5: ").strip()
    if not pwd:
        pwd = ask_password("密码（不回显）: ")

    try:
        changed = store.put(md5, pwd)
    except ValueError as exc:
        fail(str(exc))
        return EXIT_USAGE
    except pwlib.DBError as exc:
        fail(str(exc))
        return EXIT_DB

    if changed:
        ok(f"已登记 {md5.strip().lower()}")
    else:
        info("ℹ️  该记录已存在且密码相同，未改动")

    if args.upload:
        try:
            done, msg = remote_push(
                args.server or DEFAULT_SERVER, md5.strip().lower(), pwd, args.token
            )
        except ConnectionError as exc:
            warn(f"远端不可用（{exc}），已仅保存本地")
            return EXIT_NET
        ok(f"已上传服务器: {msg}") if done else warn(f"上传失败: {msg}")
    return EXIT_OK


def cmd_remove(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    missing = 0
    for raw in args.md5:
        try:
            if store.delete(raw):
                ok(f"已删除 {raw.strip().lower()}")
            else:
                warn(f"未找到 {raw}")
                missing += 1
        except ValueError as exc:
            fail(str(exc))
            missing += 1
    return EXIT_NOTFOUND if missing else EXIT_OK


def cmd_list(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    data = store.load()
    rows = sorted(data.items())
    if args.search:
        needle = args.search.lower()
        rows = [r for r in rows if needle in r[0] or needle in r[1].lower()]
    if args.limit:
        rows = rows[: args.limit]

    if args.json:
        payload = [
            {"md5": k, "password": v if args.reveal else pwlib.mask(v)} for k, v in rows
        ]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return EXIT_OK

    if not rows:
        info("📭 没有记录")
        return EXIT_OK
    for k, v in rows:
        shown = v if args.reveal else pwlib.mask(v)
        print(f"{k}  {shown}")
    info(f"{C.DIM}共 {len(rows)} 条（{len(data)} 条总量）{'，已显示明文' if args.reveal else '，密码已打码，用 --reveal 查看明文'}{C.RESET}")
    return EXIT_OK


def cmd_stats(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    try:
        stats = store.stats()
    except pwlib.DBError as exc:
        fail(str(exc))
        return EXIT_DB
    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    else:
        print(f"📚 库文件: {stats['path']}")
        print(f"   记录数: {stats['entries']}")
        print(f"   体积:   {stats['compressed_bytes']} 字节")
        print(f"   密码长度: 平均 {stats['avg_password_len']} / 最长 {stats['max_password_len']}")
        if stats["invalid_keys"]:
            warn(f"发现 {len(stats['invalid_keys'])} 条非法 key：{stats['invalid_keys'][:5]}")
        else:
            ok("key 全部合法")
    return EXIT_OK


def cmd_export(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    try:
        data = store.load()
    except pwlib.DBError as exc:
        fail(str(exc))
        return EXIT_DB
    if not data:
        fail("库为空，无可导出内容")
        return EXIT_NOTFOUND

    fmt = args.format
    out = args.output
    if fmt == "plain":
        fmt = "json"
    if fmt == "gz":
        payload = pwlib.dumps(data, compress=True)
        out = out or os.path.join(os.getcwd(), pwlib.DB_NAME)
    elif fmt == "pretty":
        payload = pwlib.dumps_pretty(data)
        out = out or os.path.join(os.getcwd(), "passwords_pretty.json")
    else:
        payload = pwlib.dumps(data, compress=False)
        out = out or os.path.join(os.getcwd(), "passwords_local.json")

    pwlib.atomic_write(out, payload)
    ok(f"已导出 {len(data)} 条 → {out}")
    return EXIT_OK


def cmd_import(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    if not os.path.exists(args.file):
        fail(f"文件不存在: {args.file}")
        return EXIT_USAGE
    with open(args.file, "rb") as fh:
        try:
            incoming = pwlib.loads(fh.read())
        except pwlib.DBError as exc:
            fail(str(exc))
            return EXIT_DB
    stats = store.merge(incoming, overwrite=args.overwrite)
    ok(
        f"合并完成：新增 {stats['added']}，更新 {stats['updated']}，"
        f"跳过 {stats['skipped']}，非法 {stats['invalid']}"
    )
    return EXIT_OK


def cmd_extract(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    path = args.archive
    if not os.path.exists(path):
        fail(f"文件不存在: {path}")
        return EXIT_USAGE

    passwords: "list[str]" = []
    if args.password:
        passwords.append(args.password)

    # 没给密码就查库
    if not passwords and not args.no_db:
        digest = file_md5(path)
        info(f"{C.DIM}文件 MD5: {digest}{C.RESET}")
        pwd = _lookup(store, digest, args)
        if pwd:
            info(f"{C.GREEN}库里找到密码（{pwlib.mask(pwd)}），开始尝试{C.RESET}")
            passwords.append(pwd)
        else:
            warn("库里没有这个文件的密码，需要手动输入")

    if not passwords:
        if args.no_input:
            fail("未提供密码，且已禁用交互输入")
            return EXIT_USAGE
        entered = ask_password("解压密码（无密码直接回车）: ")
        passwords.append(entered)

    out_dir = None
    if not args.verify_only:
        base = args.output or os.getcwd()
        stem = os.path.splitext(os.path.basename(path))[0]
        out_dir = os.path.join(base, stem)
        if os.path.exists(out_dir) and not args.force:
            fail(f"输出目录已存在: {out_dir}（加 --force 覆盖）")
            return EXIT_USAGE

    result = archive.extract(path, passwords[0], out_dir)
    if result.status == archive.MISSING_DEPS:
        fail(f"缺少解压后端: {result.detail}")
        info("可任选其一：pip install pyzipper py7zr rarfile / pkg install p7zip unrar")
        return EXIT_DEPS
    if result.status == archive.BAD_PASSWORD:
        fail(result.message())
        return EXIT_EXTRACT
    if not result.ok:
        fail(result.message())
        return EXIT_EXTRACT

    ok(result.message())

    # 只有校验成功且确实有密码才回传（默认不上传，隐私优先）
    if passwords[0] and args.upload:
        digest = file_md5(path)
        try:
            done, msg = remote_push(
                args.server or DEFAULT_SERVER, digest, passwords[0], args.token
            )
            ok(f"已回传服务器: {msg}") if done else warn(f"回传失败: {msg}")
        except ConnectionError as exc:
            warn(f"服务器不可达（{exc}），已保存到本地库")
            store.put(digest, passwords[0])
    return EXIT_OK


def cmd_sync(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    server = args.server or DEFAULT_SERVER
    token = args.token or os.environ.get("PWDASH_TOKEN", "")

    if args.action == "push":
        data = store.load()
        if not data:
            fail("本地库为空")
            return EXIT_NOTFOUND
        try:
            status, resp = http_json(
                f"{server.rstrip('/')}/bulk",
                method="POST",
                payload={"entries": data},
                token=token,
                timeout=60,
            )
        except ConnectionError as exc:
            fail(f"无法连接 {server}: {exc}")
            return EXIT_NET
        if status in (200, 201):
            ok(f"推送完成: {json.dumps(resp, ensure_ascii=False)}")
            return EXIT_OK
        fail(f"推送失败: {resp.get('error', status)}")
        return EXIT_NET

    # pull
    try:
        status, resp = http_json(f"{server.rstrip('/')}/db", token=token, timeout=60)
    except ConnectionError as exc:
        fail(f"无法连接 {server}: {exc}")
        return EXIT_NET
    if status == 401:
        fail("服务端要求 token（--token 或 PWDASH_TOKEN）")
        return EXIT_NET
    if status != 200:
        fail(f"拉取失败: {resp.get('error', status)}")
        return EXIT_NET
    entries = resp.get("entries") or {}
    stats = store.merge({str(k): str(v) for k, v in entries.items()}, overwrite=args.overwrite)
    ok(f"拉取 {len(entries)} 条：新增 {stats['added']}，更新 {stats['updated']}")
    return EXIT_OK


def cmd_doctor(args: argparse.Namespace) -> int:
    print(f"🧬 Python {sys.version.split()[0]} / {sys.platform}")
    print(f"📚 库路径: {pwlib.default_db_path()}")
    store = pwlib.Store(args.db)
    try:
        stats = store.stats()
        print(f"   记录 {stats['entries']} 条，非法 key {len(stats['invalid_keys'])} 条")
    except pwlib.DBError as exc:
        warn(f"库读取失败: {exc}")

    print("\n🗜  解压后端:")
    for name, state in archive.backend_status().items():
        print(f"   {name:<22} {state}")

    print("\n🌐 远端:")
    server = args.server or DEFAULT_SERVER
    try:
        status, data = http_json(f"{server.rstrip('/')}/health", timeout=3)
        print(f"   {server} → HTTP {status} {json.dumps(data, ensure_ascii=False)}")
    except ConnectionError:
        print(f"   {server} → 不可达（离线模式仍可用）")

    print("\n🔐 数据源:")
    for src in pwlib.DEFAULT_SOURCES:
        print(f"   {src}")
    return EXIT_OK


# --------------------------------------------------------------------------
# 交互菜单（兼容老 1.py 的使用习惯）
# --------------------------------------------------------------------------
def cmd_menu(args: argparse.Namespace) -> int:
    store = pwlib.Store(args.db)
    while True:
        print(f"\n{C.BLUE}==== 🔑 pwdkit 密码工具 ===={C.RESET}")
        print(f" 库: {store.path}  ({len(store.load())} 条)")
        print(" 1. 解压文件（自动查库密码）")
        print(" 2. 查询密码（MD5 / 文件）")
        print(" 3. 手动登记 MD5 + 密码")
        print(" 4. 查看记录")
        print(" 5. 删除记录")
        print(" 6. 导出 JSON")
        print(" 7. 数据体检")
        print(" 0. 退出")
        choice = input("请选择: ").strip()

        if choice == "1":
            path = input("压缩文件路径: ").strip().strip("'\"")
            if not path:
                continue
            ns = argparse.Namespace(
                db=args.db,
                archive=path,
                password="",
                no_db=False,
                no_input=False,
                output="",
                force=False,
                verify_only=False,
                upload=False,
                server=args.server,
                token=args.token,
            )
            cmd_extract(ns)
        elif choice == "2":
            raw = input("MD5（或输入文件路径）: ").strip().strip("'\"")
            if not raw:
                continue
            ns = argparse.Namespace(
                db=args.db,
                md5=[raw],
                file=raw if os.path.isfile(raw) else "",
                json=False,
                quiet=False,
                no_remote=False,
                server=args.server,
                token=args.token,
            )
            cmd_query(ns)
        elif choice == "3":
            md5 = input("MD5（回车则按密码反算）: ").strip()
            pwd = ask_password("密码（不回显）: ")
            ns = argparse.Namespace(
                db=args.db,
                md5=md5,
                password=pwd,
                from_password=pwd if not md5 else "",
                upload=False,
                server=args.server,
                token=args.token,
            )
            cmd_add(ns)
        elif choice == "4":
            cmd_list(
                argparse.Namespace(
                    db=args.db, json=False, reveal=False, limit=0, search=""
                )
            )
        elif choice == "5":
            md5 = input("要删除的 MD5: ").strip()
            if md5:
                cmd_remove(argparse.Namespace(db=args.db, md5=[md5]))
        elif choice == "6":
            cmd_export(
                argparse.Namespace(db=args.db, format="json", output="")
            )
        elif choice == "7":
            cmd_stats(argparse.Namespace(db=args.db, json=False))
        elif choice == "0":
            info("👋 再见")
            return EXIT_OK
        else:
            warn("无效选择")


# --------------------------------------------------------------------------
# 参数解析
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="pwdkit",
        description="压缩包密码工具（查询 / 维护 / 解压 / 同步），零第三方依赖",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-d", "--db", help="数据库路径（默认仓库内 passwords_local.json.gz）")
    ap.add_argument("--server", help=f"远端服务地址（默认 {DEFAULT_SERVER}）")
    ap.add_argument("--token", help="服务端鉴权 token（也可用 PWDASH_TOKEN）")
    ap.add_argument("-V", "--version", action="version", version="pwdkit 2.0")
    sub = ap.add_subparsers(dest="cmd", metavar="<command>")

    p = sub.add_parser("hash", help="计算 MD5")
    p.add_argument("text", nargs="?", help="要计算的字符串")
    p.add_argument("-f", "--file", help="要计算的文件")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_hash)

    p = sub.add_parser("query", help="按 MD5 查密码")
    p.add_argument("md5", nargs="*", help="一个或多个 MD5，'-' 表示从 stdin 读")
    p.add_argument("-f", "--file", help="先算该文件的 MD5 再查")
    p.add_argument("-q", "--quiet", action="store_true", help="只输出密码本身")
    p.add_argument("--json", action="store_true")
    p.add_argument("--no-remote", action="store_true", help="只查本地，不访问服务器")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("add", help="登记 MD5 → 密码")
    p.add_argument("md5", nargs="?")
    p.add_argument("password", nargs="?", help="密码（省略则交互输入）")
    p.add_argument("--from-password", help="只给密码，由程序反算 MD5")
    p.add_argument("--upload", action="store_true", help="同时上传到服务器")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("remove", help="删除记录")
    p.add_argument("md5", nargs="+")
    p.set_defaults(func=cmd_remove)

    p = sub.add_parser("list", help="列出记录")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--search", default="")
    p.add_argument("--reveal", action="store_true", help="显示密码明文")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("stats", help="数据体检")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("export", help="导出库")
    p.add_argument("-o", "--output")
    p.add_argument("-f", "--format", choices=["json", "gz", "pretty"], default="json")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("import", help="合并外部库")
    p.add_argument("file")
    p.add_argument("--overwrite", action="store_true", help="同 key 时覆盖旧值")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("extract", help="用密码解压")
    p.add_argument("archive")
    p.add_argument("-p", "--password", default="")
    p.add_argument("-o", "--output", default="", help="解压到哪个目录（默认当前目录/压缩包名）")
    p.add_argument("--no-db", action="store_true", help="不自动查库")
    p.add_argument("--no-input", action="store_true", help="禁止交互输入密码")
    p.add_argument("--verify-only", action="store_true", help="只校验密码，不解压")
    p.add_argument("--force", action="store_true", help="输出目录已存在时覆盖")
    p.add_argument("--upload", action="store_true", help="成功后把密码回传服务器")
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("sync", help="与服务端同步")
    p.add_argument("action", choices=["push", "pull"])
    p.add_argument("--overwrite", action="store_true")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("doctor", help="环境体检")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("menu", help="交互式菜单")
    p.set_defaults(func=cmd_menu)

    return ap


def main(argv: "list[str] | None" = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "cmd", None):
        ap.print_help()
        return EXIT_USAGE
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print()
        return 130
    except pwlib.DBError as exc:
        fail(str(exc))
        return EXIT_DB


if __name__ == "__main__":
    raise SystemExit(main())

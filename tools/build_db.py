#!/usr/bin/env python3
"""build_db —— 密码库构建/清洗工具。

用途：
  1. 把多个来源（json / gz / 目录）合并成一份干净的库；
  2. 剔除脏数据（非 32 位 MD5 的 key、空密码、超长密码）；
  3. 同时产出网页版明文 JSON（给 GitHub Pages / CDN 用）和压缩版（给 CLI 用）。

示例：
  python3 tools/build_db.py                       # 以仓库根目录的 gz 为输入，清洗后回写
  python3 tools/build_db.py --from a.json b.json.gz --out dist/
  python3 tools/build_db.py --check               # 只体检，不改文件
  python3 tools/build_db.py --dedupe-passwords    # 同一密码只保留一个 MD5
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pwlib  # noqa: E402

MAX_PASSWORD_LEN = 256  # 压缩包密码超过这个长度的基本是脏数据


def collect(paths: Iterable[str]) -> "dict[str, str]":
    merged: "dict[str, str]" = {}
    for path in paths:
        if os.path.isdir(path):
            files = [
                os.path.join(path, n)
                for n in sorted(os.listdir(path))
                if n.endswith((".json", ".gz"))
            ]
        else:
            files = [path]
        for fp in files:
            try:
                with open(fp, "rb") as fh:
                    data = pwlib.loads(fh.read())
            except Exception as exc:  # noqa: BLE001
                print(f"⚠️  跳过 {fp}: {exc}", file=sys.stderr)
                continue
            print(f"📥 读入 {fp}: {len(data)} 条")
            for k, v in data.items():
                merged.setdefault(k, v)
    return merged


def clean(
    data: "dict[str, str]", *, dedupe_passwords: bool = False
) -> "tuple[dict[str, str], list[dict[str, str]]]":
    """返回 (干净数据, 被剔除的记录)。"""
    good: "dict[str, str]" = {}
    rejected: "list[dict[str, str]]" = []
    seen_passwords: "dict[str, str]" = {}

    for raw_key, raw_val in data.items():
        key = (raw_key or "").strip().lower()
        val = (raw_val or "").strip()

        if not pwlib.is_md5(key):
            rejected.append(
                {"md5": raw_key, "password": val, "reason": "key 不是 32 位 MD5"}
            )
            continue
        if not val:
            rejected.append({"md5": key, "password": "", "reason": "密码为空"})
            continue
        if len(val) > MAX_PASSWORD_LEN:
            rejected.append(
                {
                    "md5": key,
                    "password": val[:16] + "...",
                    "reason": f"密码过长({len(val)})",
                }
            )
            continue
        if dedupe_passwords:
            if val in seen_passwords:
                rejected.append(
                    {
                        "md5": key,
                        "password": val,
                        "reason": f"同一密码已由 {seen_passwords[val]} 承载",
                    }
                )
                continue
            seen_passwords[val] = key

        good[key] = val

    return good, rejected


def write_outputs(
    data: "dict[str, str]", out_dir: str, *, also_gz: bool = True
) -> "list[str]":
    written = []
    pretty_path = os.path.join(out_dir, "passwords_local.json")
    pwlib.atomic_write(pretty_path, pwlib.dumps_pretty(data))
    written.append(pretty_path)
    if also_gz:
        gz_path = os.path.join(out_dir, pwlib.DB_NAME)
        pwlib.atomic_write(gz_path, pwlib.dumps(data, compress=True))
        written.append(gz_path)
    return written


def main(argv: "list[str] | None" = None) -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(
        prog="build_db",
        description="密码库构建/清洗工具（零依赖）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument(
        "--from",
        dest="sources",
        nargs="*",
        metavar="FILE",
        help="输入文件或目录；默认仓库自带的 passwords_local.json.gz",
    )
    ap.add_argument("--out", default=repo_root, help="输出目录，默认仓库根目录")
    ap.add_argument("--check", action="store_true", help="只体检，不写文件")
    ap.add_argument(
        "--dedupe-passwords", action="store_true", help="同一密码只保留一个 MD5"
    )
    ap.add_argument("--no-gz", action="store_true", help="不生成压缩版")
    ap.add_argument("--report", metavar="FILE", help="把剔除记录写到指定 JSON 文件")
    args = ap.parse_args(argv)

    sources = args.sources or [os.path.join(repo_root, pwlib.DB_NAME)]
    print(f"🔧 输入源: {', '.join(sources)}")

    raw = collect(sources)
    good, rejected = clean(raw, dedupe_passwords=args.dedupe_passwords)

    print(f"📊 原始 {len(raw)} 条 → 有效 {len(good)} 条，剔除 {len(rejected)} 条")

    # 数据健康度提示
    dup_vals = len(good) - len(set(good.values()))
    if dup_vals:
        print(f"ℹ️  有 {dup_vals} 条记录与其他记录密码相同（未处理，可用 --dedupe-passwords）")
    for row in rejected[:10]:
        print(f"   ✗ {row['md5']}  {row['reason']}")

    if args.report and rejected:
        pwlib.atomic_write(
            args.report,
            json.dumps(rejected, ensure_ascii=False, indent=2).encode("utf-8"),
        )
        print(f"📝 剔除记录已写入 {args.report}")

    if args.check:
        stats = pwlib.Store(os.path.join(args.out, pwlib.DB_NAME)).stats()
        print("🩺 体检结果:")
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 1 if rejected else 0

    written = write_outputs(good, args.out, also_gz=not args.no_gz)
    for path in written:
        print(f"✅ 已写入 {path} ({os.path.getsize(path)} 字节)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

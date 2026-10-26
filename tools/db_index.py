#!/usr/bin/env python3
"""db_index —— 扫描目录，生成/更新多库清单 dbs.json。

网页端、服务端、CLI 都按这份清单决定「一个目录下有哪几个库、谁优先」。

示例：
  python3 tools/db_index.py                    # 扫描仓库根目录，写 dbs.json
  python3 tools/db_index.py dbs/               # 扫描指定目录
  python3 tools/db_index.py --check            # 只体检，不写文件
  python3 tools/db_index.py --json             # 机器可读输出

清单格式：
  {"version": 1,
   "dbs": [{"name": "主库", "file": "passwords_local.json"},
           {"name": "投稿库", "file": "community_passwords.json"}]}
  * 数组顺序 = 查询优先级（靠前的库优先）
  * enabled: false 可以临时停用某个库而不删条目
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pwlib  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(prog="db_index", description="生成/更新多库清单 dbs.json")
    ap.add_argument("dir", nargs="?", default=REPO, help="要扫描的目录，默认仓库根目录")
    ap.add_argument("--out", help="清单输出路径，默认 <dir>/dbs.json")
    ap.add_argument("--check", action="store_true", help="只体检，不写文件")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    directory = os.path.abspath(os.path.expanduser(args.dir))
    try:
        entries = pwlib.scan_db_dir(directory, use_index=True)
    except pwlib.DBError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 3

    rows = []
    total = 0
    for name, path in entries:
        try:
            with open(path, "rb") as fh:
                count = len(pwlib.loads(fh.read()))
            total += count
            rows.append({"name": name, "file": os.path.basename(path), "entries": count})
        except Exception as exc:  # noqa: BLE001
            rows.append({"name": name, "file": os.path.basename(path), "entries": 0, "error": str(exc)})

    if args.json:
        print(json.dumps({"dir": directory, "dbs": rows, "entries": sum(r["entries"] for r in rows)}, ensure_ascii=False, indent=2))
    else:
        print(f"📁 {directory}")
        for i, row in enumerate(rows):
            tag = "优先" if i == 0 else f"第 {i + 1} 库"
            err = f"  ⚠️ {row.get('error')}" if row.get("error") else ""
            print(f"  {i + 1}. {row['name']:<20} {row['file']:<32} {row['entries']:>6} 条  [{tag}]{err}")
        print(f"  合计 {len(rows)} 个库 / {total} 条")

    if args.check:
        print("✅ 体检完成，未写入清单")
        return 0

    try:
        payload = pwlib.write_index(directory, path=args.out)
    except pwlib.DBError as exc:
        print(f"❌ 写入清单失败: {exc}", file=sys.stderr)
        return 3
    target = args.out or os.path.join(directory, pwlib.INDEX_NAME)
    print(f"✅ 已写入 {target}（{len(payload['dbs'])} 个库，顺序即优先级）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

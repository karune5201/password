#!/usr/bin/env python3
import os
import json
import zlib

# 源文件（gz 压缩）
SRC_FILE = "passwords_local.json.gz"

# 输出文件（普通 JSON）
OUT_FILE = "passwords_local.json"

def main():
    if not os.path.exists(SRC_FILE):
        print(f"❌ 源文件不存在: {SRC_FILE}")
        return

    # 读取并解压 gz
    with open(SRC_FILE, "rb") as f:
        compressed = f.read()
        decompressed = zlib.decompress(compressed).decode()
        data = json.loads(decompressed)

    # 转换为网页可用格式（MD5: password）
    web_data = {k: v for k, v in data.items()}

    # 写入普通 JSON 文件
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(web_data, f, ensure_ascii=False, separators=(",", ":"))

    print(f"✅ 已生成网页可用 JSON 文件: {OUT_FILE}")
    print("你可以把此文件上传到 GitHub Pages / Cloudflare Pages，前端直接 fetch 使用。")

if __name__ == "__main__":
    main()

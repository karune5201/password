#!/usr/bin/env python3
"""兼容入口 —— 老用法 `python 2.py` 现在等价于仓库的库构建/清洗工具。

真正的实现在 tools/build_db.py：

    python 2.py                 # 体检 + 清洗 + 重新生成 gz 与网页版 JSON
    python 2.py --check         # 只体检
    python 2.py --from a.json   # 从指定文件构建
    python 2.py --report bad.json
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))

from build_db import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""兼容入口 —— 老用户照旧执行 `python 1.py` 即可。

现在真正的实现位于 cli/pwdkit.py（子命令式 CLI）。
不带参数运行等价于 `pwdkit menu`，进入交互菜单；
带参数运行则原样转发，例如：

    python 1.py query 619293e69a6b5a90be2c04a6e3bf4715
    python 1.py extract 影片.7z
    python 1.py doctor
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "cli"))
sys.path.insert(0, os.path.join(HERE, "tools"))

from pwdkit import main  # noqa: E402


if __name__ == "__main__":
    argv = sys.argv[1:]
    raise SystemExit(main(argv if argv else ["menu"]))

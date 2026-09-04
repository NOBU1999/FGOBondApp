#!/usr/bin/env python3
"""PyInstaller 启动入口。

直接运行：python engine_launcher.py --mode=calculate
打包后 engine.exe 等同此入口。
"""

import sys

from engine.main import main

if __name__ == "__main__":
    raise SystemExit(main())

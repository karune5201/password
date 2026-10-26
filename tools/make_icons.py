#!/usr/bin/env python3
"""make_icons —— 生成 PWA 所需的 PNG 图标（纯标准库，不依赖 Pillow）。

画法：圆角方形渐变底 + 圆环 + 斜向钥匙杆 + 两个齿。
运行：python3 tools/make_icons.py
"""

from __future__ import annotations

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

BG_TOP = (15, 23, 42)
BG_BOTTOM = (5, 46, 22)
KEY_START = (74, 222, 128)
KEY_END = (34, 211, 238)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    cx, cy = ax + t * vx, ay + t * vy
    return math.hypot(px - cx, py - cy)


def render(size: int) -> bytes:
    """返回 512 归一化坐标下的 RGBA 像素数据（size × size × 4）。"""
    scale = size / 512.0
    radius = 112 * scale
    pixels = bytearray()

    # 钥匙几何（512 坐标系，单位像素）
    ring_c = (204.0, 204.0)
    ring_r = 62.0
    ring_w = 34.0
    stem_a, stem_b = (248.0, 248.0), (392.0, 392.0)
    stem_w = 30.0
    teeth = [((330.0, 290.0), (356.0, 264.0)), ((286.0, 334.0), (312.0, 308.0))]
    tooth_w = 13.0

    for y in range(size):
        for x in range(size):
            # 圆角矩形遮罩（抗锯齿：按中心点距离判断 4 次采样）
            alpha = 0
            for dx, dy in ((0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)):
                sx = (x + dx) / scale
                sy = (y + dy) / scale
                cx = min(max(sx, radius), 512 - radius)
                cy = min(max(sy, radius), 512 - radius)
                if math.hypot(sx - cx, sy - cy) <= radius:
                    alpha += 1
            if alpha == 0:
                pixels += b"\x00\x00\x00\x00"
                continue

            t = (x + y) / max(1, (size * 2 - 2))
            color = lerp(BG_TOP, BG_BOTTOM, t)

            # 钥匙部分（在 512 坐标系里判断）
            sx = (x + 0.5) / scale
            sy = (y + 0.5) / scale
            d_ring = abs(math.hypot(sx - ring_c[0], sy - ring_c[1]) - ring_r)
            in_ring = d_ring <= ring_w / 2
            d_stem = dist_to_segment(sx, sy, *stem_a, *stem_b)
            in_stem = d_stem <= stem_w / 2
            in_tooth = any(
                dist_to_segment(sx, sy, *t0, *t1) <= tooth_w for t0, t1 in teeth
            )
            if in_ring or in_stem or in_tooth:
                kt = (sx + sy) / 1024.0
                color = lerp(KEY_START, KEY_END, kt)

            a = int(round(255 * alpha / 4))
            pixels += bytes((color[0], color[1], color[2], a))
    return bytes(pixels)


def write_png(path: str, size: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0
        raw += rgba[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    print(f"✅ {path} ({len(png)} 字节)")


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (192, 512):
        rgba = render(size)
        write_png(os.path.join(OUT_DIR, f"icon-{size}.png"), size, rgba)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

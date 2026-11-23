#!/usr/bin/env python3
"""Generates sample 1920x1080 dashboard screenshots for testing the publish -> display flow.

Usage: python3 scripts/make-sample-dashboards.py OUTPUT_DIR [--count N]
Requires Pillow (pip install pillow). Each image shows the time it was generated, so you can
tell on the display that a fresh set arrived.
"""
import argparse
import datetime
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PANELS = [
    ("Build health", (31, 122, 85)),
    ("Service latency", (46, 91, 138)),
    ("Open incidents", (150, 60, 60)),
    ("Deploy frequency", (120, 80, 160)),
    ("Error budget", (176, 120, 30)),
    ("Queue depth", (40, 130, 140)),
]


def font(size, bold=False):
    names = ["DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", "Arial Bold.ttf" if bold else "Arial.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--count", type=int, default=4, choices=range(1, len(PANELS) + 1))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rng = random.Random()
    for index, (title, color) in enumerate(PANELS[: args.count], 1):
        image = Image.new("RGB", (1920, 1080), (16, 24, 32))
        draw = ImageDraw.Draw(image)
        draw.rectangle([0, 0, 1920, 140], fill=color)
        draw.text((80, 35), f"Sample {index}: {title}", font=font(60, True), fill="white")
        for bar in range(8):
            height = rng.randint(120, 640)
            left = 140 + bar * 210
            draw.rectangle([left, 920 - height, left + 150, 920], fill=color)
        draw.text((80, 980), f"Generated {stamp}", font=font(32), fill=(189, 203, 216))
        path = args.output_dir / f"{index:02d}-{title.lower().replace(' ', '-')}.png"
        # Write then rename, so a publisher running concurrently never reads a half-written file.
        temp = path.with_suffix(".tmp")
        image.save(temp, format="PNG", optimize=True)
        temp.replace(path)
        print(path)


if __name__ == "__main__":
    main()

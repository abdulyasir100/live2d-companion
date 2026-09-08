"""Stitch the captured expression frames into one labelled strip for review."""
from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

src = Path(sys.argv[1] if len(sys.argv) > 1 else "F:/OS/faces.json")
out = Path(sys.argv[2] if len(sys.argv) > 2 else "F:/OS/live2d-companion/faces.png")

raw = src.read_text().strip()
if raw.startswith('"'):  # the evaluate result arrives JSON-encoded
    raw = json.loads(raw)
data = json.loads(raw)

frames = [("neutral", data["neutral"])] + list(data["frames"].items())
imgs = [(n, Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB")) for n, b in frames]

w, h = imgs[0][1].size
sheet = Image.new("RGB", (w * len(imgs), h + 18), "white")
draw = ImageDraw.Draw(sheet)
for i, (name, img) in enumerate(imgs):
    sheet.paste(img, (i * w, 0))
    draw.text((i * w + 4, h + 4), name, fill="black")
sheet.save(out)
print(f"wrote {out} {sheet.size} from {len(imgs)} frames")

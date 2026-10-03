"""
Regenerate the extension icons from public/logo.png.
Run with: python3 scripts/generate-icons.py  (requires Pillow)

The icons are used as alpha masks at runtime (the toolbar icon and the
in-app <Logo> are tinted with the active theme primary), so the white
"SBC" lettering is cut out as transparency rather than kept as white
pixels. The disc keeps the logo's blue for the static manifest icons.
"""
import base64
import io
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'public' / 'logo.png'
ICON_DIR = ROOT / 'public' / 'icons'
SIZES = [16, 32, 48, 128]
BLUE = (0, 152, 234)


def silhouette() -> Image.Image:
    src = Image.open(SOURCE).convert('RGBA')
    out = Image.new('RGBA', src.size)
    pixels = []
    for r, _g, _b, a in src.getdata():
        # The disc has R=0 and the lettering R=255, so red measures how
        # much of a pixel is lettering (anti-aliased edges in between).
        alpha = round(a * (1 - r / 255))
        pixels.append((*BLUE, alpha))
    out.putdata(pixels)
    return out


def svg_wrapping(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    data = base64.b64encode(buf.getvalue()).decode('ascii')
    w, h = img.size
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n'
        f'  <image width="{w}" height="{h}" href="data:image/png;base64,{data}"/>\n'
        '</svg>\n'
    )


def main() -> None:
    base = silhouette()
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        base.resize((size, size), Image.LANCZOS).save(ICON_DIR / f'icon-{size}.png', optimize=True)
    svg = svg_wrapping(base)
    (ICON_DIR / 'logo.svg').write_text(svg)
    (ROOT / 'src' / 'assets' / 'logo.svg').write_text(svg)
    print('Wrote', ', '.join(f'icon-{s}.png' for s in SIZES), '+ logo.svg')


if __name__ == '__main__':
    main()

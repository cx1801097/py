"""Rebuild images/ from the original prototype artwork.

The prototype shipped its art as .webp files, and every sprite image was a
full 800x600 canvas with the real sprite parked somewhere inside it.  Loading
those directly makes every Actor gigantic and puts the sprite off-centre, so
this script trims the transparent padding, resizes the background to the
window, and writes clean PNG files (Pygame Zero's preferred format).

Usage:
    py -3.13 tools/build_assets.py [source_folder]

If no folder is given, it uses the PROTOTYPE_DIR environment variable or the
Downloads folder the prototype came from.
"""

import os
import sys
from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
IMAGES_DIR = PROJECT_ROOT / "images"
DEFAULT_SOURCE = Path(r"C:\Users\thqwe\Downloads\Folder-Open")

# name -> target size (None keeps the trimmed size)
SPRITES = {
    "player": None,
    "coin": None,
    "platform": (50, 24),   # matches TILE_W x TILE_H in main.py
    "spikes": (50, 24),
}


def trim(image):
    """Crop a transparent image down to the pixels that are actually visible."""
    image = image.convert("RGBA")
    bounds = image.getchannel("A").getbbox()
    return image.crop(bounds) if bounds else image


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        os.environ.get("PROTOTYPE_DIR", DEFAULT_SOURCE)
    )

    if not source.is_dir():
        sys.exit(f"Artwork folder not found: {source}")

    IMAGES_DIR.mkdir(exist_ok=True)

    background = Image.open(source / "background.webp").convert("RGB")
    background = background.resize((800, 600), Image.LANCZOS)
    background.save(IMAGES_DIR / "background.png", optimize=True)
    print(f"background.png  800x600")

    for name, size in SPRITES.items():
        sprite = trim(Image.open(source / f"{name}.webp"))
        if size:
            # NEAREST keeps the chunky pixel-art edges intact.
            sprite = sprite.resize(size, Image.NEAREST)
        sprite.save(IMAGES_DIR / f"{name}.png", optimize=True)
        print(f"{name + '.png':15} {sprite.width}x{sprite.height}")


if __name__ == "__main__":
    main()

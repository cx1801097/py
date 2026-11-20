"""Build the browser version of Skyward Scramble.

Reads the PNG art and the pixel font from the project, base64-encodes them
and writes a single self-contained ``index.html`` next to ``main.py``.

The generated page has no external dependencies at all, so it runs both from
``file://`` (double-click) and from any static web server.

Usage:
    py -3 tools/build_web.py
"""

import base64
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES_DIR = os.path.join(PROJECT_ROOT, "images")
FONTS_DIR = os.path.join(PROJECT_ROOT, "fonts")
OUTPUT = os.path.join(PROJECT_ROOT, "index.html")

IMAGE_FILES = {
    "background": "background.png",
    "player": "player.png",
    "coin": "coin.png",
    "platform": "platform.png",
    "spikes": "spikes.png",
}

FONT_FILE = os.path.join(FONTS_DIR, "font.ttf")


def data_uri(path, mime):
    """Return a base64 data URI for a file on disk."""
    with open(path, "rb") as handle:
        payload = base64.b64encode(handle.read()).decode("ascii")
    return f"data:{mime};base64,{payload}"


def build_assets():
    """Collect every asset as a data URI, ready to be inlined."""
    assets = {}
    for key, name in IMAGE_FILES.items():
        path = os.path.join(IMAGES_DIR, name)
        if not os.path.exists(path):
            raise SystemExit(f"missing image: {path}")
        assets[key] = data_uri(path, "image/png")
    if not os.path.exists(FONT_FILE):
        raise SystemExit(f"missing font: {FONT_FILE}")
    assets["font"] = data_uri(FONT_FILE, "font/ttf")
    return assets


def build_html(assets):
    """Fill the HTML template with the inlined assets."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "game.js"), encoding="utf-8") as handle:
        script = handle.read()

    html = HTML_TEMPLATE.replace("/*__GAME_JS__*/", script)
    html = html.replace("__FONT_URI__", assets["font"])
    for key in IMAGE_FILES:
        html = html.replace(f"__{key.upper()}_URI__", assets[key])
    return html


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Skyward Scramble</title>
<style>
@font-face {
    font-family: 'PressStart2P';
    src: url('__FONT_URI__') format('truetype');
    font-display: swap;
}

:root {
    --bg-0: #0b0e18;
    --bg-1: #141a2b;
    --accent: #ffd65c;
    --text: #f2f6ff;
    --muted: #a9b6d0;
    --panel: rgba(16, 20, 36, 0.85);
}

* { box-sizing: border-box; }

html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    background: radial-gradient(circle at 50% 0%, var(--bg-1) 0%, var(--bg-0) 70%);
    color: var(--text);
    font-family: 'PressStart2P', 'Courier New', monospace;
    -webkit-text-size-adjust: 100%;
}

body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 14px;
    padding: 18px 14px 28px;
}

header {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
}

h1 {
    margin: 0;
    font-size: clamp(14px, 3.4vw, 26px);
    letter-spacing: 1px;
    color: var(--accent);
    text-shadow: 0 3px 0 #000;
}

.subtitle {
    margin: 0;
    font-size: clamp(7px, 1.5vw, 10px);
    color: var(--muted);
    line-height: 1.8;
}

.best-outside {
    font-size: clamp(8px, 1.6vw, 11px);
    color: var(--text);
    background: var(--panel);
    border: 2px solid rgba(255, 214, 92, 0.35);
    border-radius: 8px;
    padding: 10px 14px;
}

.best-outside span { color: var(--accent); }

.stage {
    width: min(100%, 800px);
    aspect-ratio: 800 / 600;
    display: flex;
    align-items: center;
    justify-content: center;
}

canvas {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border-radius: 10px;
    border: 3px solid rgba(255, 214, 92, 0.45);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
    background: #0b0e18;
    touch-action: none;
    outline: none;
}

canvas:focus-visible {
    border-color: rgba(255, 214, 92, 0.9);
}

.touch-controls {
    width: min(100%, 800px);
    display: none;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    user-select: none;
    -webkit-user-select: none;
}

.touch-controls .cluster {
    display: flex;
    gap: 12px;
}

button.pad {
    font-family: 'PressStart2P', monospace;
    font-size: 14px;
    color: var(--text);
    background: linear-gradient(180deg, #2a3350, #1a2036);
    border: 2px solid rgba(255, 214, 92, 0.4);
    border-radius: 12px;
    min-width: 68px;
    min-height: 62px;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    box-shadow: 0 4px 0 rgba(0, 0, 0, 0.45);
}

button.pad:active,
button.pad.active {
    transform: translateY(3px);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.45);
    background: linear-gradient(180deg, #3a4870, #232c48);
}

/* The on-screen pads must not steal Space/Enter from the game. */
button.pad:focus { outline: none; }
button.pad:focus-visible { outline: 2px solid rgba(255, 214, 92, 0.8); }

button.pad.jump {
    border-color: rgba(255, 214, 92, 0.75);
    color: var(--accent);
    min-width: 96px;
}

footer {
    width: min(100%, 800px);
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
}

.keys {
    font-size: clamp(7px, 1.5vw, 10px);
    color: var(--muted);
    line-height: 2;
    text-align: center;
}

.keys b { color: var(--text); }

@media (hover: none) and (pointer: coarse) {
    .touch-controls { display: flex; }
}

@media (max-width: 560px) {
    .touch-controls { display: flex; }
    button.pad { min-width: 58px; min-height: 54px; font-size: 12px; }
}

/* Devices that report touch support but a fine pointer (hybrid laptops,
   tablets with a mouse) still get the pads. */
body.has-touch .touch-controls { display: flex; }

/* A manual switch, so the pads are always reachable. */
.toggle-row {
    width: min(100%, 800px);
    display: flex;
    justify-content: center;
}

.pads-toggle {
    display: inline-block;
    font-family: 'PressStart2P', monospace;
    font-size: 9px;
    color: var(--muted);
    background: transparent;
    border: 1px solid rgba(255, 214, 92, 0.3);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
}

.pads-toggle:hover { color: var(--accent); border-color: rgba(255, 214, 92, 0.7); }
</style>
</head>
<body>

<header>
    <h1>SKYWARD SCRAMBLE</h1>
    <p class="subtitle">An endless climbing tower of stone, spikes and coins.</p>
    <div class="best-outside">BEST <span id="best-outside">0</span></div>
</header>

<div class="stage">
    <canvas id="game" width="800" height="600" tabindex="0"></canvas>
</div>

<div class="touch-controls" id="touch-controls">
    <div class="cluster">
        <button class="pad" id="pad-left" type="button" aria-label="Move left">&#9664;</button>
        <button class="pad" id="pad-right" type="button" aria-label="Move right">&#9654;</button>
    </div>
    <div class="cluster">
        <button class="pad jump" id="pad-jump" type="button" aria-label="Jump">JUMP</button>
    </div>
</div>

<div class="toggle-row" id="pads-toggle-row">
    <button class="pads-toggle" id="pads-toggle" type="button">SHOW TOUCH PADS</button>
</div>

<footer>
    <div class="keys">
        <b>&larr; &rarr;</b> or <b>A</b> / <b>D</b> to move &nbsp;&middot;&nbsp;
        <b>SPACE</b> / <b>&uarr;</b> / <b>W</b> to jump &nbsp;&middot;&nbsp;
        <b>SPACE</b> to retry after a game over
    </div>
    <div class="keys">Collect coins, dodge the spikes, and beat your own best score.</div>
</footer>

<script>
/*__GAME_JS__*/
</script>
</body>
</html>
"""


def main():
    assets = build_assets()
    html = build_html(assets)
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(html)
    size = os.path.getsize(OUTPUT)
    print(f"wrote {OUTPUT} ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()

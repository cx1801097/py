"""Check that the JavaScript port still matches main.py.

Parses the constants and a few key expressions out of both files and
compares them, so a change to main.py that is not mirrored in the browser
version is caught immediately.

Usage:
    py -3.13 tools/portcheck.py
"""

import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(PROJECT_ROOT, "main.py")
GAME_JS = os.path.join(PROJECT_ROOT, "tools", "game.js")
INDEX_HTML = os.path.join(PROJECT_ROOT, "index.html")

# Constants that must match one for one.
CONSTANTS = [
    "WIDTH", "HEIGHT", "TILE_W", "TILE_H", "GROUND_Y", "ROW_GAP", "ROW_COUNT",
    "TILES_PER_ROW", "ROW_MIN_X", "ROW_MAX_X", "PLATFORM_SPAN",
    "BASE_PLATFORM_SPEED", "PLAYER_W", "PLAYER_H", "MOVE_SPEED", "JUMP_SPEED",
    "GRAVITY", "MAX_FALL_SPEED", "COYOTE_TIME", "JUMP_BUFFER",
    "LANDING_TOLERANCE", "COIN_POINTS", "COINS_ON_SCREEN", "COINS_PER_UPGRADE",
    "PLATFORM_SPEED_STEP", "MAX_PLATFORM_SPEED", "MAX_HEALTH", "SPIKE_DAMAGE",
    "SPIKE_COOLDOWN", "SPIKE_HEIGHT", "SPIKE_KNOCKBACK", "SPIKE_KNOCKBACK_JUMP",
    "HINT_SECONDS", "RETRY_DELAY", "UPGRADE_FLASH_SECONDS",
]


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def python_constants(text):
    values = {}
    for name in CONSTANTS:
        match = re.search(rf"^{name}\s*=\s*([^\n#]+)", text, re.M)
        if match:
            values[name] = match.group(1).strip().rstrip(",")
    return values


def js_constants(text):
    values = {}
    for name in CONSTANTS:
        match = re.search(rf"const\s+{name}\s*=\s*([^;]+);", text)
        if match:
            values[name] = match.group(1).strip()
    return values


def normalise(value):
    """Make Python and JavaScript literals comparable."""
    value = value.strip().rstrip(",")
    value = value.replace("_", "")
    # Python ints vs JavaScript floats: treat 425 and 425.0 as the same.
    try:
        as_float = float(value)
        return f"{as_float:g}"
    except ValueError:
        pass
    # PLAYER_HALF_W is PLAYER_W // 2 in Python and PLAYER_W / 2 in JS.
    value = value.replace("//", "/")
    return value


def main():
    failures = []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{'  ' + detail if detail else ''}")
        if not ok:
            failures.append(name)

    py_text = read(MAIN_PY)
    js_text = read(GAME_JS)

    print("Constants")
    py_consts = python_constants(py_text)
    js_consts = js_constants(js_text)

    for name in CONSTANTS:
        if name not in py_consts:
            check(f"{name} found in main.py", False)
            continue
        if name not in js_consts:
            check(f"{name} found in game.js", False)
            continue
        py_value = normalise(py_consts[name])
        js_value = normalise(js_consts[name])
        check(f"{name}", py_value == js_value,
              f"py={py_consts[name]} js={js_consts[name]}")

    print("Behavioural markers")
    markers = [
        ("jump needs on_ground only", r"jump_buffer_timer\s*>\s*0\s+and\s+on_ground",
         r"jumpBufferTimer\s*>\s*0\s*&&\s*onGround"),
        ("one-way landing tolerance", r"old_feet\s*<=\s*top\s*\+\s*LANDING_TOLERANCE",
         r"oldFeet\s*<=\s*top\s*\+\s*LANDING_TOLERANCE"),
        ("rising head bump", r"old_head\s*>=\s*bottom\s*-\s*LANDING_TOLERANCE",
         r"oldHead\s*>=\s*bottom\s*-\s*LANDING_TOLERANCE"),
        ("carry by height", r"abs\(feet_now\s*-\s*tile\.top_y\)\s*>\s*LANDING_TOLERANCE",
         r"Math\.abs\(feetNow\s*-\s*tile\.topY\)\s*>\s*LANDING_TOLERANCE"),
        ("spike sideways knockback", r"player\.x\s*\+=\s*away\s*\*\s*SPIKE_KNOCKBACK",
         r"player\.x\s*\+=\s*away\s*\*\s*SPIKE_KNOCKBACK"),
        ("spike hop", r"y_velocity\s*=\s*-SPIKE_KNOCKBACK_JUMP",
         r"yVelocity\s*=\s*-SPIKE_KNOCKBACK_JUMP"),
        ("spike danger height", r"SPIKE_HEIGHT", r"SPIKE_HEIGHT"),
        ("keep spawn clear", r"def keep_spawn_clear", r"function keepSpawnClear"),
        ("spike would hit", r"def spike_would_hit", r"function spikeWouldHit"),
        ("dt clamp", r"dt\s*=\s*min\(dt,\s*0\.05\)", r"Math\.min\(dt,\s*0\.05\)"),
        ("score minus one on hit", r"score\s*=\s*max\(0,\s*score\s*-\s*1\)",
         r"score\s*=\s*Math\.max\(0,\s*score\s*-\s*1\)"),
        ("health minus damage", r"health\s*=\s*max\(0,\s*health\s*-\s*SPIKE_DAMAGE\)",
         r"health\s*=\s*Math\.max\(0,\s*health\s*-\s*SPIKE_DAMAGE\)"),
    ]
    for name, py_pattern, js_pattern in markers:
        check(name,
              re.search(py_pattern, py_text) is not None and
              re.search(js_pattern, js_text) is not None)

    print("Generated page")
    html = read(INDEX_HTML)
    check("index.html has a canvas", "<canvas" in html)
    check("index.html inlines 5 PNG images",
          html.count("data:image/png;base64,") == 5,
          f"({html.count('data:image/png;base64,')})")
    check("index.html inlines the font", html.count("data:font/ttf;base64,") == 1)
    check("index.html has no leftover placeholders",
          re.findall(r"__[A-Z_]+_URI__", html) == [])
    check("index.html embeds the current game.js",
          read(GAME_JS).strip()[:400] in html)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        sys.exit(1)
    print("The browser port matches main.py.")


if __name__ == "__main__":
    main()

"""Compare the full physics trace of main.py and the JavaScript port.

Both run the same seeded levels through the same scripted scenario and the
numbers are compared exactly.  Run tools/porttrace.js afterwards to diff the
two traces.

Usage:
    py -3.13 tools/porttrace.py [seed]
"""

import json
import os
import sys
import types

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(PROJECT_ROOT, "main.py")
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame  # noqa: E402
import pgzero.runner as runner  # noqa: E402

sys._pgzrun = True

module = types.ModuleType("main")
module.__file__ = MAIN_PY
sys.modules["main"] = module
runner.prepare_mod(module)
module.__name__ = "main"
module.__file__ = MAIN_PY
with open(MAIN_PY, encoding="utf-8") as handle:
    exec(compile(handle.read(), MAIN_PY, "exec"), module.__dict__)

game = module


class FakeKeyboard:
    def __init__(self):
        self.left = self.right = self.a = self.d = False


game.keyboard = FakeKeyboard()
DT = 1 / 60
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7


def mulberry32(seed):
    state = seed & 0xFFFFFFFF

    def rng():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = (state ^ (state >> 15)) & 0xFFFFFFFF
        t = (t * (state | 2)) & 0xFFFFFFFF
        t = (t ^ (t >> 7)) & 0xFFFFFFFF
        t = (t * (state | 3)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rng


def build_seeded_level(seed):
    rng = mulberry32(seed)

    def rng_int(lo, hi):
        return lo + int(rng() * (hi - lo + 1))

    game.platforms.clear()
    game.spikes.clear()
    game.coins.clear()

    for x in range(game.TILE_W // 2, game.WIDTH, game.TILE_W):
        game.platforms.append(game.Platform(x, game.GROUND_Y))

    previous_x = rng_int(225, 425)
    for index in range(game.ROW_COUNT):
        y = game.GROUND_Y - game.ROW_GAP * (index + 1)
        start_x = previous_x + rng_int(-220, 220)
        start_x = max(game.ROW_MIN_X, min(game.ROW_MAX_X, start_x))
        moving = index > 0
        speed = game.BASE_PLATFORM_SPEED if moving else 0.0
        direction = -1 if rng() < 0.5 else 1
        for column in range(game.TILES_PER_ROW):
            game.platforms.append(
                game.Platform(
                    start_x + column * game.TILE_W, y, speed,
                    game.PLATFORM_SPAN, direction,
                )
            )
        previous_x = start_x

    # One spike per floating row, as build_level() does.
    rows = {}
    for tile in game.platforms:
        if tile.y < game.GROUND_Y:
            rows.setdefault(tile.y, []).append(tile)
    for y in sorted(rows):
        game.spikes.append(game.Spike(rows[y][0]))

    for _ in range(game.COINS_ON_SCREEN):
        game.spawn_coin()


def r(value):
    return round(float(value), 4)


def run_scenario(seed, frames, hold_right, hold_left, jump_frames):
    """Run a scripted scenario and record the resulting state."""
    game.start_game()
    build_seeded_level(seed)

    game.keyboard.right = hold_right
    game.keyboard.left = hold_left
    for _ in range(frames):
        game.update(DT)
    game.keyboard.right = False
    game.keyboard.left = False

    if jump_frames:
        game.on_key_down(game.keys.SPACE)
        for _ in range(jump_frames):
            game.update(DT)

    return {
        "x": r(game.player.x),
        "y": r(game.player.y),
        "y_velocity": r(game.y_velocity),
        "on_ground": bool(game.on_ground),
        "score": game.score,
        "health": game.health,
        "state": game.state,
        "coins": len(game.coins),
        "spikes": len(game.spikes),
        "platform_x": [r(t.x) for t in game.platforms],
        "player_x": r(game.player.x),
    }


trace = {}

scenarios = [
    ("idle_120", dict(frames=120, hold_right=False, hold_left=False, jump_frames=0)),
    ("idle_300", dict(frames=300, hold_right=False, hold_left=False, jump_frames=0)),
    ("walk_right_60", dict(frames=60, hold_right=True, hold_left=False, jump_frames=0)),
    ("walk_right_180", dict(frames=180, hold_right=True, hold_left=False, jump_frames=0)),
    ("walk_left_120", dict(frames=120, hold_right=False, hold_left=True, jump_frames=0)),
    ("walk_then_jump", dict(frames=90, hold_right=True, hold_left=False, jump_frames=25)),
    ("jump_from_rest", dict(frames=120, hold_right=False, hold_left=False, jump_frames=1)),
    ("long_run_600", dict(frames=600, hold_right=False, hold_left=False, jump_frames=0)),
]

for name, kwargs in scenarios:
    trace[name] = run_scenario(SEED * 1000, **kwargs)

print(json.dumps(trace, indent=2, sort_keys=True))

out = os.path.join(PROJECT_ROOT, "tools", "py_porttrace.json")
with open(out, "w", encoding="utf-8") as handle:
    json.dump(trace, handle, indent=2, sort_keys=True)
print(f"\nwrote {out}")

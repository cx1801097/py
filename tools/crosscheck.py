"""Cross-check the JS port against the real Pygame Zero original.

Installs an identical deterministic level in both implementations and runs the
same scenario, printing a machine-readable trace that tools/webtest.js can be
compared against.

Usage:
    py -3.13 tools/crosscheck.py
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


def build_fixed_level():
    """Install the exact same deterministic layout the JS harness uses."""
    game.platforms.clear()
    game.spikes.clear()
    game.coins.clear()

    for x in range(game.TILE_W // 2, game.WIDTH, game.TILE_W):
        game.platforms.append(game.Platform(x, game.GROUND_Y))

    row_spec = [
        (game.GROUND_Y - game.ROW_GAP * 1, 300, 0.0, 1),
        (game.GROUND_Y - game.ROW_GAP * 2, 200, game.BASE_PLATFORM_SPEED, 1),
        (game.GROUND_Y - game.ROW_GAP * 3, 400, game.BASE_PLATFORM_SPEED, -1),
    ]
    for y, start_x, speed, direction in row_spec:
        for column in range(game.TILES_PER_ROW):
            game.platforms.append(
                game.Platform(
                    start_x + column * game.TILE_W,
                    y,
                    speed,
                    game.PLATFORM_SPAN if speed > 0 else 0.0,
                    direction,
                )
            )

    game.spikes.append(game.Spike(game.platforms[18]))
    for _ in range(game.COINS_ON_SCREEN):
        game.spawn_coin()


def step(frames=1, dt=1 / 60):
    for _ in range(frames):
        game.update(dt)


def r(value):
    return round(float(value), 6)


trace = {}

# --- level shape ----------------------------------------------------------
build_fixed_level()
trace["ground_tiles"] = len([t for t in game.platforms if t.y == game.GROUND_Y])
trace["floating_rows"] = sorted({t.y for t in game.platforms if t.y < game.GROUND_Y})
trace["tiles_per_row"] = [
    len([t for t in game.platforms if t.y == y]) for y in trace["floating_rows"]
]
trace["spikes"] = len(game.spikes)
trace["coins"] = len(game.coins)

# --- landing --------------------------------------------------------------
build_fixed_level()
game.player.pos = game.PLAYER_START
step(180)
trace["landing_feet"] = r(game.player.y + game.PLAYER_HALF_H)
trace["landing_on_ground"] = game.on_ground

# --- walking --------------------------------------------------------------
build_fixed_level()
game.player.pos = game.PLAYER_START
step(180)
start_x = game.player.x
game.keyboard.right = True
step(30)
game.keyboard.right = False
trace["walk_delta"] = r(game.player.x - start_x)

# --- jump -----------------------------------------------------------------
build_fixed_level()
game.player.pos = game.PLAYER_START
step(120)
ground_y = game.player.y
game.on_key_down(game.keys.SPACE)
step(1)
trace["jump_velocity"] = r(game.y_velocity)
step(20)
trace["jump_rise"] = r(game.player.y - ground_y)
trace["jump_apex_y"] = r(game.player.y)

# --- jump apex over a longer window ---------------------------------------
build_fixed_level()
game.player.pos = game.PLAYER_START
step(120)
apex = game.player.y
for _ in range(120):
    step(1)
    apex = min(apex, game.player.y)
trace["apex_delta"] = r(apex - game.player.y)

# --- moving platform carry ------------------------------------------------
build_fixed_level()
mover = [t for t in game.platforms if t.speed > 0][0]
before_x = mover.x
drift = 0.0
for _ in range(45):
    step(1)
    drift = max(drift, abs(mover.x - before_x))
trace["platform_drift"] = r(drift)
trace["platform_within_track"] = abs(mover.x - mover.base_x) <= mover.span + 1

# --- coin pickup ----------------------------------------------------------
build_fixed_level()
coin = game.coins[0]
game.player.x = coin.x
game.player.y = coin.y
score_before = game.score
step(1)
trace["coin_score_delta"] = game.score - score_before
trace["coins_after_pickup"] = len(game.coins)

# --- spike damage ---------------------------------------------------------
build_fixed_level()
spike = game.spikes[0]
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - game.PLAYER_HALF_H
game.y_velocity = 0
game.on_ground = True
game.hurt_timer = 0
step(1)
trace["health_after_spike"] = game.health
trace["spike_knockback_velocity"] = r(game.y_velocity)
step(10)
trace["health_after_10_frames"] = game.health
step(40)
trace["health_after_50_frames"] = game.health

# --- difficulty ramp ------------------------------------------------------
build_fixed_level()
base_speed = max(t.speed for t in game.platforms)
start_spikes = len(game.spikes)
game.score = game.COINS_PER_UPGRADE
game.apply_difficulty()
trace["spikes_after_upgrade"] = len(game.spikes)
trace["max_speed_after_upgrade"] = r(max(t.speed for t in game.platforms))
trace["base_speed"] = r(base_speed)

# --- game over / retry ----------------------------------------------------
build_fixed_level()
game.health = game.SPIKE_DAMAGE
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - game.PLAYER_HALF_H
game.y_velocity = 0
game.on_ground = True
game.hurt_timer = 0
step(1)
trace["state_after_fatal"] = game.state
game.on_key_down(game.keys.SPACE)
step(5)
trace["state_before_retry_delay"] = game.state
step(30)
game.on_key_down(game.keys.SPACE)
step(1)
trace["state_after_retry"] = game.state

# --- long run -------------------------------------------------------------
build_fixed_level()
game.player.pos = game.PLAYER_START
step(300)
trace["state_after_300_frames"] = game.state
trace["player_x_after_300"] = r(game.player.x)
trace["player_y_after_300"] = r(game.player.y)

print(json.dumps(trace, indent=2, sort_keys=True))

out = os.path.join(PROJECT_ROOT, "tools", "py_trace.json")
with open(out, "w", encoding="utf-8") as handle:
    json.dump(trace, handle, indent=2, sort_keys=True)
print(f"\nwrote {out}")

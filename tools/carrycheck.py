"""Reproduce the 'moving platform carries the player' scenario in main.py.

Mirrors the loop in tools/webtest.js so the two implementations can be
compared on exactly the same situation.
"""

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
SEED = int(os.environ.get("SEED", "7"))
game.random.seed(SEED)


def horizontal_overlap(x, tile):
    return (
        x + game.PLAYER_HALF_W > tile.x - game.TILE_W / 2
        and x - game.PLAYER_HALF_W < tile.x + game.TILE_W / 2
    )


def step(n):
    for _ in range(n):
        game.update(DT)


def mulberry32(seed):
    """The same pseudo random generator the JavaScript port uses."""
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
    """Build the same tower the JavaScript port builds for this seed."""
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

    for _ in range(game.COINS_ON_SCREEN):
        game.spawn_coin()


failures = 0
for run in range(20):
    game.start_game()
    build_seeded_level(SEED * 1000 + run)

    tile = None
    for t in game.platforms:
        if not (t.speed > 0 and 150 < t.x < 650):
            continue
        drop_y = t.top_y - (game.PLAYER_H + 2)
        blocked = False
        for o in game.platforms:
            if o is t:
                continue
            if not horizontal_overlap(t.x, o):
                continue
            if (o.top_y - game.PLAYER_HALF_H < drop_y + game.PLAYER_HALF_H
                    and o.top_y + game.TILE_H > drop_y - game.PLAYER_HALF_H):
                blocked = True
                break
        if not blocked:
            tile = t
            break
    if tile is None:
        continue

    game.player.x = tile.x
    game.player.y = tile.top_y - game.PLAYER_HALF_H
    game.y_velocity = 0
    game.on_ground = False
    step(20)
    start_x = game.player.x
    start_tile = tile.x
    step(30)
    player_move = game.player.x - start_x
    tile_move = tile.x - start_tile
    ok = abs(player_move - tile_move) <= 2
    if not ok:
        failures += 1
        if failures <= 3:
            print(f"    player {player_move:.2f} tile {tile_move:.2f} | "
                  f"tileX {tile.x:.1f} top {tile.top_y:.1f} dir {tile.direction} "
                  f"playerY {game.player.y:.1f} onGround {game.on_ground}")

print(f"carry failures in main.py: {failures} / 20")

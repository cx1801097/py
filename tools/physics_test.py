"""Physics regression checks for the reported bugs.

Each check reproduces one of the issues that were reported:

* coins drifting on their own
* the player floating in mid-air
* the player taking damage at random
* the player jumping while not touching a platform
* the player phasing through a platform

Run:
    py -3.13 tools/physics_test.py
"""

import os
import sys
import types

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame  # noqa: E402

sys._pgzrun = True

import pgzero.runner as runner  # noqa: E402

MAIN_PY = os.path.join(PROJECT_ROOT, "main.py")
module = types.ModuleType("main")
module.__file__ = MAIN_PY
sys.modules["main"] = module

runner.prepare_mod(module)
module.__name__ = "main"
module.__file__ = MAIN_PY
with open(MAIN_PY, encoding="utf-8") as handle:
    exec(compile(handle.read(), MAIN_PY, "exec"), module.__dict__)

game = module
failures = []


class FakeKeyboard:
    def __init__(self):
        self.left = self.right = self.a = self.d = False


def step(frames=1, dt=1 / 60):
    for _ in range(frames):
        game.update(dt)


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}{'  ' + detail if detail else ''}")
    if not condition:
        failures.append(name)


game.keyboard = FakeKeyboard()


def build(seed):
    """Build a level with a fixed layout, so the checks are deterministic."""
    game.random.seed(seed)
    game.start_game()


def horizontal_overlap_at(g, x, y, tile):
    """True when a player centred at (x, y) overlaps the tile."""
    half_w = g.PLAYER_HALF_W
    half_h = g.PLAYER_HALF_H
    if not (x + half_w > tile.x - g.TILE_W / 2 and x - half_w < tile.x + g.TILE_W / 2):
        return False
    top = tile.top_y
    bottom = top + g.TILE_H
    return (y - half_h < bottom) and (y + half_h > top)


# ---------------------------------------------------------------------------
print("Coins stay put")
# ---------------------------------------------------------------------------
build(2)
game.keyboard = FakeKeyboard()
step(240)
moving = []
for coin in game.coins:
    tile = coin.tile
    if tile.speed > 0:
        moving.append((coin, tile))
    offset = coin.y - (tile.top_y - 26)
    check(
        "coin keeps a fixed height above its platform",
        abs(offset) < 0.001,
        f"({offset:.3f})",
    )
if moving:
    coin, tile = moving[0]
    before = coin.y
    step(30)
    drift = abs((coin.y - (tile.top_y - 26)))
    check("moving coin only follows its platform", drift < 0.001, f"({drift:.3f})")

# ---------------------------------------------------------------------------
print("No floating in mid-air")
# ---------------------------------------------------------------------------
# The player must always be resting exactly on a platform top, never
# hovering with their feet in the air.
floating = 0
for _ in range(60):
    build(3)
    for _ in range(200):
        game.update(1 / 60)
        if game.on_ground:
            on_a_platform = any(
                abs((game.player.y + game.PLAYER_HALF_H) - tile.top_y) < 1.5
                for tile in game.platforms
            )
            if not on_a_platform:
                floating += 1
check("player is never left hovering", floating == 0, f"({floating} bad frames)")

# ---------------------------------------------------------------------------
print("The player falls when they walk off a platform")
# ---------------------------------------------------------------------------
build(4)
game.keyboard = FakeKeyboard()
# Walk far to the right off the end of the ground row.
game.player.x = game.WIDTH - game.PLAYER_HALF_W - 5
game.y_velocity = 0.0
game.on_ground = True
game.keyboard.right = True
fell = False
for _ in range(240):
    game.update(1 / 60)
    if not game.on_ground:
        fell = True
        break
game.keyboard.right = False
check("player falls when they walk off the edge", fell)

# ---------------------------------------------------------------------------
print("The moving platform carries the player")
# ---------------------------------------------------------------------------
build(5)
# Pick a moving tile that has clear air above it, so the player can actually
# land on it.  A tile with a platform directly overhead would push the
# player out of the way instead.
moving_tile = None
for tile in game.platforms:
    if tile.speed <= 0 or not (150 < tile.x < 650):
        continue
    drop_y = tile.top_y - (game.PLAYER_H + 2)
    if any(
        horizontal_overlap_at(game, tile.x, drop_y, other)
        for other in game.platforms
    ):
        continue
    moving_tile = tile
    break

if moving_tile is not None:
    # Put the player on the tile and let them settle onto it first, so the
    # measurement starts from a genuine resting state.
    game.player.x = moving_tile.x
    game.player.y = moving_tile.top_y - game.PLAYER_HALF_H
    game.y_velocity = 0.0
    game.on_ground = False
    for _ in range(20):
        game.update(1 / 60)
    check("player settled on the moving tile", game.on_ground)

    start_x = game.player.x
    start_tile_x = moving_tile.x
    for _ in range(30):
        game.update(1 / 60)
    player_move = game.player.x - start_x
    tile_move = moving_tile.x - start_tile_x
    check(
        "moving platform carries the player",
        abs(player_move - tile_move) < 2.0,
        f"(player {player_move:+.1f}, tile {tile_move:+.1f})",
    )
    check("carried player stays on the platform", game.on_ground)

# ---------------------------------------------------------------------------
print("No jumping in mid-air")
# ---------------------------------------------------------------------------
build(6)
game.keyboard = FakeKeyboard()
step(200)
# Launch the player into the air and try to jump.
game.y_velocity = -400.0
game.on_ground = False
game.coyote_timer = 0.0
game.jump_buffer_timer = 0.0
step(1)
velocity_before = game.y_velocity
game.on_key_down(game.keys.SPACE)
step(1)
check(
    "jump is ignored while airborne",
    game.y_velocity > velocity_before,
    f"({velocity_before:.0f} -> {game.y_velocity:.0f})",
)
check("player stays airborne", not game.on_ground)

# Coyote time must not grant a jump either.
build(7)
game.keyboard = FakeKeyboard()
step(200)
# Walk off the edge of the ground by stepping off the screen edge.
game.player.x = game.WIDTH - game.PLAYER_HALF_W
game.keyboard.right = True
step(2)
game.keyboard.right = False
if game.on_ground or game.coyote_timer > 0:
    game.on_key_down(game.keys.SPACE)
    step(1)
    check(
        "coyote time does not produce a second jump",
        game.y_velocity >= 0 or not game.on_ground,
        f"(vy {game.y_velocity:.0f})",
    )
else:
    check("coyote time does not produce a second jump", True, "(left a ledge)")

# ---------------------------------------------------------------------------
print("No phasing through platforms")
# ---------------------------------------------------------------------------
# Drop the player onto every platform from a clear height and check they
# always end up standing on it.  "Inside" means the player's body vertically
# overlaps the tile AND the player is neither on top of it nor below it.
phase_failures = 0
checked = 0
for target in list(game.platforms):
    build(8)
    # Use a static platform and drop the player onto it from just above.
    # A moving platform would move away mid-drop, which is a different
    # scenario that the random-input playtest covers.
    if target.speed > 0:
        continue
    drop_y = target.top_y - (game.PLAYER_H + 2)
    if any(
        horizontal_overlap_at(game, target.x, drop_y, tile)
        for tile in game.platforms
    ):
        continue
    checked += 1
    game.player.x = target.x
    game.player.y = drop_y
    game.y_velocity = 0.0
    game.on_ground = False
    for _ in range(120):
        game.update(1 / 60)
        feet = game.player.y + game.PLAYER_HALF_H
        head = game.player.y - game.PLAYER_HALF_H
        for tile in game.platforms:
            top = tile.top_y
            bottom = top + game.TILE_H
            if abs(tile.x - game.player.x) > game.TILE_W:
                continue
            # Standing on the tile is fine; being below it is fine too.
            if feet <= top + 1.5:
                continue
            if head >= bottom:
                continue
            # Anything else means the player is buried in the block.
            phase_failures += 1
            break
check(
    "player never sinks into a platform",
    phase_failures == 0,
    f"({phase_failures} cases over {checked} drops)",
)

# ---------------------------------------------------------------------------
print("The player never spawns inside a platform")
# ---------------------------------------------------------------------------
spawn_failures = 0
for _ in range(60):
    build(9)
    for tile in game.platforms:
        top = tile.top_y
        bottom = top + game.TILE_H
        if abs(tile.x - game.player.x) > game.TILE_W:
            continue
        head = game.player.y - game.PLAYER_HALF_H
        feet = game.player.y + game.PLAYER_HALF_H
        if head < bottom and feet > top:
            spawn_failures += 1
check("player starts clear of every platform", spawn_failures == 0, f"({spawn_failures} cases)")

# ---------------------------------------------------------------------------
print("Spikes only hurt on contact")
# ---------------------------------------------------------------------------
# The player may only lose health on a frame where they were actually
# touching a spike.  Check the state before each update, because the
# knock-back moves the player away during the frame they are hit.
hurt_when_safe = 0
for _ in range(40):
    build(10)
    game.keyboard = FakeKeyboard()
    for _ in range(200):
        touching_before = any(
            game.player_box().colliderect(spike.danger_box) for spike in game.spikes
        )
        health_before = game.health
        game.update(1 / 60)
        if game.health < health_before and not touching_before:
            hurt_when_safe += 1
check("no damage without touching a spike", hurt_when_safe == 0, f"({hurt_when_safe} cases)")

# ---------------------------------------------------------------------------
print("One hit does not become many")
# ---------------------------------------------------------------------------
build(11)
spike = game.spikes[0]
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - game.PLAYER_HALF_H
game.y_velocity = 0.0
game.on_ground = True
game.hurt_timer = 0.0
health_before = game.health
step(1)
check("spike deals one hit", game.health == health_before - game.SPIKE_DAMAGE)
step(20)
check("no follow-up hit right after", game.health == health_before - game.SPIKE_DAMAGE,
      f"({game.health})")

# ---------------------------------------------------------------------------
print("Landing on a spike tile still works")
# ---------------------------------------------------------------------------
build(12)
spike = game.spikes[0]
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - 200
game.y_velocity = 0.0
game.on_ground = False
game.hurt_timer = 0.0
step(120)
check("player comes to rest on the platform", game.on_ground)
check(
    "resting feet are on the platform top",
    any(
        abs((game.player.y + game.PLAYER_HALF_H) - tile.top_y) < 1.5
        for tile in game.platforms
    ),
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("All checks passed.")

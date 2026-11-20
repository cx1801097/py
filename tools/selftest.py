"""Headless smoke test for main.py.

Loads the game without opening a window (SDL's dummy drivers), steps the
simulation, and checks the physics, pickups, hazards and restart logic.
It also renders one frame to screenshot.png so the layout can be inspected.

Run:
    py -3.13 tools/selftest.py
"""

import os
import sys
import types

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(PROJECT_ROOT, "main.py")
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame

sys._pgzrun = True          # tells pgzrun not to try to run a game loop

import pgzero.runner as runner
from pgzero.screen import Screen

# Execute main.py the same way the pgzrun runner does, but stop before its loop.
module = types.ModuleType("main")
module.__file__ = MAIN_PY
sys.modules["main"] = module

runner.prepare_mod(module)
module.__name__ = "main"        # prepare_mod copies pgzero's own metadata over ours
module.__file__ = MAIN_PY
with open(MAIN_PY, encoding="utf-8") as handle:
    source = handle.read()
exec(compile(source, MAIN_PY, "exec"), module.__dict__)

game = module
failures = []


class FakeKeyboard:
    """Stands in for pgzero.keyboard so tests can drive the player."""

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


print("Controls and state")
game.start_game()
check("starts in playing state", game.state == "playing")
check("three coins on screen", len(game.coins) == 3, f"({len(game.coins)})")
check("full health", game.health == game.MAX_HEALTH)
check("score starts at zero", game.score == 0)

print("Gravity and landing")
game.keyboard = FakeKeyboard()
step(180)
check("player lands on the ground", game.on_ground)
check("feet rest on the ground", abs((game.player.y + game.PLAYER_HALF_H) - (game.GROUND_Y - game.TILE_H / 2)) < 1.5)

print("Walking")
start_x = game.player.x
game.keyboard.right = True
step(30)
game.keyboard.right = False
check("right arrow moves right", game.player.x > start_x + 50, f"({start_x:.0f} -> {game.player.x:.0f})")
game.keyboard.left = True
step(30)
game.keyboard.left = False
check("left arrow moves left", game.player.x < game.WIDTH)

print("Jumping")
step(10)
game.on_key_down(game.keys.SPACE)
step(1)
check("jump gives upward speed", game.y_velocity < 0)
apex = game.player.y
step(30)
check("player rises off the ground", game.player.y < apex - 20)

print("Moving platforms")
movers = [tile for tile in game.platforms if tile.speed > 0]
check("some platforms move", len(movers) > 0, f"({len(movers)} tiles)")
if movers:
    tile = movers[0]
    before = tile.x
    furthest = 0.0
    for _ in range(45):
        step(1)
        furthest = max(furthest, abs(tile.x - before))
    check("platform slides", furthest > 2, f"(max drift {furthest:.1f}px)")
    check("platform stays on its track", abs(tile.x - tile.base_x) <= tile.span + 1)

print("Coins")
game.start_game()
coin = game.coins[0]
game.player.x = coin.x
game.player.y = coin.y
score_before = game.score
step(1)
check("touching a coin scores a point", game.score == score_before + 1, f"({score_before} -> {game.score})")
check("coin is replaced", len(game.coins) == 3)

print("Spikes and health")
game.start_game()
spike = game.spikes[0]
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - game.PLAYER_HALF_H
game.y_velocity = 0
game.on_ground = True
game.hurt_timer = 0
health_before = game.health
step(1)
check("spikes hurt", game.health == health_before - game.SPIKE_DAMAGE, f"({health_before} -> {game.health})")
health_now = game.health
step(1)
check("cooldown blocks an instant second hit", game.health == health_now)

print("Game over and retry")
game.health = game.SPIKE_DAMAGE
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - game.PLAYER_HALF_H
game.y_velocity = 0
game.on_ground = True
game.hurt_timer = 0
step(1)
check("zero health ends the run", game.state == "gameover")
game.on_key_down(game.keys.SPACE)
step(5)
check("retry is delayed for half a second", game.state == "gameover")
step(30)
game.on_key_down(game.keys.SPACE)
step(1)
check("space restarts the run", game.state == "playing")
check("restart refills health", game.health == game.MAX_HEALTH)

print("Difficulty ramp")
game.start_game()
base_speed = max(tile.speed for tile in game.platforms)
start_spikes = len(game.spikes)
game.score = game.COINS_PER_UPGRADE
game.apply_difficulty()
check("more spikes after five coins", len(game.spikes) > start_spikes, f"({start_spikes} -> {len(game.spikes)})")
check("platforms speed up", max(tile.speed for tile in game.platforms) > base_speed)
check("upgrade banner appears", game.upgrade_flash > 0, f"({game.upgrade_flash:.1f}s)")

print("High score file")
game.start_game()
check("banner clears on a new run", game.upgrade_flash == 0)
spike = game.spikes[0]
game.best_score = 0
game.score = 7
game.health = game.SPIKE_DAMAGE
game.player.x = spike.tile.x
game.player.y = spike.tile.top_y - game.PLAYER_HALF_H
game.y_velocity = 0
game.on_ground = True
game.hurt_timer = 0
step(1)
check("new best is recorded", game.best_score == game.score and game.best_score > 0, f"(best {game.best_score})")
check("highscore.txt written", os.path.exists(os.path.join(PROJECT_ROOT, "highscore.txt")))

print("Rendering")
game.start_game()
step(90)
surface = pygame.display.set_mode((game.WIDTH, game.HEIGHT))
import pgzero.game

pgzero.game.screen = surface     # Actor.draw() blits through the game's screen
game.screen = Screen(surface)    # screen.draw.* uses this wrapper

# Drop the score file this test created, so the project (and screenshot)
# start from a clean slate.
best_file = os.path.join(PROJECT_ROOT, "highscore.txt")
if os.path.exists(best_file):
    os.remove(best_file)
game.best_score = 0

try:
    game.draw()
    pygame.image.save(surface, os.path.join(PROJECT_ROOT, "screenshot.png"))
    check("draw() renders a frame", True, "(screenshot.png)")
except Exception as error:                       # noqa: BLE001 - report any draw failure
    check("draw() renders a frame", False, repr(error))

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("All checks passed.")

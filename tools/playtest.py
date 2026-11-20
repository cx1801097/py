"""Random-input play simulation.

The scripted tests can put the player in states a real player can never
reach.  This harness plays the game with random input for a long time and
watches for any of the reported problems, in the states the game actually
produces:

* the player floating in mid-air while "on the ground"
* the player sinking into a platform
* the player jumping while not touching anything
* damage taken without touching a spike
* coins drifting on their own

Run:
    py -3.13 tools/playtest.py [seconds]
"""

import os
import random
import sys
import types

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

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


class FakeKeyboard:
    def __init__(self):
        self.left = self.right = self.a = self.d = False


def horizontal_overlap(x, tile):
    return (
        x + game.PLAYER_HALF_W > tile.x - game.TILE_W / 2
        and x - game.PLAYER_HALF_W < tile.x + game.TILE_W / 2
    )


def run(seconds=120, seed=0):
    rng = random.Random(seed)
    game.keyboard = FakeKeyboard()
    game.start_game()

    dt = 1 / 60
    steps = int(seconds / dt)

    problems = {
        "hovering": 0,
        "sunk": 0,
        "air_jump": 0,
        "false_damage": 0,
        "coin_drift": 0,
    }
    details = []

    for _ in range(steps):
        # Random input.
        game.keyboard.left = rng.random() < 0.25
        game.keyboard.right = rng.random() < 0.25
        if rng.random() < 0.05:
            game.on_key_down(game.keys.SPACE)

        # --- state before the update -------------------------------------
        health_before = game.health

        # The jump is applied inside move_player, using the on_ground flag
        # left by the previous frame.  Wrap it so a jump that happens while
        # the player is airborne can be spotted.
        was_on_ground = game.on_ground
        jumped_in_air = False
        velocity_before = game.y_velocity
        original_move = game.move_player
        # The spike check runs after the player has moved, so the contact
        # has to be measured at that moment, not before the update.
        touched_spike = False
        original_check = game.check_spikes

        def traced_check():
            nonlocal touched_spike
            touched_spike = any(
                game.player_box().colliderect(spike.danger_box)
                for spike in game.spikes
            )
            original_check()

        def traced_move(step_dt, _orig=original_move, _og=was_on_ground):
            nonlocal jumped_in_air
            _orig(step_dt)
            if game.y_velocity < -700 and velocity_before >= -700 and not _og:
                jumped_in_air = True

        game.move_player = traced_move
        game.check_spikes = traced_check
        try:
            game.update(dt)
        finally:
            game.move_player = original_move
            game.check_spikes = original_check

        # --- checks ------------------------------------------------------
        if was_on_ground and game.on_ground:
            on_a_platform = any(
                abs((game.player.y + game.PLAYER_HALF_H) - tile.top_y) < 1.5
                for tile in game.platforms
            )
            if not on_a_platform:
                problems["hovering"] += 1
                if len(details) < 8:
                    details.append(
                        f"hovering at y={game.player.y:.1f} "
                        f"feet={game.player.y + game.PLAYER_HALF_H:.1f}"
                    )

        feet = game.player.y + game.PLAYER_HALF_H
        head = game.player.y - game.PLAYER_HALF_H
        for tile in game.platforms:
            if not horizontal_overlap(game.player.x, tile):
                continue
            top = tile.top_y
            bottom = top + game.TILE_H
            if feet <= top + 1.5 or head >= bottom:
                continue
            problems["sunk"] += 1
            if len(details) < 8:
                details.append(
                    f"sunk: head={head:.1f} feet={feet:.1f} tile={top}..{bottom}"
                )
            break

        if game.health < health_before and not touched_spike:
            problems["false_damage"] += 1
            if len(details) < 8:
                details.append(
                    f"damage without contact: health {health_before}->{game.health}"
                )

        for coin in game.coins:
            offset = coin.y - (coin.tile.top_y - 26)
            if abs(offset) > 0.001:
                problems["coin_drift"] += 1
                if len(details) < 8:
                    details.append(f"coin drifted by {offset:.2f}px")
                break

        # A jump must never happen while the player is airborne.
        if jumped_in_air:
            problems["air_jump"] += 1
            if len(details) < 8:
                details.append("jumped while airborne")

    return problems, details


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    seeds = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    total = {k: 0 for k in
             ("hovering", "sunk", "air_jump", "false_damage", "coin_drift")}
    all_details = []

    for seed in range(seeds):
        problems, details = run(seconds, seed)
        for key, value in problems.items():
            total[key] += value
        all_details.extend(f"[seed {seed}] {d}" for d in details)
        print(f"  seed {seed}: {problems}")

    print()
    if all_details:
        print("First problems seen:")
        for line in all_details[:12]:
            print(f"  {line}")
        print()

    failed = [key for key, value in total.items() if value]
    if failed:
        print(f"FAILED: {', '.join(failed)}")
        for key in failed:
            print(f"  {key}: {total[key]}")
        sys.exit(1)

    print(f"No problems found in {seconds}s x {seeds} seeds of random play.")


if __name__ == "__main__":
    main()

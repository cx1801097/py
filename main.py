"""
Skyward Scramble
================
An endless climbing platformer made with Pygame Zero.

The tower is made of stone platforms: two of the three floating rows slide
back and forth, and every fifth coin you collect adds another spike and
makes those rows a little faster.  There is no finish line - the goal is to
beat your own best score, like the Chrome dinosaur game.  Touch too many
spikes and the run is over.

Controls
    Left / Right or A / D ........ walk
    Space / Up / W ............... jump
    Space (after a game over) .... retry

Run with:
    py -m pgzero main.py
or just double-click / run:
    python main.py
"""

import math
import os
import random

import pgzrun
import pygame
from pgzero import loaders
from pygame import Rect

# ---------------------------------------------------------------------------
# Window and level geometry
# ---------------------------------------------------------------------------
WIDTH = 800
HEIGHT = 600
TITLE = "Skyward Scramble"

TILE_W = 50                 # one stone tile
TILE_H = 24
GROUND_Y = 425              # centre of the solid ground row
ROW_GAP = 118               # vertical distance between floating rows
ROW_COUNT = 3
TILES_PER_ROW = 4
ROW_MIN_X = 75              # keeps moving rows away from the screen edges
ROW_MAX_X = 575
PLATFORM_SPAN = 40          # how far a moving row slides either side
BASE_PLATFORM_SPEED = 70.0  # pixels per second

# ---------------------------------------------------------------------------
# Player physics (all speeds are per second, so the game is frame-rate safe)
# ---------------------------------------------------------------------------
PLAYER_W = 38
PLAYER_H = 80
PLAYER_HALF_W = PLAYER_W // 2
PLAYER_HALF_H = PLAYER_H // 2
PLAYER_START = (100, 300)

MOVE_SPEED = 300.0
JUMP_SPEED = 780.0
GRAVITY = 1800.0
MAX_FALL_SPEED = 900.0
COYOTE_TIME = 0.10          # small grace period after walking off an edge
JUMP_BUFFER = 0.12          # remembers a jump pressed just before landing
LANDING_TOLERANCE = 2.0     # how close the feet must be to a platform top

# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
COIN_POINTS = 1
COINS_ON_SCREEN = 3
COINS_PER_UPGRADE = 5
PLATFORM_SPEED_STEP = 18.0
MAX_PLATFORM_SPEED = 200.0
MAX_HEALTH = 100
SPIKE_DAMAGE = 10
SPIKE_COOLDOWN = 0.8
SPIKE_HEIGHT = 12.0           # how far the spike tips reach above the tile
SPIKE_KNOCKBACK = 26.0        # sideways push when the player hits a spike
SPIKE_KNOCKBACK_JUMP = 260.0  # small hop so the player clears the spikes

HINT_SECONDS = 6.0
RETRY_DELAY = 0.4
UPGRADE_FLASH_SECONDS = 1.6

TEXT_COLOR = (242, 246, 255)
TEXT_SHADOW = (16, 20, 36)
ACCENT_COLOR = (255, 214, 92)

# Pygame Zero already knows which folder the game lives in - that is where it
# looks for images/ and sounds/ - so keep the high score beside main.py too.
BEST_FILE = os.path.join(loaders.root, "highscore.txt")


# ---------------------------------------------------------------------------
# Actors
# ---------------------------------------------------------------------------
class Platform(Actor):
    """A stone tile. speed/span of 0 means it never moves."""

    def __init__(self, x, y, speed=0.0, span=0.0, direction=1):
        super().__init__("platform", (x, y))
        self.base_x = float(x)
        self.speed = float(speed)
        self.span = float(span)
        self.direction = direction
        self.last_dx = 0.0      # horizontal movement this frame, used to carry the player

    @property
    def box(self):
        return Rect(int(self.x - TILE_W / 2), int(self.y - TILE_H / 2), TILE_W, TILE_H)

    @property
    def top_y(self):
        return self.y - TILE_H / 2

    def advance(self, dt):
        """Slide side to side and remember how far this tile moved."""
        self.last_dx = 0.0
        if self.speed <= 0 or self.span <= 0:
            return

        next_x = self.x + self.speed * self.direction * dt
        if next_x <= self.base_x - self.span or next_x >= self.base_x + self.span:
            # Bounce off the end of the track and travel back.
            self.direction *= -1
            next_x = self.x + self.speed * self.direction * dt
            next_x = max(self.base_x - self.span, min(self.base_x + self.span, next_x))

        self.last_dx = next_x - self.x
        self.x = next_x


class Spike(Actor):
    """A hazard drawn on top of a platform tile (the tile stays solid)."""

    def __init__(self, tile):
        super().__init__("spikes", (tile.x, tile.y))
        self.tile = tile

    @property
    def danger_box(self):
        # The spikes art is 50x24 and is drawn centred on the tile, so the
        # visible spikes occupy the upper part of that box, ending at the
        # tile's top edge.  The danger zone is exactly that visible part:
        # the tips stick up above the tile, and nothing below the top edge
        # counts.  Keeping the zone tight means a player standing on a
        # neighbouring tile is not hurt by a spike they cannot touch.
        return Rect(
            int(self.tile.x - TILE_W / 2),
            int(self.tile.top_y - SPIKE_HEIGHT),
            TILE_W,
            SPIKE_HEIGHT,
        )

    def follow(self):
        self.x = self.tile.x
        self.y = self.tile.y


class Coin(Actor):
    """A collectible that hovers above its platform and rides along with it."""

    def __init__(self, tile):
        super().__init__("coin", (tile.x, tile.top_y - 26))
        self.tile = tile

    @property
    def box(self):
        # A slightly generous box makes coins satisfying to grab.
        return Rect(int(self.x - 13), int(self.y - 13), 26, 26)

    def follow(self):
        # The coin is pinned to its platform: it only travels when the
        # platform does, so it never drifts on its own.
        self.x = self.tile.x
        self.y = self.tile.top_y - 26


# ---------------------------------------------------------------------------
# Game state
# ---------------------------------------------------------------------------
background = Actor("background", (WIDTH // 2, HEIGHT // 2))
player = Actor("player", PLAYER_START)

platforms = []
spikes = []
coins = []

score = 0
best_score = 0
health = MAX_HEALTH
upgrade_level = 0
state = "playing"           # "playing" or "gameover"
new_best = False

y_velocity = 0.0
on_ground = False
coyote_timer = 0.0
jump_buffer_timer = 0.0
hurt_timer = 0.0
elapsed = 0.0
gameover_timer = 0.0
upgrade_flash = 0.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def player_box():
    return Rect(
        int(player.x - PLAYER_HALF_W),
        int(player.y - PLAYER_HALF_H),
        PLAYER_W,
        PLAYER_H,
    )


def horizontal_overlap(x, tile):
    """True when a player centred on `x` overlaps the tile horizontally."""
    return (
        x + PLAYER_HALF_W > tile.x - TILE_W / 2
        and x - PLAYER_HALF_W < tile.x + TILE_W / 2
    )


def label(text, pos, size, color=TEXT_COLOR, align="topleft"):
    """Draw text in the custom pixel font with a readable drop shadow."""
    screen.draw.text(
        text,
        color=color,
        fontname="font",
        fontsize=size,
        shadow=(2, 2),
        scolor=TEXT_SHADOW,
        **{align: pos},
    )


def play(sound_name):
    """Play an effect.  Audio is decoration, so a missing file must never
    crash the game - Pygame Zero reports an unknown sound as AttributeError."""
    try:
        getattr(sounds, sound_name).play()
    except (AttributeError, OSError, pygame.error):
        pass


def load_best():
    """Read the saved high score, falling back to 0 if the file is missing."""
    try:
        with open(BEST_FILE, "r", encoding="utf-8") as handle:
            return max(0, int(handle.read().strip() or 0))
    except (OSError, ValueError):
        return 0


def save_best(value):
    try:
        with open(BEST_FILE, "w", encoding="utf-8") as handle:
            handle.write(str(value))
    except OSError:
        pass    # a read-only folder should not ruin a good run


# ---------------------------------------------------------------------------
# Level building
# ---------------------------------------------------------------------------
def build_level():
    """Create the ground, three floating rows, their spikes and the coins."""
    platforms.clear()
    spikes.clear()
    coins.clear()

    # Solid ground: 16 tiles, centred in the window.
    for x in range(TILE_W // 2, WIDTH, TILE_W):
        platforms.append(Platform(x, GROUND_Y))

    # Floating rows that snake upwards, always close enough to jump between.
    row_groups = []
    previous_x = random.randint(225, 425)
    for index in range(ROW_COUNT):
        y = GROUND_Y - ROW_GAP * (index + 1)
        start_x = previous_x + random.randint(-220, 220)
        start_x = max(ROW_MIN_X, min(ROW_MAX_X, start_x))

        # The bottom row is a steady base; the two above it slide.
        moving = index > 0
        speed = BASE_PLATFORM_SPEED if moving else 0.0
        # Every tile of a row shares one direction, so the row always moves
        # as one piece and a player riding it is carried consistently.
        direction = random.choice((-1, 1))

        row_tiles = []
        for column in range(TILES_PER_ROW):
            tile = Platform(
                start_x + column * TILE_W, y, speed, PLATFORM_SPAN, direction
            )
            platforms.append(tile)
            row_tiles.append(tile)

        row_groups.append(row_tiles)
        previous_x = start_x

    # One spike per floating row to start with.
    for row_tiles in row_groups:
        spikes.append(Spike(random.choice(row_tiles)))

    for _ in range(COINS_ON_SCREEN):
        spawn_coin()

    keep_spawn_clear()


def keep_spawn_clear():
    """Move the player's start to a spot with clear air around it.

    The player is 80px tall and the rows are only a little further apart
    than that, so a row can easily be built right where the player would
    start.  Rather than shuffling the whole tower around, the player is
    simply placed in a column that is free of platforms.
    """
    best = None

    # Try every ground tile as a starting column and keep the one whose
    # column of air is clearest.
    for tile in platforms:
        if tile.y < GROUND_Y:
            continue    # only ground tiles are candidates

        x = tile.x
        if x < PLAYER_HALF_W + 2 or x > WIDTH - PLAYER_HALF_W - 2:
            continue

        blocked = 0
        for other in platforms:
            if other.y >= GROUND_Y:
                continue
            if abs(other.x - x) > TILE_W:
                continue
            blocked += 1

        if best is None or blocked < best[0]:
            best = (blocked, x)

        if blocked == 0:
            break

    if best is not None:
        player.x = best[1]


def keep_spawn_clear():
    """Move the player's start to a spot with clear air around it.

    The player is 80px tall and the rows are only a little further apart
    than that, so a row can easily be built right where the player would
    start.  Rather than shuffling the whole tower around, the player is
    simply placed in a column that is free of platforms.
    """
    best = None

    # Try every ground tile as a starting column and keep the one whose
    # column of air is clearest.
    for tile in platforms:
        if tile.y < GROUND_Y:
            continue    # only ground tiles are candidates

        x = tile.x
        if x < PLAYER_HALF_W + 2 or x > WIDTH - PLAYER_HALF_W - 2:
            continue

        blocked = 0
        for other in platforms:
            if other.y >= GROUND_Y:
                continue
            if abs(other.x - x) > TILE_W:
                continue
            blocked += 1

        if best is None or blocked < best[0]:
            best = (blocked, x)

        if blocked == 0:
            break

    if best is not None:
        player.x = best[1]


def spawn_coin():
    """Place a coin on a free, spike-free tile that is not under the player."""
    taken = {spike.tile for spike in spikes}
    used = {coin.tile for coin in coins}
    player_rect = player_box()

    candidates = []
    for tile in platforms:
        if tile in taken or tile in used:
            continue
        coin_spot = Coin(tile)
        if coin_spot.box.colliderect(player_rect):
            continue
        candidates.append(tile)

    # Favour the floating rows so the player has to climb for most coins,
    # but keep the ground in the mix as an easy breather.
    high_tiles = [tile for tile in candidates if tile.y < GROUND_Y]
    if high_tiles and random.random() < 0.75:
        candidates = high_tiles

    if candidates:
        coins.append(Coin(random.choice(candidates)))


def add_spike():
    """Add one more hazard, never directly on top of the player."""
    occupied = {spike.tile for spike in spikes}
    candidates = [tile for tile in platforms if tile not in occupied]

    if upgrade_level < 3:
        # Keep the ground safe early on so the player always has a refuge.
        candidates = [tile for tile in candidates if tile.y < GROUND_Y]

    # Never drop a new spike on top of the player.  A spike that appears
    # under the player's feet would hit them immediately and look like
    # random damage, so the tile must be clear of the player's body and
    # of the space just above it.
    safe = [tile for tile in candidates if not spike_would_hit(tile)]
    if safe:
        candidates = safe

    if candidates:
        spikes.append(Spike(random.choice(candidates)))


def spike_would_hit(tile):
    """True if a spike placed on this tile would touch the player right now."""
    danger = Rect(
        int(tile.x - TILE_W / 2),
        int(tile.top_y - SPIKE_HEIGHT),
        TILE_W,
        SPIKE_HEIGHT,
    )
    return danger.colliderect(player_box())


def apply_difficulty():
    """Every five coins: one extra spike and slightly faster moving rows."""
    global upgrade_level, upgrade_flash

    target = score // COINS_PER_UPGRADE
    while upgrade_level < target:
        upgrade_level += 1
        add_spike()
        for tile in platforms:
            if tile.speed > 0:
                tile.speed = min(tile.speed + PLATFORM_SPEED_STEP, MAX_PLATFORM_SPEED)

        upgrade_flash = UPGRADE_FLASH_SECONDS
        play("level_up")


# ---------------------------------------------------------------------------
# Round flow
# ---------------------------------------------------------------------------
def start_game():
    """Reset everything for a fresh run."""
    global score, health, state, upgrade_level, new_best
    global y_velocity, on_ground
    global coyote_timer, jump_buffer_timer, hurt_timer, elapsed, gameover_timer
    global upgrade_flash

    score = 0
    health = MAX_HEALTH
    state = "playing"
    upgrade_level = 0
    new_best = False

    y_velocity = 0.0
    on_ground = False
    coyote_timer = 0.0
    jump_buffer_timer = 0.0
    hurt_timer = 0.0
    elapsed = 0.0
    gameover_timer = 0.0
    upgrade_flash = 0.0

    player.pos = PLAYER_START
    build_level()


def end_game():
    """Freeze the game and record a new record if we have one."""
    global state, best_score, new_best, gameover_timer

    state = "gameover"
    gameover_timer = 0.0

    if score > best_score:
        best_score = score
        new_best = True
        save_best(best_score)
        play("new_best")
    else:
        play("game_over")


# ---------------------------------------------------------------------------
# Gameplay
# ---------------------------------------------------------------------------
def move_player(dt):
    """Input, gravity and solid platform collisions."""
    global y_velocity, on_ground
    global coyote_timer, jump_buffer_timer

    direction = 0
    if keyboard.left or keyboard.a:
        direction -= 1
    if keyboard.right or keyboard.d:
        direction += 1

    # --- Horizontal movement, blocked by the sides of solid platforms -----
    player.x += direction * MOVE_SPEED * dt
    player.x = max(PLAYER_HALF_W, min(WIDTH - PLAYER_HALF_W, player.x))

    # --- Jumping ---------------------------------------------------------
    # A jump only happens when the player is really standing on something.
    # `on_ground` is maintained by the collision code below, so a player who
    # is falling through the air can never jump.
    if jump_buffer_timer > 0 and on_ground:
        y_velocity = -JUMP_SPEED
        jump_buffer_timer = 0.0
        coyote_timer = 0.0
        on_ground = False
        play("jump")

    # --- Vertical movement, resolved against solid platforms -------------
    old_feet = player.y + PLAYER_HALF_H
    old_head = player.y - PLAYER_HALF_H
    y_velocity = min(y_velocity + GRAVITY * dt, MAX_FALL_SPEED)
    player.y += y_velocity * dt
    feet = player.y + PLAYER_HALF_H
    head = player.y - PLAYER_HALF_H

    landing = None
    landing_top = None

    if y_velocity >= 0:
        # Falling: land on the top edge of any platform we crossed.  A
        # moving platform is also checked against where it used to be, so a
        # player who is standing on one is not left behind when it slides
        # out from under their feet.
        for tile in platforms:
            top = tile.top_y
            if not horizontal_overlap(player.x, tile):
                if tile.last_dx == 0:
                    continue
                # The tile moved this frame: check the spot it came from.
                if not horizontal_overlap(player.x - tile.last_dx, tile):
                    continue
            if old_feet <= top + LANDING_TOLERANCE and feet >= top:
                if landing_top is None or top < landing_top:
                    landing = tile
                    landing_top = top
    else:
        # Rising: the player's HEAD is what meets the underside of a
        # platform.  If the head crossed the bottom face this frame, push
        # the player back down below it so they cannot phase up through a
        # solid tile.
        for tile in platforms:
            if not horizontal_overlap(player.x, tile):
                continue
            top = tile.top_y
            bottom = top + TILE_H
            if old_head >= bottom - LANDING_TOLERANCE and head <= bottom:
                player.y = bottom + PLAYER_HALF_H
                y_velocity = 0.0
                break

    was_grounded = on_ground

    if landing is not None:
        player.y = landing_top - PLAYER_HALF_H
        y_velocity = 0.0
        on_ground = True
    else:
        # Not over any platform: the player falls.
        on_ground = False

    # --- Moving platforms carry the player -------------------------------
    # If the player is standing on a platform, the platform's own movement
    # this frame is added to the player, so they ride along instead of being
    # left behind in mid-air.  The tile the player is actually resting on is
    # used - matched by height, so a player who overlaps a row above is not
    # carried by it as well.
    if on_ground:
        carry_dx = 0.0
        feet_now = player.y + PLAYER_HALF_H
        for tile in platforms:
            if tile.last_dx == 0:
                continue
            if not horizontal_overlap(player.x, tile):
                continue
            if abs(feet_now - tile.top_y) > LANDING_TOLERANCE:
                continue
            carry_dx = tile.last_dx
            break
        player.x += carry_dx

    # --- Solid platform bodies ------------------------------------------
    # A platform is a solid block, not just a ledge.  If the player's body
    # ends up inside one, they are pushed out vertically to the nearest
    # free face instead of sinking through it.  The check is deliberately
    # narrow: it only triggers when the player is genuinely buried in the
    # block, so it never interferes with a normal landing.
    for tile in platforms:
        if not horizontal_overlap(player.x, tile):
            continue

        top = tile.top_y
        bottom = top + TILE_H
        head = player.y - PLAYER_HALF_H
        feet = player.y + PLAYER_HALF_H

        # Standing on top of it: fine.
        if feet <= top + LANDING_TOLERANCE:
            continue

        # Entirely below it: fine.
        if head >= bottom:
            continue

        # The player's body overlaps the block.  Push them out of it.
        # When falling, they are lifted onto the platform - the natural
        # "land on it" outcome - unless their head is below the platform,
        # in which case they are pushed out below it.
        if y_velocity >= 0 and head <= top + LANDING_TOLERANCE:
            # Falling onto the platform.
            player.y = top - PLAYER_HALF_H
            y_velocity = 0.0
            on_ground = True
        elif y_velocity < 0 and feet >= bottom - LANDING_TOLERANCE:
            # Rising into its underside: pushed back down.
            player.y = bottom + PLAYER_HALF_H
            y_velocity = 0.0
        else:
            # Anywhere else: push out towards the nearer face so the player
            # is never left buried inside a block.
            centre = player.y
            if abs(centre - top) <= abs(centre - bottom):
                player.y = top - PLAYER_HALF_H
                y_velocity = 0.0
                on_ground = True
            else:
                player.y = bottom + PLAYER_HALF_H
                y_velocity = 0.0

    player.x = max(PLAYER_HALF_W, min(WIDTH - PLAYER_HALF_W, player.x))

    if was_grounded and not on_ground:
        coyote_timer = COYOTE_TIME
    else:
        coyote_timer = max(0.0, coyote_timer - dt)

    jump_buffer_timer = max(0.0, jump_buffer_timer - dt)


def collect_coins():
    global score

    box = player_box()
    for coin in coins[:]:
        if box.colliderect(coin.box):
            coins.remove(coin)
            score += COIN_POINTS
            play("coin_pickup")
            spawn_coin()
            apply_difficulty()


def check_spikes():
    global health, score, hurt_timer, y_velocity, on_ground

    if hurt_timer > 0:
        return

    box = player_box()
    for spike in spikes:
        if not box.colliderect(spike.danger_box):
            continue

        health = max(0, health - SPIKE_DAMAGE)
        score = max(0, score - 1)
        hurt_timer = SPIKE_COOLDOWN
        play("hurt")

        # Push the player away from the spike instead of straight up.  An
        # upward knock-back would push the player straight back into the
        # spikes, which made them take damage over and over.
        away = 1.0 if player.x >= spike.tile.x else -1.0
        player.x += away * SPIKE_KNOCKBACK
        player.x = max(PLAYER_HALF_W, min(WIDTH - PLAYER_HALF_W, player.x))

        # A small hop so the player clears the spikes, but not so much that
        # they shoot up through the platform above.
        y_velocity = -SPIKE_KNOCKBACK_JUMP
        on_ground = False

        if health <= 0:
            end_game()
        break


def update(dt):
    global elapsed, hurt_timer, gameover_timer, upgrade_flash

    # Clamp dt so a stalled frame cannot teleport the player through a platform.
    dt = min(dt, 0.05)

    if state == "gameover":
        gameover_timer += dt
        return

    elapsed += dt
    hurt_timer = max(0.0, hurt_timer - dt)
    upgrade_flash = max(0.0, upgrade_flash - dt)

    for tile in platforms:
        tile.advance(dt)
    for spike in spikes:
        spike.follow()
    for coin in coins:
        coin.follow()

    move_player(dt)
    collect_coins()
    check_spikes()


def on_key_down(key):
    global jump_buffer_timer

    if key in (keys.SPACE, keys.UP, keys.W):
        if state == "gameover":
            if gameover_timer >= RETRY_DELAY:
                start_game()
        else:
            jump_buffer_timer = JUMP_BUFFER


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------
def draw_hud():
    label(f"SCORE {score}", (16, 12), 16)
    label(f"BEST {best_score}", (16, 42), 10, color=(196, 210, 235))

    health_color = (255, 120, 120) if hurt_timer > 0 else TEXT_COLOR
    label(f"HEALTH {health}", (WIDTH - 16, 12), 16, color=health_color, align="topright")

    if upgrade_flash > 0:
        # A short, gently pulsing callout so the difficulty jump is not a
        # surprise.  The tint is the accent colour scaled by the pulse.
        pulse = 0.72 + 0.28 * math.sin(upgrade_flash * 20.0)
        tint = tuple(int(channel * pulse) for channel in ACCENT_COLOR)
        label(f"LEVEL {upgrade_level}", (WIDTH // 2, 92), 16, color=tint, align="center")
        label("THE TOWER SPEEDS UP", (WIDTH // 2, 120), 8, align="center")

    if elapsed < HINT_SECONDS and state == "playing":
        label(
            "ARROWS MOVE - SPACE JUMPS",
            (WIDTH // 2, HEIGHT - 30),
            10,
            color=(235, 238, 250),
            align="center",
        )


def draw_game_over():
    panel = Rect(70, 160, WIDTH - 140, 280)
    screen.draw.filled_rect(panel, (14, 18, 34))
    screen.draw.rect(panel, ACCENT_COLOR)

    label("GAME OVER", (WIDTH // 2, 200), 28, color=ACCENT_COLOR, align="center")
    label(f"SCORE {score}", (WIDTH // 2, 270), 20, align="center")
    label(f"BEST {best_score}", (WIDTH // 2, 305), 14, color=(205, 214, 238), align="center")

    if new_best:
        label("NEW BEST!", (WIDTH // 2, 345), 16, color=ACCENT_COLOR, align="center")

    if int(gameover_timer * 2) % 2 == 0:
        label(
            "PRESS SPACE TO RETRY",
            (WIDTH // 2, 395),
            10,
            color=(225, 230, 245),
            align="center",
        )


def draw():
    screen.clear()
    background.draw()

    for tile in platforms:
        tile.draw()
    for coin in coins:
        coin.draw()
    for spike in spikes:
        spike.draw()
    player.draw()

    draw_hud()
    if state == "gameover":
        draw_game_over()


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
best_score = load_best()
start_game()

if __name__ == "__main__":
    # `pgzrun main.py` starts the loop through the runner, while plain
    # `python main.py` needs this call.
    pgzrun.go()

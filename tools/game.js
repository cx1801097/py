/* ---------------------------------------------------------------------------
 * Skyward Scramble - browser port of main.py
 *
 * A faithful re-implementation of the Pygame Zero game.  The simulation runs
 * on a fixed 1/60s timestep with an accumulator so the feel is identical no
 * matter what the display refresh rate happens to be.
 * ------------------------------------------------------------------------ */
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Window and level geometry
    // -----------------------------------------------------------------------
    const WIDTH = 800;
    const HEIGHT = 600;
    const TITLE = 'Skyward Scramble';

    const TILE_W = 50;                 // one stone tile
    const TILE_H = 24;
    const GROUND_Y = 425;              // centre of the solid ground row
    const ROW_GAP = 118;               // vertical distance between floating rows
    const ROW_COUNT = 3;
    const TILES_PER_ROW = 4;
    const ROW_MIN_X = 75;              // keeps moving rows away from the screen edges
    const ROW_MAX_X = 575;
    const PLATFORM_SPAN = 40;          // how far a moving row slides either side
    const BASE_PLATFORM_SPEED = 70.0;  // pixels per second

    // -----------------------------------------------------------------------
    // Player physics (all speeds are per second, so the game is frame-rate safe)
    // -----------------------------------------------------------------------
    const PLAYER_W = 38;
    const PLAYER_H = 80;
    const PLAYER_HALF_W = PLAYER_W / 2;
    const PLAYER_HALF_H = PLAYER_H / 2;
    const PLAYER_START_X = 100;
    const PLAYER_START_Y = 300;

    const MOVE_SPEED = 300.0;
    const JUMP_SPEED = 780.0;
    const GRAVITY = 1800.0;
    const MAX_FALL_SPEED = 900.0;
    const COYOTE_TIME = 0.10;          // small grace period after walking off an edge
    const JUMP_BUFFER = 0.12;          // remembers a jump pressed just before landing
    const LANDING_TOLERANCE = 2.0;     // how close the feet must be to a platform top

    // -----------------------------------------------------------------------
    // Rules
    // -----------------------------------------------------------------------
    const COIN_POINTS = 1;
    const COINS_ON_SCREEN = 3;
    const COINS_PER_UPGRADE = 5;
    const PLATFORM_SPEED_STEP = 18.0;
    const MAX_PLATFORM_SPEED = 200.0;
    const MAX_HEALTH = 100;
    const SPIKE_DAMAGE = 10;
    const SPIKE_COOLDOWN = 0.8;
    const SPIKE_HEIGHT = 12.0;           // how far the spike tips reach above the tile
    const SPIKE_KNOCKBACK = 26.0;        // sideways push when the player hits a spike
    const SPIKE_KNOCKBACK_JUMP = 260.0;  // small hop so the player clears the spikes

    const HINT_SECONDS = 6.0;
    const RETRY_DELAY = 0.4;
    const UPGRADE_FLASH_SECONDS = 1.6;

    const TEXT_COLOR = '#f2f6ff';
    const TEXT_SHADOW = '#101424';
    const ACCENT_COLOR = '#ffd65c';
    const SUB_TEXT_COLOR = '#c4d2eb';

    const BEST_KEY = 'skyward_scramble_best';
    const FIXED_DT = 1 / 60;
    const MAX_FRAME_TIME = 0.25;       // clamp for tab switches / long stalls

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------
    const ASSETS = {
        background: '__BACKGROUND_URI__',
        player: '__PLAYER_URI__',
        coin: '__COIN_URI__',
        platform: '__PLATFORM_URI__',
        spikes: '__SPIKES_URI__'
    };

    // -----------------------------------------------------------------------
    // Canvas
    // -----------------------------------------------------------------------
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const images = {};

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------
    function clamp(value, low, high) {
        return value < low ? low : (value > high ? high : value);
    }

    // -----------------------------------------------------------------------
    // Random numbers.
    //
    // A small seedable generator (mulberry32) is used so the headless test
    // can build a known layout.  Without a seed it behaves like plain
    // randomness, exactly like the Python version.
    // -----------------------------------------------------------------------
    let rngState = (Math.random() * 0xffffffff) >>> 0;

    function nextRandom() {
        rngState = (rngState + 0x6d2b79f5) >>> 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    function seedRandom(seed) {
        rngState = (seed >>> 0) || 1;
    }

    function randint(low, high) {
        // Python's random.randint(low, high) is inclusive on both ends.
        return low + Math.floor(nextRandom() * (high - low + 1));
    }

    function randomChoice(list) {
        return list[Math.floor(nextRandom() * list.length)];
    }

    // Rect helper with the same inclusive/exclusive semantics as pygame.Rect
    function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

    // -----------------------------------------------------------------------
    // Actors
    // -----------------------------------------------------------------------
    class Platform {
        constructor(x, y, speed, span, direction) {
            this.x = x;
            this.y = y;
            this.baseX = x;
            this.speed = speed || 0;
            this.span = span || 0;
            this.direction = direction === undefined ? 1 : direction;
            this.lastDx = 0.0;   // horizontal movement this frame, used to carry the player
        }

        get topY() {
            return this.y - TILE_H / 2;
        }

        advance(dt) {
            // Slide side to side and remember how far this tile moved.
            this.lastDx = 0.0;
            if (this.speed <= 0 || this.span <= 0) {
                return;
            }

            let nextX = this.x + this.speed * this.direction * dt;
            if (nextX <= this.baseX - this.span || nextX >= this.baseX + this.span) {
                // Bounce off the end of the track and travel back.
                this.direction *= -1;
                nextX = this.x + this.speed * this.direction * dt;
                nextX = Math.max(this.baseX - this.span, Math.min(this.baseX + this.span, nextX));
            }

            this.lastDx = nextX - this.x;
            this.x = nextX;
        }
    }

    class Spike {
        constructor(tile) {
            this.tile = tile;
            this.x = tile.x;
            this.y = tile.y;
        }

        get dangerBox() {
            // The spikes art is 50x24 and is drawn centred on the tile, so the
            // visible spikes occupy the upper part of that box, ending at the
            // tile's top edge.  The danger zone is exactly that visible part:
            // the tips stick up above the tile, and nothing below the top edge
            // counts.  Keeping the zone tight means a player standing on a
            // neighbouring tile is not hurt by a spike they cannot touch.
            return {
                x: Math.trunc(this.tile.x - TILE_W / 2),
                y: Math.trunc(this.tile.topY - SPIKE_HEIGHT),
                w: TILE_W,
                h: SPIKE_HEIGHT
            };
        }

        follow() {
            this.x = this.tile.x;
            this.y = this.tile.y;
        }
    }

    class Coin {
        constructor(tile) {
            this.tile = tile;
            this.x = tile.x;
            this.y = tile.topY - 26;
        }

        get box() {
            // A slightly generous box makes coins satisfying to grab.
            return { x: Math.trunc(this.x - 13), y: Math.trunc(this.y - 13), w: 26, h: 26 };
        }

        follow() {
            // The coin is pinned to its platform: it only travels when the
            // platform does, so it never drifts on its own.
            this.x = this.tile.x;
            this.y = this.tile.topY - 26;
        }
    }

    // -----------------------------------------------------------------------
    // Game state
    // -----------------------------------------------------------------------
    let platforms = [];
    let spikes = [];
    let coins = [];

    let score = 0;
    let bestScore = 0;
    let health = MAX_HEALTH;
    let upgradeLevel = 0;
    let state = 'playing';            // "playing" or "gameover"
    let newBest = false;

    let yVelocity = 0.0;
    let onGround = false;
    let coyoteTimer = 0.0;
    let jumpBufferTimer = 0.0;
    let hurtTimer = 0.0;
    let elapsed = 0.0;
    let gameoverTimer = 0.0;
    let upgradeFlash = 0.0;

    const player = { x: PLAYER_START_X, y: PLAYER_START_Y };

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------
    const keys = { left: false, right: false, a: false, d: false };
    const touch = { left: false, right: false, jump: false };
    let jumpPressed = false;   // edge-triggered jump request

    // -----------------------------------------------------------------------
    // Audio (Web Audio API; every call is defensive so audio can never break
    // the game)
    // -----------------------------------------------------------------------
    let audioCtx = null;

    function ensureAudio() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended' && audioCtx.resume) {
                try { audioCtx.resume(); } catch (err) { /* ignore */ }
            }
            return audioCtx;
        }
        try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) { return null; }
            audioCtx = new Ctor();
        } catch (err) {
            audioCtx = null;
        }
        return audioCtx;
    }

    function tone(options) {
        try {
            const ac = ensureAudio();
            if (!ac) { return; }
            const start = ac.currentTime + (options.delay || 0);
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            osc.type = options.type || 'sine';
            osc.frequency.setValueAtTime(options.from, start);
            if (options.to && options.to !== options.from) {
                osc.frequency.exponentialRampToValueAtTime(
                    Math.max(1, options.to), start + options.duration
                );
            }
            const volume = options.volume === undefined ? 0.22 : options.volume;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + options.duration);
            osc.connect(gain);
            gain.connect(ac.destination);
            osc.start(start);
            osc.stop(start + options.duration + 0.02);
        } catch (err) {
            /* audio is decoration only */
        }
    }

    function play(name) {
        try {
            switch (name) {
                case 'coin_pickup':
                    // Two bright notes: pocketing a coin.
                    tone({ type: 'square', from: 1046, duration: 0.05, volume: 0.20 });
                    tone({ type: 'square', from: 1568, duration: 0.11, volume: 0.20, delay: 0.05 });
                    break;
                case 'jump':
                    // Rising chirp when the player leaves the ground.
                    tone({ type: 'triangle', from: 320, to: 760, duration: 0.14, volume: 0.18 });
                    break;
                case 'hurt':
                    // Falling buzz when the player hits the spikes.
                    tone({ type: 'square', from: 220, to: 70, duration: 0.26, volume: 0.20 });
                    break;
                case 'game_over':
                    // Slow descending minor arpeggio: the run is over.
                    tone({ type: 'square', from: 392, duration: 0.18, volume: 0.20 });
                    tone({ type: 'square', from: 330, duration: 0.18, volume: 0.20, delay: 0.18 });
                    tone({ type: 'square', from: 262, duration: 0.18, volume: 0.20, delay: 0.36 });
                    tone({ type: 'square', from: 175, duration: 0.34, volume: 0.20, delay: 0.54 });
                    break;
                case 'new_best':
                    // Ascending fanfare for a new personal best.
                    tone({ type: 'square', from: 523, duration: 0.10, volume: 0.20 });
                    tone({ type: 'square', from: 659, duration: 0.10, volume: 0.20, delay: 0.10 });
                    tone({ type: 'square', from: 784, duration: 0.10, volume: 0.20, delay: 0.20 });
                    tone({ type: 'square', from: 1047, duration: 0.24, volume: 0.20, delay: 0.30 });
                    break;
                case 'level_up':
                    // Short two-note rise when the tower gets harder.
                    tone({ type: 'square', from: 587, duration: 0.09, volume: 0.20 });
                    tone({ type: 'square', from: 880, duration: 0.16, volume: 0.20, delay: 0.09 });
                    break;
                default:
                    break;
            }
        } catch (err) {
            /* never let a sound effect crash the game */
        }
    }

    // -----------------------------------------------------------------------
    // High score
    // -----------------------------------------------------------------------
    function loadBest() {
        try {
            const raw = window.localStorage.getItem(BEST_KEY);
            const value = parseInt(raw, 10);
            return isNaN(value) ? 0 : Math.max(0, value);
        } catch (err) {
            return 0;
        }
    }

    function saveBest(value) {
        try {
            window.localStorage.setItem(BEST_KEY, String(value));
        } catch (err) {
            /* a read-only browser profile should not ruin a good run */
        }
    }

    const bestOutside = document.getElementById('best-outside');
    function refreshBestOutside() {
        if (bestOutside) { bestOutside.textContent = String(bestScore); }
    }

    // -----------------------------------------------------------------------
    // Level building
    // -----------------------------------------------------------------------
    function playerBox() {
        return {
            x: Math.trunc(player.x - PLAYER_HALF_W),
            y: Math.trunc(player.y - PLAYER_HALF_H),
            w: PLAYER_W,
            h: PLAYER_H
        };
    }

    function buildLevel() {
        // Create the ground, three floating rows, their spikes and the coins.
        platforms = [];
        spikes = [];
        coins = [];

        // Solid ground: 16 tiles, centred in the window.
        for (let x = TILE_W / 2; x < WIDTH; x += TILE_W) {
            platforms.push(new Platform(x, GROUND_Y, 0, 0, 1));
        }

        // Floating rows that snake upwards, always close enough to jump between.
        const rowGroups = [];
        let previousX = randint(225, 425);
        for (let index = 0; index < ROW_COUNT; index++) {
            const y = GROUND_Y - ROW_GAP * (index + 1);
            let startX = previousX + randint(-220, 220);
            startX = Math.max(ROW_MIN_X, Math.min(ROW_MAX_X, startX));

            // The bottom row is a steady base; the two above it slide.
            const moving = index > 0;
            const speed = moving ? BASE_PLATFORM_SPEED : 0.0;
            const direction = nextRandom() < 0.5 ? -1 : 1;

            const rowTiles = [];
            for (let column = 0; column < TILES_PER_ROW; column++) {
                const tile = new Platform(
                    startX + column * TILE_W, y, speed, PLATFORM_SPAN, direction
                );
                platforms.push(tile);
                rowTiles.push(tile);
            }

            rowGroups.push(rowTiles);
            previousX = startX;
        }

        // One spike per floating row to start with.
        for (const rowTiles of rowGroups) {
            spikes.push(new Spike(randomChoice(rowTiles)));
        }

        for (let i = 0; i < COINS_ON_SCREEN; i++) {
            spawnCoin();
        }

        keepSpawnClear();
    }

    function keepSpawnClear() {
        // Move the player's start to a spot with clear air around it.
        //
        // The player is 80px tall and the rows are only a little further
        // apart than that, so a row can easily be built right where the
        // player would start.  Rather than shuffling the whole tower
        // around, the player is simply placed in a column that is free of
        // platforms.
        let best = null;

        for (const tile of platforms) {
            if (tile.y < GROUND_Y) { continue; }   // only ground tiles

            const x = tile.x;
            if (x < PLAYER_HALF_W + 2 || x > WIDTH - PLAYER_HALF_W - 2) {
                continue;
            }

            let blocked = 0;
            for (const other of platforms) {
                if (other.y >= GROUND_Y) { continue; }
                if (Math.abs(other.x - x) > TILE_W) { continue; }
                blocked += 1;
            }

            if (best === null || blocked < best.blocked) {
                best = { blocked: blocked, x: x };
            }
            if (blocked === 0) { break; }
        }

        if (best !== null) {
            player.x = best.x;
        }
    }

    // Test hook: install a known, deterministic layout so the headless
    // harness can compare the physics against the original main.py frame by
    // frame.  Not used by the game itself.
    function buildFixedLevel() {
        platforms = [];
        spikes = [];
        coins = [];

        for (let x = TILE_W / 2; x < WIDTH; x += TILE_W) {
            platforms.push(new Platform(x, GROUND_Y, 0, 0, 1));
        }

        // Three floating rows, matching the layout the Python cross-check
        // uses (GROUND_Y - ROW_GAP * n).
        const rowSpec = [
            { y: GROUND_Y - ROW_GAP * 1, startX: 300, speed: 0, direction: 1 },
            { y: GROUND_Y - ROW_GAP * 2, startX: 200, speed: BASE_PLATFORM_SPEED, direction: 1 },
            { y: GROUND_Y - ROW_GAP * 3, startX: 400, speed: BASE_PLATFORM_SPEED, direction: -1 }
        ];
        for (const spec of rowSpec) {
            for (let column = 0; column < TILES_PER_ROW; column++) {
                platforms.push(new Platform(
                    spec.startX + column * TILE_W, spec.y,
                    spec.speed, spec.speed > 0 ? PLATFORM_SPAN : 0, spec.direction
                ));
            }
        }

        // One spike on the middle row, as in the cross-check scenario.
        spikes.push(new Spike(platforms[18]));

        for (let i = 0; i < COINS_ON_SCREEN; i++) {
            spawnCoin();
        }
    }

    // Test hook: build a level from a seeded pseudo random generator so the
    // browser port and main.py can be given exactly the same tower.
    function buildSeededLevel(seed) {
        let state = (seed | 0) || 1;
        const rng = function () {
            state |= 0; state = (state + 0x6D2B79F5) | 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const rngInt = function (lo, hi) {
            return lo + Math.floor(rng() * (hi - lo + 1));
        };

        platforms = [];
        spikes = [];
        coins = [];

        for (let x = TILE_W / 2; x < WIDTH; x += TILE_W) {
            platforms.push(new Platform(x, GROUND_Y, 0, 0, 1));
        }

        let previousX = rngInt(225, 425);
        for (let index = 0; index < ROW_COUNT; index++) {
            const y = GROUND_Y - ROW_GAP * (index + 1);
            let startX = previousX + rngInt(-220, 220);
            startX = Math.max(ROW_MIN_X, Math.min(ROW_MAX_X, startX));
            const moving = index > 0;
            const speed = moving ? BASE_PLATFORM_SPEED : 0.0;
            const direction = rng() < 0.5 ? -1 : 1;
            for (let column = 0; column < TILES_PER_ROW; column++) {
                platforms.push(new Platform(
                    startX + column * TILE_W, y, speed, PLATFORM_SPAN, direction
                ));
            }
            previousX = startX;
        }

        for (let i = 0; i < COINS_ON_SCREEN; i++) {
            spawnCoin();
        }
    }

    function spawnCoin() {
        // Place a coin on a free, spike-free tile that is not under the player.
        const taken = new Set(spikes.map(function (s) { return s.tile; }));
        const used = new Set(coins.map(function (c) { return c.tile; }));
        const box = playerBox();

        let candidates = [];
        for (const tile of platforms) {
            if (taken.has(tile) || used.has(tile)) {
                continue;
            }
            const spot = new Coin(tile);
            const spotBox = spot.box;
            if (rectsOverlap(box.x, box.y, box.w, box.h, spotBox.x, spotBox.y, spotBox.w, spotBox.h)) {
                continue;
            }
            candidates.push(tile);
        }

        // Favour the floating rows so the player has to climb for most coins,
        // but keep the ground in the mix as an easy breather.
        const highTiles = candidates.filter(function (tile) { return tile.y < GROUND_Y; });
        if (highTiles.length && nextRandom() < 0.75) {
            candidates = highTiles;
        }

        if (candidates.length) {
            coins.push(new Coin(randomChoice(candidates)));
        }
    }

    function addSpike() {
        // Add one more hazard, never directly on top of the player.
        const occupied = new Set(spikes.map(function (s) { return s.tile; }));
        let candidates = platforms.filter(function (tile) { return !occupied.has(tile); });

        if (upgradeLevel < 3) {
            // Keep the ground safe early on so the player always has a refuge.
            candidates = candidates.filter(function (tile) { return tile.y < GROUND_Y; });
        }

        const safe = candidates.filter(function (tile) {
            return !spikeWouldHit(tile);
        });
        if (safe.length) {
            candidates = safe;
        }

        if (candidates.length) {
            spikes.push(new Spike(randomChoice(candidates)));
        }
    }

    function spikeWouldHit(tile) {
        // True if a spike placed on this tile would touch the player right
        // now.  A spike that appears under the player's feet would hit them
        // immediately and look like random damage.
        const danger = {
            x: Math.floor(tile.x - TILE_W / 2),
            y: Math.floor(tile.topY - SPIKE_HEIGHT),
            w: TILE_W,
            h: SPIKE_HEIGHT
        };
        const box = playerBox();
        return rectsOverlap(box.x, box.y, box.w, box.h, danger.x, danger.y, danger.w, danger.h);
    }

    function applyDifficulty() {
        // Every five coins: one extra spike and slightly faster moving rows.
        const target = Math.floor(score / COINS_PER_UPGRADE);
        while (upgradeLevel < target) {
            upgradeLevel += 1;
            addSpike();
            for (const tile of platforms) {
                if (tile.speed > 0) {
                    tile.speed = Math.min(tile.speed + PLATFORM_SPEED_STEP, MAX_PLATFORM_SPEED);
                }
            }

            upgradeFlash = UPGRADE_FLASH_SECONDS;
            play('level_up');
        }
    }

    // -----------------------------------------------------------------------
    // Round flow
    // -----------------------------------------------------------------------
    function startGame() {
        // Reset everything for a fresh run.
        score = 0;
        health = MAX_HEALTH;
        state = 'playing';
        upgradeLevel = 0;
        newBest = false;

        yVelocity = 0.0;
        onGround = false;
        coyoteTimer = 0.0;
        jumpBufferTimer = 0.0;
        hurtTimer = 0.0;
        elapsed = 0.0;
        gameoverTimer = 0.0;
        upgradeFlash = 0.0;

        player.x = PLAYER_START_X;
        player.y = PLAYER_START_Y;
        buildLevel();
        refreshBestOutside();
    }

    function endGame() {
        // Freeze the game and record a new record if we have one.
        state = 'gameover';
        gameoverTimer = 0.0;

        if (score > bestScore) {
            bestScore = score;
            newBest = true;
            saveBest(bestScore);
            refreshBestOutside();
            play('new_best');
        } else {
            play('game_over');
        }
    }

    // -----------------------------------------------------------------------
    // Gameplay
    // -----------------------------------------------------------------------
    function horizontalOverlap(x, tile) {
        // True when a player centred on `x` overlaps the tile horizontally.
        return (
            x + PLAYER_HALF_W > tile.x - TILE_W / 2 &&
            x - PLAYER_HALF_W < tile.x + TILE_W / 2
        );
    }

    function movePlayer(dt) {
        // Input, gravity and solid platform collisions.
        let direction = 0;
        if (keys.left || keys.a || touch.left) { direction -= 1; }
        if (keys.right || keys.d || touch.right) { direction += 1; }

        // --- Horizontal movement, blocked by the sides of solid platforms -----
        player.x += direction * MOVE_SPEED * dt;
        player.x = Math.max(PLAYER_HALF_W, Math.min(WIDTH - PLAYER_HALF_W, player.x));

        // --- Jumping ---------------------------------------------------------
        // A jump only happens when the player is really standing on something.
        // `onGround` is maintained by the collision code below, so a player who
        // is falling through the air can never jump.
        if (jumpBufferTimer > 0 && onGround) {
            yVelocity = -JUMP_SPEED;
            jumpBufferTimer = 0.0;
            coyoteTimer = 0.0;
            onGround = false;
            play('jump');
        }

        // --- Vertical movement, resolved against solid platforms -------------
        const oldFeet = player.y + PLAYER_HALF_H;
        const oldHead = player.y - PLAYER_HALF_H;
        yVelocity = Math.min(yVelocity + GRAVITY * dt, MAX_FALL_SPEED);
        player.y += yVelocity * dt;
        let feet = player.y + PLAYER_HALF_H;
        let head = player.y - PLAYER_HALF_H;

        let landing = null;
        let landingTop = null;

        if (yVelocity >= 0) {
            // Falling: land on the top edge of any platform we crossed.  A
            // moving platform is also checked against where it used to be,
            // so a player who is standing on one is not left behind when it
            // slides out from under their feet.
            for (const tile of platforms) {
                const top = tile.topY;
                if (!horizontalOverlap(player.x, tile)) {
                    if (tile.lastDx === 0) { continue; }
                    // The tile moved this frame: check the spot it came from.
                    if (!horizontalOverlap(player.x - tile.lastDx, tile)) { continue; }
                }
                if (oldFeet <= top + LANDING_TOLERANCE && feet >= top) {
                    if (landingTop === null || top < landingTop) {
                        landing = tile;
                        landingTop = top;
                    }
                }
            }
        } else {
            // Rising: the player's HEAD is what meets the underside of a
            // platform.  If the head crossed the bottom face this frame, push
            // the player back down below it so they cannot phase up through a
            // solid tile.
            for (const tile of platforms) {
                if (!horizontalOverlap(player.x, tile)) { continue; }
                const top = tile.topY;
                const bottom = top + TILE_H;
                if (oldHead >= bottom - LANDING_TOLERANCE && head <= bottom) {
                    player.y = bottom + PLAYER_HALF_H;
                    yVelocity = 0.0;
                    break;
                }
            }
        }

        const wasGrounded = onGround;

        if (landing !== null) {
            player.y = landingTop - PLAYER_HALF_H;
            yVelocity = 0.0;
            onGround = true;
        } else {
            // Not over any platform: the player falls.
            onGround = false;
        }

        // --- Moving platforms carry the player -------------------------------
        // If the player is standing on a platform, the platform's own movement
        // this frame is added to the player, so they ride along instead of being
        // left behind in mid-air.  The tile the player is actually resting on
        // is used - matched by height, so a player who overlaps a row above
        // is not carried by it as well.
        if (onGround) {
            let carryDx = 0.0;
            const feetNow = player.y + PLAYER_HALF_H;
            for (const tile of platforms) {
                if (tile.lastDx === 0) { continue; }
                if (!horizontalOverlap(player.x, tile)) { continue; }
                if (Math.abs(feetNow - tile.topY) > LANDING_TOLERANCE) { continue; }
                carryDx = tile.lastDx;
                break;
            }
            player.x += carryDx;
        }

        // --- Solid platform bodies -------------------------------------------
        // A platform is a solid block, not just a ledge.  If the player's body
        // ends up inside one, they are pushed out vertically to the nearest
        // free face instead of sinking through it.  The check is deliberately
        // narrow: it only triggers when the player is genuinely buried in the
        // block, so it never interferes with a normal landing.
        for (const tile of platforms) {
            if (!horizontalOverlap(player.x, tile)) { continue; }

            const top = tile.topY;
            const bottom = top + TILE_H;
            const head = player.y - PLAYER_HALF_H;
            feet = player.y + PLAYER_HALF_H;

            // Standing on top of it: fine.
            if (feet <= top + LANDING_TOLERANCE) { continue; }

            // Entirely below it: fine.
            if (head >= bottom) { continue; }

            // The player's body overlaps the block.  Push them out of it.
            // When falling, they are lifted onto the platform - the natural
            // "land on it" outcome - unless their head is below the platform,
            // in which case they are pushed out below it.
            if (yVelocity >= 0 && head <= top + LANDING_TOLERANCE) {
                // Falling onto the platform.
                player.y = top - PLAYER_HALF_H;
                yVelocity = 0.0;
                onGround = true;
            } else if (yVelocity < 0 && feet >= bottom - LANDING_TOLERANCE) {
                // Rising into its underside: pushed back down.
                player.y = bottom + PLAYER_HALF_H;
                yVelocity = 0.0;
            } else {
                // Anywhere else: push out towards the nearer face so the
                // player is never left buried inside a block.
                const centre = player.y;
                if (Math.abs(centre - top) <= Math.abs(centre - bottom)) {
                    player.y = top - PLAYER_HALF_H;
                    yVelocity = 0.0;
                    onGround = true;
                } else {
                    player.y = bottom + PLAYER_HALF_H;
                    yVelocity = 0.0;
                }
            }
        }

        player.x = Math.max(PLAYER_HALF_W, Math.min(WIDTH - PLAYER_HALF_W, player.x));

        if (wasGrounded && !onGround) {
            coyoteTimer = COYOTE_TIME;
        } else {
            coyoteTimer = Math.max(0.0, coyoteTimer - dt);
        }

        jumpBufferTimer = Math.max(0.0, jumpBufferTimer - dt);
    }

    function collectCoins() {
        const box = playerBox();
        for (let i = coins.length - 1; i >= 0; i--) {
            const coin = coins[i];
            const cbox = coin.box;
            if (rectsOverlap(box.x, box.y, box.w, box.h, cbox.x, cbox.y, cbox.w, cbox.h)) {
                coins.splice(i, 1);
                score += COIN_POINTS;
                play('coin_pickup');
                spawnCoin();
                applyDifficulty();
            }
        }
    }

    function checkSpikes() {
        if (hurtTimer > 0) {
            return;
        }

        const box = playerBox();
        for (const spike of spikes) {
            const danger = spike.dangerBox;
            if (!rectsOverlap(box.x, box.y, box.w, box.h, danger.x, danger.y, danger.w, danger.h)) {
                continue;
            }

            health = Math.max(0, health - SPIKE_DAMAGE);
            score = Math.max(0, score - 1);
            hurtTimer = SPIKE_COOLDOWN;
            play('hurt');

            // Push the player away from the spike instead of straight up.  An
            // upward knock-back would push the player straight back into the
            // spikes, which made them take damage over and over.
            const away = player.x >= spike.tile.x ? 1.0 : -1.0;
            player.x += away * SPIKE_KNOCKBACK;
            player.x = Math.max(PLAYER_HALF_W, Math.min(WIDTH - PLAYER_HALF_W, player.x));

            // A small hop so the player clears the spikes, but not so much that
            // they shoot up through the platform above.
            yVelocity = -SPIKE_KNOCKBACK_JUMP;
            onGround = false;

            if (health <= 0) {
                endGame();
            }
            break;
        }
    }

    function update(dt) {
        // Clamp dt so a stalled frame cannot teleport the player through a platform.
        dt = Math.min(dt, 0.05);

        if (state === 'gameover') {
            gameoverTimer += dt;
            return;
        }

        elapsed += dt;
        hurtTimer = Math.max(0.0, hurtTimer - dt);
        upgradeFlash = Math.max(0.0, upgradeFlash - dt);

        for (const tile of platforms) {
            tile.advance(dt);
        }
        for (const spike of spikes) {
            spike.follow();
        }
        for (const coin of coins) {
            coin.follow();
        }

        movePlayer(dt);
        collectCoins();
        checkSpikes();
    }

    function onKeyDown(key) {
        if (key === 'space' || key === 'up' || key === 'w' ||
            key === 'Space' || key === 'ArrowUp' || key === 'W') {
            if (state === 'gameover') {
                if (gameoverTimer >= RETRY_DELAY) {
                    startGame();
                }
            } else {
                jumpBufferTimer = JUMP_BUFFER;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Drawing
    // -----------------------------------------------------------------------
    function label(text, x, y, size, color, align) {
        // Draw text in the custom pixel font with a readable drop shadow.
        const fill = color || TEXT_COLOR;
        ctx.save();
        ctx.font = size + 'px "PressStart2P", monospace';
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'top';

        let drawX = x;
        if (align === 'center') {
            drawX = x - ctx.measureText(text).width / 2;
        } else if (align === 'right') {
            drawX = x - ctx.measureText(text).width;
        }

        ctx.fillStyle = TEXT_SHADOW;
        ctx.fillText(text, drawX + 2, y + 2);
        ctx.fillStyle = fill;
        ctx.fillText(text, drawX, y);
        ctx.restore();
    }

    function drawImage(name, x, y) {
        const img = images[name];
        if (!img) { return; }
        ctx.drawImage(img, x, y);
    }

    function drawHud() {
        label('SCORE ' + score, 16, 12, 16);
        label('BEST ' + bestScore, 16, 42, 10, SUB_TEXT_COLOR);

        const healthColor = hurtTimer > 0 ? '#ff7878' : TEXT_COLOR;
        label('HEALTH ' + health, WIDTH - 16, 12, 16, healthColor, 'right');

        if (upgradeFlash > 0) {
            // A short, gently pulsing callout so the difficulty jump is not a
            // surprise.  The tint is the accent colour scaled by the pulse.
            const pulse = 0.72 + 0.28 * Math.sin(upgradeFlash * 20.0);
            const tint = 'rgb(' +
                Math.trunc(255 * pulse) + ',' +
                Math.trunc(214 * pulse) + ',' +
                Math.trunc(92 * pulse) + ')';
            label('LEVEL ' + upgradeLevel, WIDTH / 2, 92, 16, tint, 'center');
            label('THE TOWER SPEEDS UP', WIDTH / 2, 120, 8, undefined, 'center');
        }

        if (elapsed < HINT_SECONDS && state === 'playing') {
            label('ARROWS MOVE - SPACE JUMPS', WIDTH / 2, HEIGHT - 30, 10, '#ebeefa', 'center');
        }
    }

    function drawGameOver() {
        const panelX = 70;
        const panelY = 160;
        const panelW = WIDTH - 140;
        const panelH = 280;

        ctx.save();
        ctx.fillStyle = '#0e1222';
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.strokeStyle = ACCENT_COLOR;
        ctx.lineWidth = 2;
        ctx.strokeRect(panelX + 1, panelY + 1, panelW - 2, panelH - 2);
        ctx.restore();

        label('GAME OVER', WIDTH / 2, 200, 28, ACCENT_COLOR, 'center');
        label('SCORE ' + score, WIDTH / 2, 270, 20, undefined, 'center');
        label('BEST ' + bestScore, WIDTH / 2, 305, 14, '#cdd6ee', 'center');

        if (newBest) {
            label('NEW BEST!', WIDTH / 2, 345, 16, ACCENT_COLOR, 'center');
        }

        if (Math.trunc(gameoverTimer * 2) % 2 === 0) {
            label('PRESS SPACE TO RETRY', WIDTH / 2, 395, 10, '#e1e6f5', 'center');
        }
    }

    function draw() {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = '#0b0e18';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        drawImage('background', 0, 0);

        for (const tile of platforms) {
            drawImage('platform', tile.x - TILE_W / 2, tile.y - TILE_H / 2);
        }
        for (const coin of coins) {
            drawImage('coin', coin.x - 11, coin.y - 11);
        }
        for (const spike of spikes) {
            drawImage('spikes', spike.x - TILE_W / 2, spike.y - TILE_H / 2);
        }
        drawImage('player', player.x - PLAYER_HALF_W, player.y - PLAYER_HALF_H);

        drawHud();
        if (state === 'gameover') {
            drawGameOver();
        }
    }

    // -----------------------------------------------------------------------
    // Event wiring
    // -----------------------------------------------------------------------
    const KEY_ALIASES = {
        ArrowLeft: 'left', a: 'a', A: 'a',
        ArrowRight: 'right', d: 'd', D: 'd'
    };

    // Keys the page must never act on: arrow keys scroll the document and
    // space scrolls it too, which would fight with the game controls.
    const SWALLOWED_KEYS = {
        ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true,
        ' ': true, Spacebar: true, PageUp: true, PageDown: true, Home: true, End: true
    };

    function onKeyDownEvent(event) {
        ensureAudio();

        if (SWALLOWED_KEYS[event.key]) {
            event.preventDefault();
        }

        const alias = KEY_ALIASES[event.key];
        if (alias) {
            keys[alias] = true;
            return;
        }
        if (event.key === ' ' || event.key === 'Spacebar' ||
            event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
            if (!event.repeat) {
                onKeyDown('space');
            }
            return;
        }
        if (event.key === 'Enter' && state === 'gameover' && gameoverTimer >= RETRY_DELAY) {
            event.preventDefault();
            startGame();
        }
    }

    function onKeyUpEvent(event) {
        const alias = KEY_ALIASES[event.key];
        if (alias) {
            keys[alias] = false;
        }
        if (SWALLOWED_KEYS[event.key]) {
            event.preventDefault();
        }
    }

    window.addEventListener('keydown', onKeyDownEvent, { passive: false });
    window.addEventListener('keyup', onKeyUpEvent, { passive: false });
    window.addEventListener('blur', function () {
        keys.left = keys.right = keys.a = keys.d = false;
        touch.left = touch.right = touch.jump = false;
        jumpPressed = false;
        setPadActive();
    });

    // Touch / mouse pads
    const padLeft = document.getElementById('pad-left');
    const padRight = document.getElementById('pad-right');
    const padJump = document.getElementById('pad-jump');

    function setPadActive() {
        if (padLeft) { padLeft.classList.toggle('active', touch.left); }
        if (padRight) { padRight.classList.toggle('active', touch.right); }
        if (padJump) { padJump.classList.toggle('active', touch.jump); }
    }

    function bindPad(element, onDown, onUp) {
        if (!element) { return; }
        let down = false;
        const press = function (event) {
            if (event && event.cancelable) { event.preventDefault(); }
            if (down) { return; }      // a pointer event is often followed by a mouse event
            down = true;
            ensureAudio();
            try { element.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
            onDown();
            setPadActive();
        };
        const release = function (event) {
            if (event && event.cancelable) { event.preventDefault(); }
            if (!down) { return; }
            down = false;
            onUp();
            setPadActive();
        };
        element.addEventListener('pointerdown', press);
        element.addEventListener('pointerup', release);
        element.addEventListener('pointercancel', release);
        element.addEventListener('pointerleave', release);
        element.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        // Fallback for browsers/devices that do not deliver pointer events:
        // plain mouse and touch events still drive the pads.
        element.addEventListener('mousedown', press);
        element.addEventListener('mouseup', release);
        element.addEventListener('touchstart', press, { passive: false });
        element.addEventListener('touchend', release);
        element.addEventListener('touchcancel', release);
        element.addEventListener('mouseleave', release);
    }

    bindPad(padLeft, function () { touch.left = true; }, function () { touch.left = false; });
    bindPad(padRight, function () { touch.right = true; }, function () { touch.right = false; });
    bindPad(padJump, function () {
        touch.jump = true;
        onKeyDown('space');
    }, function () { touch.jump = false; });

    // Show the on-screen pads whenever the device has touch support, and let
    // the player switch them on manually otherwise.
    const padsToggle = document.getElementById('pads-toggle');
    const touchControls = document.getElementById('touch-controls');

    function setPadsVisible(visible) {
        if (!touchControls) { return; }
        touchControls.style.display = visible ? 'flex' : '';
        if (padsToggle) {
            padsToggle.textContent = visible ? 'HIDE TOUCH PADS' : 'SHOW TOUCH PADS';
        }
    }

    function hasTouchSupport() {
        try {
            return ('ontouchstart' in window) ||
                (navigator.maxTouchPoints > 0) ||
                (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        } catch (err) {
            return false;
        }
    }

    if (hasTouchSupport()) {
        document.body.classList.add('has-touch');
    }
    if (padsToggle) {
        padsToggle.addEventListener('click', function () {
            ensureAudio();
            const shown = touchControls && touchControls.style.display === 'flex';
            setPadsVisible(!shown);
        });
    }

    // Pause when the tab is hidden so we never get a huge dt spike.
    let paused = false;
    let accumulator = 0;
    let lastTime = 0;

    document.addEventListener('visibilitychange', function () {
        paused = document.hidden;
        if (!paused) {
            lastTime = performance.now();
            accumulator = 0;
        }
    });

    // -----------------------------------------------------------------------
    // Main loop (fixed timestep + accumulator)
    // -----------------------------------------------------------------------
    function frame(now) {
        requestAnimationFrame(frame);

        if (paused) {
            lastTime = now;
            return;
        }

        if (!lastTime) { lastTime = now; }
        let elapsedTime = (now - lastTime) / 1000;
        lastTime = now;

        if (elapsedTime > MAX_FRAME_TIME) { elapsedTime = MAX_FRAME_TIME; }
        if (elapsedTime < 0) { elapsedTime = 0; }

        accumulator += elapsedTime;

        let steps = 0;
        while (accumulator >= FIXED_DT && steps < 8) {
            update(FIXED_DT);
            accumulator -= FIXED_DT;
            steps += 1;
        }
        if (steps >= 8) {
            // Give up on the backlog rather than spiralling.
            accumulator = 0;
        }

        draw();
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    function loadImages(callback) {
        let pending = Object.keys(ASSETS).length;
        if (pending === 0) { callback(); return; }
        for (const name of Object.keys(ASSETS)) {
            const img = new Image();
            img.onload = function () {
                pending -= 1;
                if (pending <= 0) { callback(); }
            };
            img.onerror = function () {
                pending -= 1;
                if (pending <= 0) { callback(); }
            };
            img.src = ASSETS[name];
            images[name] = img;
        }
    }

    function boot() {
        bestScore = loadBest();
        refreshBestOutside();
        startGame();
        requestAnimationFrame(frame);
        try { canvas.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }

    // Expose a small test surface so the headless harness can drive the game.
    window.SkywardScramble = {
        constants: {
            WIDTH: WIDTH, HEIGHT: HEIGHT, TILE_W: TILE_W, TILE_H: TILE_H,
            GROUND_Y: GROUND_Y, ROW_GAP: ROW_GAP, ROW_COUNT: ROW_COUNT,
            TILES_PER_ROW: TILES_PER_ROW, ROW_MIN_X: ROW_MIN_X, ROW_MAX_X: ROW_MAX_X,
            PLATFORM_SPAN: PLATFORM_SPAN, BASE_PLATFORM_SPEED: BASE_PLATFORM_SPEED,
            PLAYER_W: PLAYER_W, PLAYER_H: PLAYER_H, MOVE_SPEED: MOVE_SPEED,
            JUMP_SPEED: JUMP_SPEED, GRAVITY: GRAVITY, MAX_FALL_SPEED: MAX_FALL_SPEED,
            COYOTE_TIME: COYOTE_TIME, JUMP_BUFFER: JUMP_BUFFER,
            LANDING_TOLERANCE: LANDING_TOLERANCE,
            COIN_POINTS: COIN_POINTS, COINS_ON_SCREEN: COINS_ON_SCREEN,
            COINS_PER_UPGRADE: COINS_PER_UPGRADE, PLATFORM_SPEED_STEP: PLATFORM_SPEED_STEP,
            MAX_PLATFORM_SPEED: MAX_PLATFORM_SPEED, MAX_HEALTH: MAX_HEALTH,
            SPIKE_DAMAGE: SPIKE_DAMAGE, SPIKE_COOLDOWN: SPIKE_COOLDOWN,
            SPIKE_HEIGHT: SPIKE_HEIGHT, SPIKE_KNOCKBACK: SPIKE_KNOCKBACK,
            SPIKE_KNOCKBACK_JUMP: SPIKE_KNOCKBACK_JUMP,
            HINT_SECONDS: HINT_SECONDS, RETRY_DELAY: RETRY_DELAY,
            FIXED_DT: FIXED_DT
        },
        get state() { return state; },
        get score() { return score; },
        set score(v) { score = v; },
        get bestScore() { return bestScore; },
        set bestScore(v) { bestScore = v; },
        get health() { return health; },
        set health(v) { health = v; },
        get upgradeLevel() { return upgradeLevel; },
        get onGround() { return onGround; },
        set onGround(v) { onGround = v; },
        get yVelocity() { return yVelocity; },
        set yVelocity(v) { yVelocity = v; },
        get coyoteTimer() { return coyoteTimer; },
        set coyoteTimer(v) { coyoteTimer = v; },
        get jumpBufferTimer() { return jumpBufferTimer; },
        set jumpBufferTimer(v) { jumpBufferTimer = v; },
        get hurtTimer() { return hurtTimer; },
        set hurtTimer(v) { hurtTimer = v; },
        get elapsed() { return elapsed; },
        get gameoverTimer() { return gameoverTimer; },
        get player() { return player; },
        playerBox: playerBox,
        horizontalOverlap: horizontalOverlap,
        get platforms() { return platforms; },
        get spikes() { return spikes; },
        get coins() { return coins; },
        get newBest() { return newBest; },
        update: update,
        draw: draw,
        startGame: startGame,
        buildFixedLevel: buildFixedLevel,
        buildSeededLevel: buildSeededLevel,
        seedRandom: seedRandom,
        endGame: endGame,
        applyDifficulty: applyDifficulty,
        onKeyDown: onKeyDown,
        setKey: function (name, value) { keys[name] = value; },
        touch: touch
    };

    loadImages(boot);
}());

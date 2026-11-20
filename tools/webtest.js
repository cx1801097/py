/**
 * Headless check of the browser build (tools/game.js).
 *
 * The page needs a DOM and a canvas, so the game is loaded into a tiny
 * stub environment and then driven with the same checks as the Python
 * version.  This catches the five reported bugs in the browser build:
 *
 *   - coins drifting on their own
 *   - the player floating in mid-air
 *   - the player taking damage at random
 *   - the player jumping while not touching a platform
 *   - the player phasing through a platform
 *
 * Run:
 *     node tools/webtest.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const SOURCE = path.join(ROOT, 'tools', 'game.js');

// ---------------------------------------------------------------------------
// A minimal stub of everything the game touches.
// ---------------------------------------------------------------------------
function makeStub() {
    const listeners = {};

    function noop() {}

    const ctx = new Proxy({}, {
        get(target, prop) {
            if (prop === 'canvas') { return { width: 800, height: 600 }; }
            if (prop === 'measureText') {
                return function () { return { width: 10 }; };
            }
            if (prop === 'createLinearGradient') {
                return function () { return { addColorStop: noop }; };
            }
            if (prop in target) { return target[prop]; }
            return noop;
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        }
    });

    const canvas = {
        width: 800,
        height: 600,
        style: {},
        getContext() { return ctx; },
        addEventListener: noop,
        removeEventListener: noop,
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 800, height: 600 };
        },
        focus: noop
    };

    const elements = {};

    function element(id) {
        if (!elements[id]) {
            elements[id] = {
                id: id,
                textContent: '',
                innerHTML: '',
                style: {},
                classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
                addEventListener: noop,
                removeEventListener: noop,
                getContext() { return ctx; },
                width: 800,
                height: 600,
                focus: noop
            };
        }
        return elements[id];
    }

    const windowStub = {
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        removeEventListener: noop,
        matchMedia() { return { matches: false, addListener: noop, removeListener: noop }; },
        localStorage: {
            _data: {},
            getItem(key) { return this._data[key] === undefined ? null : this._data[key]; },
            setItem(key, value) { this._data[key] = String(value); }
        },
        AudioContext: function () {
            return {
                state: 'running',
                currentTime: 0,
                destination: {},
                resume() { return Promise.resolve(); },
                createGain() {
                    return {
                        gain: { value: 1, setValueAtTime: noop, linearRampToValueAtTime: noop },
                        connect: noop
                    };
                },
                createOscillator() {
                    return {
                        frequency: { value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop },
                        type: 'sine',
                        connect: noop,
                        start: noop,
                        stop: noop
                    };
                }
            };
        },
        requestAnimationFrame() { return 0; },
        cancelAnimationFrame: noop,
        devicePixelRatio: 1,
        innerWidth: 1200,
        innerHeight: 800,
        document: {
            body: { classList: { add: noop, remove: noop, contains: () => false } },
            addEventListener: noop,
            getElementById: element,
            querySelector: () => element('x'),
            querySelectorAll: () => [],
            createElement: () => element('created'),
            fonts: { ready: Promise.resolve(), load: () => Promise.resolve() }
        }
    };

    windowStub.window = windowStub;
    windowStub.self = windowStub;
    windowStub.globalThis = windowStub;

    const context = vm.createContext(windowStub);

    // The image loader creates Image objects and waits for onload.  Fake it
    // so the game boots immediately.
    class FakeImage {
        constructor() {
            this.width = 1;
            this.height = 1;
            setTimeout(() => { if (this.onload) { this.onload(); } }, 0);
        }
    }

    context.Image = FakeImage;
    context.document.createElement = function (tag) {
        if (String(tag).toLowerCase() === 'img') { return new FakeImage(); }
        return element('created');
    };
    context.fetch = function () { return Promise.reject(new Error('no fetch')); };
    context.setTimeout = setTimeout;
    context.clearTimeout = clearTimeout;
    context.setInterval = setInterval;
    context.clearInterval = clearInterval;
    context.console = console;
    context.Promise = Promise;
    context.Math = Math;
    context.Date = Date;
    context.JSON = JSON;
    context.parseInt = parseInt;
    context.parseFloat = parseFloat;
    context.isNaN = isNaN;
    context.requestAnimationFrame = windowStub.requestAnimationFrame;
    context.cancelAnimationFrame = windowStub.cancelAnimationFrame;

    return context;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
const failures = [];
let checks = 0;

function check(name, condition, detail) {
    checks += 1;
    const status = condition ? 'PASS' : 'FAIL';
    console.log('  [' + status + '] ' + name + (detail ? '  ' + detail : ''));
    if (!condition) {
        failures.push(name);
    }
}

function horizontalOverlap(x, tile, C) {
    return (
        x + C.PLAYER_W / 2 > tile.x - C.TILE_W / 2 &&
        x - C.PLAYER_W / 2 < tile.x + C.TILE_W / 2
    );
}

function overlapBox(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function run() {
    const context = makeStub();
    const code = fs.readFileSync(SOURCE, 'utf8');

    // The game boots inside a DOMContentLoaded / image-load callback.
    vm.runInContext(code, context, { filename: 'game.js' });

    // Wait for the fake images to fire their onload and the game to boot.
    return new Promise((resolve) => {
        setTimeout(() => {
            const G = context.window.SkywardScramble;
            if (!G) {
                console.log('  [FAIL] the game did not boot');
                failures.push('boot');
                resolve();
                return;
            }
            runChecks(G);
            resolve();
        }, 60);
    });
}

function runChecks(G) {
    const C = G.constants;
    const dt = C.FIXED_DT;

    // Build a level with a fixed layout, so the checks are deterministic.
    function build(seed) {
        G.seedRandom(seed);
        G.startGame();
    }

    console.log('Boot');
    check('game exposes its state', typeof G.update === 'function');
    check('constants match the Python version',
        C.ROW_GAP === 118 && C.SPIKE_HEIGHT === 12 && C.PLAYER_H === 80,
        '(ROW_GAP ' + C.ROW_GAP + ', SPIKE_HEIGHT ' + C.SPIKE_HEIGHT + ')');

    // -----------------------------------------------------------------------
    console.log('Coins stay put');
    G.startGame();
    for (let i = 0; i < 240; i++) { G.update(dt); }
    let coinDrift = 0;
    for (const coin of G.coins) {
        coinDrift = Math.max(coinDrift, Math.abs(coin.y - (coin.tile.topY - 26)));
    }
    check('coin keeps a fixed height above its platform', coinDrift < 0.001,
        '(' + coinDrift.toFixed(3) + ')');

    // -----------------------------------------------------------------------
    console.log('No floating in mid-air');
    let hovering = 0;
    for (let run = 0; run < 25; run++) {
        G.startGame();
        for (let i = 0; i < 200; i++) {
            G.update(dt);
            if (G.onGround) {
                const feet = G.player.y + C.PLAYER_H / 2;
                const onAPlatform = G.platforms.some(
                    (tile) => Math.abs(feet - tile.topY) < 1.5
                );
                if (!onAPlatform) { hovering += 1; }
            }
        }
    }
    check('player is never left hovering', hovering === 0, '(' + hovering + ' bad frames)');

    // -----------------------------------------------------------------------
    console.log('The player falls when they walk off a platform');
    G.startGame();
    G.player.x = C.WIDTH - C.PLAYER_W / 2 - 5;
    G.yVelocity = 0;
    G.onGround = true;
    G.setKey('right', true);
    let fell = false;
    for (let i = 0; i < 240; i++) {
        G.update(dt);
        if (!G.onGround) { fell = true; break; }
    }
    G.setKey('right', false);
    check('player falls when they walk off the edge', fell);

    // -----------------------------------------------------------------------
    console.log('The moving platform carries the player');
    let carryFailures = 0;
    for (let run = 0; run < 20; run++) {
        G.startGame();
        // Pick a moving tile that has clear air above it, so the player can
        // actually land on it.  A tile with a platform directly overhead
        // would push the player out of the way instead.
        let tile = null;
        for (const t of G.platforms) {
            if (!(t.speed > 0 && t.x > 150 && t.x < 650)) { continue; }
            const dropY = t.topY - (C.PLAYER_H + 2);
            const blocked = G.platforms.some(function (o) {
                if (o === t) { return false; }
                if (!horizontalOverlap(t.x, o, C)) { return false; }
                return o.topY - C.PLAYER_H / 2 < dropY + C.PLAYER_H / 2 &&
                       o.topY + C.TILE_H > dropY - C.PLAYER_H / 2;
            });
            if (!blocked) { tile = t; break; }
        }
        if (!tile) { continue; }
        G.player.x = tile.x;
        G.player.y = tile.topY - C.PLAYER_H / 2;
        G.yVelocity = 0;
        G.onGround = false;
        const trace = [];
        for (let i = 0; i < 20; i++) {
            G.update(dt);
            trace.push('    ' + i + ' px ' + G.player.x.toFixed(1) +
                ' py ' + G.player.y.toFixed(1) +
                ' feet ' + (G.player.y + C.PLAYER_H / 2).toFixed(1) +
                ' tileX ' + tile.x.toFixed(1) + ' top ' + tile.topY.toFixed(1) +
                ' vy ' + G.yVelocity.toFixed(1) + ' og ' + G.onGround);
        }
        if (process.env.TRACE) { console.log(trace.join('\n')); }
        const startX = G.player.x;
        const startTile = tile.x;
        for (let i = 0; i < 30; i++) { G.update(dt); }
        const playerMove = G.player.x - startX;
        const tileMove = tile.x - startTile;
        if (Math.abs(playerMove - tileMove) > 2) {
            carryFailures += 1;
            console.log('    >> run ' + (run + 1) + ' FAILED');
            if (carryFailures <= 3) {
                console.log('    player ' + playerMove.toFixed(2) + ' tile ' + tileMove.toFixed(2) +
                    ' | tileX ' + tile.x.toFixed(1) + ' top ' + tile.topY.toFixed(1) +
                    ' dir ' + tile.direction + ' playerY ' + G.player.y.toFixed(1) +
                    ' onGround ' + G.onGround + ' feet ' + (G.player.y + C.PLAYER_H / 2).toFixed(1));
                for (const o of G.platforms) {
                    if (Math.abs(o.topY - tile.topY) < 200 && Math.abs(o.x - G.player.x) < 60) {
                        console.log('      near x ' + o.x.toFixed(1) + ' top ' + o.topY.toFixed(1) +
                            ' dir ' + o.direction + ' lastDx ' + o.lastDx.toFixed(3) + ' speed ' + o.speed);
                    }
                }
                for (const o of G.platforms) {
                    if (Math.abs(o.x - G.player.x) < 40 && Math.abs(o.topY - tile.topY) < 40) {
                        console.log('      near x ' + o.x.toFixed(1) + ' top ' + o.topY.toFixed(1) +
                            ' dir ' + o.direction + ' lastDx ' + o.lastDx.toFixed(3));
                    }
                }
            }
            if (carryFailures <= 0) {
                console.log('    player ' + playerMove.toFixed(2) + ' tile ' + tileMove.toFixed(2) +
                    ' | tileX ' + tile.x.toFixed(1) + ' top ' + tile.topY.toFixed(1) +
                    ' dir ' + tile.direction + ' speed ' + tile.speed);
                for (const o of G.platforms) {
                    if (Math.abs(o.x - G.player.x) < 60) {
                        console.log('      other x ' + o.x.toFixed(1) + ' top ' + o.topY.toFixed(1) +
                            ' dir ' + o.direction + ' speed ' + o.speed + ' lastDx ' + o.lastDx.toFixed(3));
                    }
                }
            }
        }
    }
    check('moving platform carries the player', carryFailures === 0,
        '(' + carryFailures + ' bad runs)');

    // -----------------------------------------------------------------------
    console.log('No jumping in mid-air');
    G.startGame();
    for (let i = 0; i < 200; i++) { G.update(dt); }
    G.yVelocity = -400;
    G.onGround = false;
    G.coyoteTimer = 0;
    G.jumpBufferTimer = 0;
    G.update(dt);
    const before = G.yVelocity;
    G.onKeyDown('space');
    G.update(dt);
    check('jump is ignored while airborne', G.yVelocity > before,
        '(' + before.toFixed(0) + ' -> ' + G.yVelocity.toFixed(0) + ')');
    check('player stays airborne', !G.onGround);

    // -----------------------------------------------------------------------
    console.log('No phasing through platforms');
    let sunk = 0;
    let drops = 0;
    for (const target of G.platforms.slice()) {
        G.startGame();
        if (target.speed > 0) { continue; }
        const dropY = target.topY - (C.PLAYER_H + 2);
        const clear = !G.platforms.some(
            (tile) =>
                horizontalOverlap(target.x, tile, C) &&
                tile.topY - C.PLAYER_H / 2 < dropY + C.PLAYER_H / 2 &&
                tile.topY + C.TILE_H > dropY - C.PLAYER_H / 2
        );
        if (!clear) { continue; }
        drops += 1;
        G.player.x = target.x;
        G.player.y = dropY;
        G.yVelocity = 0;
        G.onGround = false;
        for (let i = 0; i < 120; i++) {
            G.update(dt);
            const feet = G.player.y + C.PLAYER_H / 2;
            const head = G.player.y - C.PLAYER_H / 2;
            for (const tile of G.platforms) {
                if (!horizontalOverlap(G.player.x, tile, C)) { continue; }
                const top = tile.topY;
                const bottom = top + C.TILE_H;
                if (feet <= top + 1.5) { continue; }
                if (head >= bottom) { continue; }
                sunk += 1;
                break;
            }
        }
    }
    check('player never sinks into a platform', sunk === 0,
        '(' + sunk + ' cases over ' + drops + ' drops)');

    // -----------------------------------------------------------------------
    console.log('The player never spawns inside a platform');
    let spawnFailures = 0;
    for (let run = 0; run < 60; run++) {
        G.startGame();
        for (const tile of G.platforms) {
            if (!horizontalOverlap(G.player.x, tile, C)) { continue; }
            const head = G.player.y - C.PLAYER_H / 2;
            const feet = G.player.y + C.PLAYER_H / 2;
            if (head < tile.topY + C.TILE_H && feet > tile.topY) {
                spawnFailures += 1;
                break;
            }
        }
    }
    check('player starts clear of every platform', spawnFailures === 0,
        '(' + spawnFailures + ' cases)');

    // -----------------------------------------------------------------------
    console.log('Spikes only hurt on contact');
    let falseDamage = 0;
    for (let run = 0; run < 40; run++) {
        G.startGame();
        for (let i = 0; i < 200; i++) {
            const healthBefore = G.health;
            G.update(dt);
            const touched = G.spikes.some(
                (spike) => overlapBox(G.playerBox(), spike.dangerBox)
            );
            if (G.health < healthBefore && !touched) { falseDamage += 1; }
        }
    }
    check('no damage without touching a spike', falseDamage === 0,
        '(' + falseDamage + ' cases)');

    // -----------------------------------------------------------------------
    console.log('One hit does not become many');
    G.startGame();
    const spike = G.spikes[0];
    G.player.x = spike.tile.x;
    G.player.y = spike.tile.topY - C.PLAYER_H / 2;
    G.yVelocity = 0;
    G.onGround = true;
    G.hurtTimer = 0;
    const healthBefore = G.health;
    G.update(dt);
    check('spike deals one hit', G.health === healthBefore - C.SPIKE_DAMAGE,
        '(' + healthBefore + ' -> ' + G.health + ')');
    for (let i = 0; i < 20; i++) { G.update(dt); }
    check('no follow-up hit right after', G.health === healthBefore - C.SPIKE_DAMAGE,
        '(' + G.health + ')');

    // -----------------------------------------------------------------------
    console.log('Coins score');
    G.startGame();
    const coin = G.coins[0];
    G.player.x = coin.x;
    G.player.y = coin.y;
    const scoreBefore = G.score;
    G.update(dt);
    check('touching a coin scores a point', G.score === scoreBefore + 1,
        '(' + scoreBefore + ' -> ' + G.score + ')');
    check('coin is replaced', G.coins.length === 3);

    // -----------------------------------------------------------------------
    console.log('Difficulty ramp');
    G.startGame();
    const baseSpeed = Math.max(...G.platforms.map((t) => t.speed));
    const startSpikes = G.spikes.length;
    G.score = C.COINS_PER_UPGRADE;
    G.applyDifficulty();
    check('more spikes after five coins', G.spikes.length > startSpikes,
        '(' + startSpikes + ' -> ' + G.spikes.length + ')');
    check('platforms speed up',
        Math.max(...G.platforms.map((t) => t.speed)) > baseSpeed);

    console.log('');
    if (failures.length) {
        console.log(failures.length + ' check(s) failed: ' + failures.join(', '));
        process.exitCode = 1;
    } else {
        console.log('All ' + checks + ' checks passed.');
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

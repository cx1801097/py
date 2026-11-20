/* Compare the moving-platform carry between main.py and the JS port.
 *
 * Uses the same seeded level layout in both, so the numbers can be compared
 * directly.  Run tools/carrycheck.py with the same SEED first.
 *
 * Usage: node tools/carrycheck.js [seed]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const SEED = process.argv[2] || '7';
const source = fs.readFileSync(path.join(ROOT, 'tools', 'game.js'), 'utf8');

// A tiny deterministic PRNG (mulberry32) used only to lay out a fixed level.
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeElement(id) {
    return {
        id, width: 800, height: 600, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        textContent: '',
        addEventListener() {},
        getContext() {
            return {
                canvas: { width: 800, height: 600 },
                measureText: t => ({ width: String(t).length * 8 }),
                save() {}, restore() {}, fillRect() {}, strokeRect() {},
                drawImage() {}, fillText() {}, clearRect() {}
            };
        },
        setPointerCapture() {}, focus() {}
    };
}

const elements = {};
const documentStub = {
    hidden: false,
    getElementById(id) { return elements[id] || (elements[id] = makeElement(id)); },
    createElement() { return makeElement('d'); },
    addEventListener() {}
};
const windowStub = {
    document: documentStub,
    performance: { now: () => 0 },
    requestAnimationFrame() { return 0; },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    AudioContext: undefined
};
windowStub.Image = function () {
    const self = this;
    this.width = 50; this.height = 24;
    Object.defineProperty(this, 'src', {
        set(v) { self._src = v; if (self.onload) { self.onload(); } },
        get() { return this._src; }
    });
};

const sandbox = {
    window: windowStub, document: documentStub,
    localStorage: windowStub.localStorage,
    performance: windowStub.performance,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    Image: windowStub.Image, AudioContext: undefined,
    setTimeout, clearTimeout, Math, JSON, console, Date, Object, Array, String,
    Number, Boolean, Error, isNaN, parseInt, parseFloat
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'game.js' });

const G = sandbox.window.SkywardScramble;
const C = G.constants;
const DT = C.FIXED_DT;

function horizontalOverlap(x, tile) {
    return x + C.PLAYER_W / 2 > tile.x - C.TILE_W / 2 &&
        x - C.PLAYER_W / 2 < tile.x + C.TILE_W / 2;
}

let failures = 0;
const rows = [];

for (let run = 0; run < 20; run++) {
    // Deterministic layout: rebuild the level with a seeded generator.
    G.startGame();
    G.buildSeededLevel(Number(SEED) * 1000 + run);

    const tiles = G.platforms;
    let tile = null;
    for (const t of tiles) {
        if (!(t.speed > 0 && 150 < t.x < 650)) { continue; }
        const dropY = t.topY - (C.PLAYER_H + 2);
        let blocked = false;
        for (const o of tiles) {
            if (o === t) { continue; }
            if (!horizontalOverlap(t.x, o)) { continue; }
            if (o.topY - C.PLAYER_H / 2 < dropY + C.PLAYER_H / 2 &&
                o.topY + C.TILE_H > dropY - C.PLAYER_H / 2) { blocked = true; break; }
        }
        if (!blocked) { tile = t; break; }
    }
    if (!tile) { continue; }

    G.player.x = tile.x;
    G.player.y = tile.topY - C.PLAYER_H / 2;
    G.yVelocity = 0;
    G.onGround = false;
    for (let i = 0; i < 20; i++) { G.update(DT); }
    const startX = G.player.x;
    const startTile = tile.x;
    for (let i = 0; i < 30; i++) { G.update(DT); }
    const playerMove = G.player.x - startX;
    const tileMove = tile.x - startTile;
    const ok = Math.abs(playerMove - tileMove) <= 2;
    if (!ok) {
        failures += 1;
        if (failures <= 3) {
            rows.push(`    player ${playerMove.toFixed(2)} tile ${tileMove.toFixed(2)} | ` +
                `tileX ${tile.x.toFixed(1)} top ${tile.topY.toFixed(1)} dir ${tile.direction} ` +
                `playerY ${G.player.y.toFixed(1)} onGround ${G.onGround}`);
        }
    }
}

rows.forEach(r => console.log(r));
console.log(`carry failures in the JS port: ${failures} / 20`);

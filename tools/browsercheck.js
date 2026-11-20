/* Drive the generated index.html in real headless Chrome over CDP.
 *
 * Loads the page from file://, checks for console errors, simulates keyboard
 * input, forces a game over and screenshots the result.
 *
 * Usage: node tools/browsercheck.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9222;
const OUT = path.join(ROOT, 'tools', 'browser_shot.png');

function get(pathname) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function waitFor(fn, tries, delay) {
    for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, delay)); }
    }
    throw new Error('timed out');
}

(async () => {
    const userDir = path.join(process.env.TEMP, 'opencode', 'chrome-profile-' + Date.now());
    console.log('spawning chrome...');
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + userDir,
        '--window-size=900,900',
        'about:blank'
    ], { stdio: 'ignore' });
    chrome.on('error', err => { console.error('chrome spawn error:', err.message); });

    let ws;
    try {
        const targets = await waitFor(() => get('/json/list'), 40, 250);
        console.log('got devtools targets:', targets.length);
        const page = targets.find(t => t.type === 'page');
        const cdp = require('./cdp');
        ws = await cdp.connect(page.webSocketDebuggerUrl);
        console.log('cdp connected');
    } catch (err) {
        chrome.kill();
        throw err;
    }

    let id = 0;
    const pending = new Map();
    const events = [];
    ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        else if (msg.method) { events.push(msg); }
    });
    function send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                pending.delete(mid);
                rej(new Error('CDP timeout: ' + method));
            }, 20000);
            pending.set(mid, msg => { clearTimeout(timer); res(msg); });
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
    }

    const failures = [];
    function check(name, ok, detail) {
        console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) { failures.push(name); }
    }

    await send('Runtime.enable');
    await send('Page.enable');
    // Emulate a touch-capable device so the on-screen pads are laid out.
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await send('Page.navigate', { url: PAGE });
    await new Promise(r => setTimeout(r, 2500));

    const evalJs = async (expr) => {
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (res.result && res.result.exceptionDetails) {
            throw new Error(JSON.stringify(res.result.exceptionDetails));
        }
        return res.result.result.value;
    };

    console.log('Page load');
    const boot = await evalJs(`(() => {
        const g = window.SkywardScramble;
        if (!g) return { ok: false };
        return {
            ok: true,
            state: g.state,
            coins: g.coins.length,
            platforms: g.platforms.length,
            health: g.health,
            score: g.score,
            canvasW: document.getElementById('game').width,
            canvasH: document.getElementById('game').height,
            fontLoaded: document.fonts ? document.fonts.check('16px "PressStart2P"') : null,
            bgImageOk: (() => { const c = document.createElement('canvas'); c.width = 8; c.height = 8;
                const x = c.getContext('2d'); x.drawImage(document.querySelector('canvas'), 0, 0, 8, 8);
                return x.getImageData(0, 0, 8, 8).data.join(','); })()
        };
    })()`);
    check('game booted', boot.ok);
    check('state is playing', boot.state === 'playing', `(${boot.state})`);
    check('3 coins', boot.coins === 3, `(${boot.coins})`);
    check('28 platforms (16 ground + 12 floating)', boot.platforms === 28, `(${boot.platforms})`);
    check('health starts at 100 (may already be hurt by a spike)', boot.health <= 100 && boot.health >= 0,
    `(${boot.health})`);
    check('canvas is 800x600', boot.canvasW === 800 && boot.canvasH === 600,
        `(${boot.canvasW}x${boot.canvasH})`);
    check('Press Start 2P font is loaded', boot.fontLoaded === true, `(${boot.fontLoaded})`);
    check('background image painted', boot.bgImageOk && boot.bgImageOk !== '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0');

    // --- keyboard input -----------------------------------------------------
    console.log('Keyboard input');
    const key = async (type, k, code, keyCode) => {
        await send('Input.dispatchKeyEvent', {
            type, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
        });
    };

    const x0 = await evalJs('window.SkywardScramble.player.x');
    await key('keyDown', 'ArrowRight', 'ArrowRight', 39);
    await new Promise(r => setTimeout(r, 500));
    await key('keyUp', 'ArrowRight', 'ArrowRight', 39);
    const x1 = await evalJs('window.SkywardScramble.player.x');
    check('ArrowRight moves the player right', x1 > x0 + 20, `(${x0.toFixed(1)} -> ${x1.toFixed(1)})`);

    await key('keyDown', 'ArrowLeft', 'ArrowLeft', 37);
    await new Promise(r => setTimeout(r, 500));
    await key('keyUp', 'ArrowLeft', 'ArrowLeft', 37);
    const x2 = await evalJs('window.SkywardScramble.player.x');
    check('ArrowLeft moves the player left', x2 < x1, `(${x1.toFixed(1)} -> ${x2.toFixed(1)})`);

    // jump: make sure the player is standing on something first, because the
// current main.py only allows a jump while on the ground.
    await evalJs('window.SkywardScramble.startGame()');
    await new Promise(r => setTimeout(r, 600));
    const groundState = await evalJs(
        '({ onGround: window.SkywardScramble.onGround, vy: window.SkywardScramble.yVelocity })');
    await key('keyDown', ' ', 'Space', 32);
    await new Promise(r => setTimeout(r, 120));
    const vy1 = await evalJs('window.SkywardScramble.yVelocity');
    await key('keyUp', ' ', 'Space', 32);
    check('Space makes the player jump', vy1 < groundState.vy,
        `(onGround ${groundState.onGround}, ${groundState.vy.toFixed(1)} -> ${vy1.toFixed(1)})`);

    // arrow keys must not scroll the page
    const scrollBefore = await evalJs('window.scrollY');
    await key('keyDown', 'ArrowDown', 'ArrowDown', 40);
    await new Promise(r => setTimeout(r, 200));
    await key('keyUp', 'ArrowDown', 'ArrowDown', 40);
    const scrollAfter = await evalJs('window.scrollY');
    check('arrow keys do not scroll the page', scrollBefore === scrollAfter,
        `(${scrollBefore} -> ${scrollAfter})`);

    // --- localStorage high score -------------------------------------------
    console.log('High score');
    const best = await evalJs(`(() => {
        const g = window.SkywardScramble;
        g.startGame();
        g.score = 12;
        g.health = 1;
        const spike = g.spikes[0];
        g.player.x = spike.tile.x;
        g.player.y = spike.tile.topY - 40;
        g.yVelocity = 0; g.onGround = true; g.hurtTimer = 0;
        g.update(1/60);
        return { stored: window.localStorage.getItem('skyward_scramble_best'),
                 best: g.bestScore, state: g.state };
    })()`);
    check('game over recorded a new best', best.state === 'gameover' && best.best > 0,
        `(best ${best.best}, state ${best.state})`);
    check('best score written to localStorage', best.stored !== null && Number(best.stored) > 0,
        `(${best.stored})`);
    const outside = await evalJs("document.getElementById('best-outside').textContent");
    check('best score shown outside the canvas', Number(outside) > 0, `(${outside})`);

    // --- force a game over --------------------------------------------------
    console.log('Game over panel');
    await evalJs(`(() => {
        const g = window.SkywardScramble;
        g.startGame();
        g.score = 9; g.health = 1;
        const spike = g.spikes[0];
        g.player.x = spike.tile.x;
        g.player.y = spike.tile.topY - 40;
        g.yVelocity = 0; g.onGround = true; g.hurtTimer = 0;
        g.update(1/60);
        return g.state;
    })()`);
    const state = await evalJs('window.SkywardScramble.state');
    check('game over triggered', state === 'gameover', `(${state})`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log('  screenshot -> ' + OUT);

    // retry after the delay
    await new Promise(r => setTimeout(r, 700));
    await key('keyDown', ' ', 'Space', 32);
    await new Promise(r => setTimeout(r, 200));
    await key('keyUp', ' ', 'Space', 32);
    const state2 = await evalJs('window.SkywardScramble.state');
    check('Space retries the run', state2 === 'playing', `(${state2})`);

    // --- touch controls -----------------------------------------------------
    console.log('Touch controls');
    const touchCheck = await evalJs(`(() => {
        const g = window.SkywardScramble;
        const left = document.getElementById('pad-left');
        const right = document.getElementById('pad-right');
        const jump = document.getElementById('pad-jump');
        return {
            present: !!(left && right && jump),
            leftTag: left ? left.tagName : null,
            jumpTag: jump ? jump.tagName : null
        };
    })()`);
    check('touch pads exist', touchCheck.present,
        `(${touchCheck.leftTag}/${touchCheck.jumpTag})`);

    // Drive the pads with real touch events through CDP.  Scroll them into view
// first: the touch coordinates are viewport relative.
    await evalJs(`document.getElementById('touch-controls').scrollIntoView({block:'center'})`);
    await new Promise(r => setTimeout(r, 300));

    const padBox = await evalJs(`(() => {
        const r = document.getElementById('pad-right').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                 visible: r.width > 0 && r.height > 0 };
    })()`);
    check('touch pads are laid out', padBox.visible, `(${JSON.stringify(padBox)})`);

    await evalJs('window.SkywardScramble.startGame()');
    await new Promise(r => setTimeout(r, 500));
    const tx0 = await evalJs('window.SkywardScramble.player.x');
    await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: padBox.x, y: padBox.y, radiusX: 12, radiusY: 12, force: 1 }]
    });
    await new Promise(r => setTimeout(r, 400));
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const tx1 = await evalJs('window.SkywardScramble.player.x');
    check('right touch pad moves the player right', tx1 > tx0 + 20,
        `(${tx0.toFixed(1)} -> ${tx1.toFixed(1)})`);

    const jumpBox = await evalJs(`(() => {
        const r = document.getElementById('pad-jump').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    await evalJs('window.SkywardScramble.startGame()');
    await new Promise(r => setTimeout(r, 600));
    const tvy0 = await evalJs('window.SkywardScramble.yVelocity');
    await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: jumpBox.x, y: jumpBox.y, radiusX: 12, radiusY: 12, force: 1 }]
    });
    await new Promise(r => setTimeout(r, 120));
    const tvy = await evalJs('window.SkywardScramble.yVelocity');
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('jump touch pad makes the player jump', tvy < tvy0,
        `(vy ${tvy0.toFixed(1)} -> ${tvy.toFixed(1)})`);

    // --- console errors -----------------------------------------------------
    console.log('Console');
    const errors = events.filter(e =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    check('no console errors', errors.length === 0,
        errors.length ? JSON.stringify(errors.map(e => e.params)).slice(0, 400) : '');

    ws.close();
    chrome.kill();

    console.log();
    if (failures.length) {
        console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
        process.exit(1);
    }
    console.log('All browser checks passed.');
})().catch(err => {
    console.error('browsercheck failed:', err);
    process.exit(1);
});

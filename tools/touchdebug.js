/* Debug the on-screen touch pads in real Chrome. */
const cdp = require('./cdp');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 9337;
const PAGE = 'file:///' + path.join(path.dirname(__dirname), 'index.html').replace(/\\/g, '/');

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP, 'opencode', 'tp-' + Date.now()),
    '--window-size=1000,1000',
    'about:blank'
], { stdio: 'ignore' });

function get(p) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
    });
}

(async () => {
    let t;
    for (let i = 0; i < 40; i++) {
        try { t = await get('/json/list'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); }
    }
    const page = t.find(x => x.type === 'page');
    const ws = await cdp.connect(page.webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    const send = (method, params) => new Promise(r => {
        const i = ++id; pend.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });

    await send('Page.enable');
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await send('Page.navigate', { url: PAGE });
    await new Promise(r => setTimeout(r, 2000));

    // install event spies
    await send('Runtime.evaluate', {
        expression: `(() => {
            window.__spy = [];
            const b = document.getElementById('pad-right');
            ['pointerdown','pointerup','touchstart','mousedown','click'].forEach(t =>
                b.addEventListener(t, e => window.__spy.push(t), true));
            window.__padBox = (() => { const r = b.getBoundingClientRect();
                return {x: r.x, y: r.y, w: r.width, h: r.height, vis: getComputedStyle(b).display,
                        tc: getComputedStyle(document.getElementById('touch-controls')).display,
                        bodyH: document.body.scrollHeight, innerH: window.innerHeight,
                        scrollY: window.scrollY}; })();
        })()`,
        returnByValue: true
    });

    const box = await send('Runtime.evaluate', { expression: 'window.__padBox', returnByValue: true });
    console.log('pad box:', JSON.stringify(box.result.result.value));

    const b = box.result.result.value;
    const cx = Math.round(b.x + b.w / 2);
    const cy = Math.round(b.y + b.h / 2);
    console.log('touching at', cx, cy);

    await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: cx, y: cy, radiusX: 12, radiusY: 12, force: 1 }]
    });
    await new Promise(r => setTimeout(r, 300));
    const mid = await send('Runtime.evaluate', {
        expression: '({ spy: window.__spy.slice(), touch: JSON.stringify(window.SkywardScramble.touch), x: window.SkywardScramble.player.x })',
        returnByValue: true
    });
    console.log('after touchStart:', JSON.stringify(mid.result.result.value));

    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(r => setTimeout(r, 200));
    const end = await send('Runtime.evaluate', {
        expression: '({ spy: window.__spy.slice(), touch: JSON.stringify(window.SkywardScramble.touch) })',
        returnByValue: true
    });
    console.log('after touchEnd:', JSON.stringify(end.result.result.value));

    // now try a plain mouse click on the button
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 300));
    const mouse = await send('Runtime.evaluate', {
        expression: '({ spy: window.__spy.slice(), touch: JSON.stringify(window.SkywardScramble.touch) })',
        returnByValue: true
    });
    console.log('after mousePressed:', JSON.stringify(mouse.result.result.value));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });

    ws.close(); chrome.kill();
})().catch(e => { console.error('ERR', e && e.message); chrome.kill(); process.exit(1); });

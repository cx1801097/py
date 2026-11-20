/* Probe localStorage behaviour on a file:// origin in Chrome. */
const cdp = require('./cdp');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 9336;
const PAGE = 'file:///' + path.join(path.dirname(__dirname), 'index.html').replace(/\\/g, '/');

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP, 'opencode', 'ls-' + Date.now()),
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

    await send('Page.navigate', { url: PAGE });
    await new Promise(r => setTimeout(r, 2000));

    const expr = `(() => {
        const out = {};
        out.origin = location.origin;
        out.href = location.href;
        try {
            out.getItem = localStorage.getItem('skyward_scramble_best');
            localStorage.setItem('skyward_scramble_best', '42');
            out.afterSet = localStorage.getItem('skyward_scramble_best');
            out.length = localStorage.length;
            out.keys = Object.keys(localStorage);
        } catch (e) {
            out.error = e.name + ': ' + e.message;
        }
        return out;
    })()`;
    const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log('localStorage probe:', JSON.stringify(ev.result.result.value, null, 2));

    ws.close(); chrome.kill();
})().catch(e => { console.error('ERR', e && e.message); chrome.kill(); process.exit(1); });

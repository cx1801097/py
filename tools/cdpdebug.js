/* Small CDP smoke test: navigate to index.html from file:// and read state. */
const cdp = require('./cdp');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 9335;
const PAGE = 'file:///' + path.join(path.dirname(__dirname), 'index.html').replace(/\\/g, '/');

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP, 'opencode', 'cp4-' + Date.now()),
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
        else console.log('EVT', m.method);
    });
    const send = (method, params) => new Promise(r => {
        const i = ++id; pend.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });

    console.log('enable runtime'); await send('Runtime.enable');
    console.log('enable page'); await send('Page.enable');
    console.log('navigate');
    const nav = await send('Page.navigate', { url: PAGE });
    console.log('nav result:', JSON.stringify(nav.result || nav.error).slice(0, 300));
    await new Promise(r => setTimeout(r, 2500));

    const expr = '(() => { const g = window.SkywardScramble; ' +
        'return g ? { state: g.state, coins: g.coins.length, plat: g.platforms.length, ' +
        'font: document.fonts.check("16px \\"PressStart2P\\"") } : "NO GAME"; })()';
    const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log('eval:', JSON.stringify(ev.result).slice(0, 500));

    ws.close(); chrome.kill();
})().catch(e => { console.error('ERR', e && e.message); chrome.kill(); process.exit(1); });

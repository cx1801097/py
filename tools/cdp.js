/* Minimal dependency-free WebSocket client for the Chrome DevTools Protocol.
 *
 * Only what CDP needs: a text-frame client with no extensions, no masking on
 * receive, masked sends.  Good enough for local automation.
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const EventEmitter = require('events');

function connect(url) {
    const target = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13'
            }
        });

        req.on('upgrade', (res, socket) => {
            if (res.headers['sec-websocket-accept'] !== expected) {
                socket.destroy();
                reject(new Error('bad websocket handshake'));
                return;
            }
            resolve(new WsClient(socket));
        });
        req.on('error', reject);
        req.end();
    });
}

class WsClient extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.closed = false;

        socket.on('data', chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this._drain();
        });
        socket.on('close', () => { this.closed = true; this.emit('close'); });
        socket.on('error', err => this.emit('error', err));
    }

    _drain() {
        for (;;) {
            if (this.buffer.length < 2) { return; }
            const b0 = this.buffer[0];
            const b1 = this.buffer[1];
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let length = b1 & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (this.buffer.length < offset + 2) { return; }
                length = this.buffer.readUInt16BE(offset);
                offset += 2;
            } else if (length === 127) {
                if (this.buffer.length < offset + 8) { return; }
                length = Number(this.buffer.readBigUInt64BE(offset));
                offset += 8;
            }

            let maskKey = null;
            if (masked) {
                if (this.buffer.length < offset + 4) { return; }
                maskKey = this.buffer.subarray(offset, offset + 4);
                offset += 4;
            }

            if (this.buffer.length < offset + length) { return; }
            let payload = this.buffer.subarray(offset, offset + length);
            if (maskKey) {
                const out = Buffer.allocUnsafe(length);
                for (let i = 0; i < length; i++) { out[i] = payload[i] ^ maskKey[i & 3]; }
                payload = out;
            }
            this.buffer = this.buffer.subarray(offset + length);

            if (opcode === 0x1) { this.emit('message', payload.toString('utf8')); }
            else if (opcode === 0x8) { this.close(); return; }
            else if (opcode === 0x9) { this._frame(0xa, payload); }
        }
    }

    _frame(opcode, payload) {
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
        const mask = crypto.randomBytes(4);
        let header;

        if (data.length < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | data.length;
        } else if (data.length < 65536) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(data.length, 2);
        } else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(data.length), 2);
        }
        header[0] = 0x80 | opcode;

        const masked = Buffer.allocUnsafe(data.length);
        for (let i = 0; i < data.length; i++) { masked[i] = data[i] ^ mask[i & 3]; }

        this.socket.write(Buffer.concat([header, mask, masked]));
    }

    send(text) {
        if (this.closed) { return; }
        this._frame(0x1, Buffer.from(text, 'utf8'));
    }

    close() {
        if (this.closed) { return; }
        this.closed = true;
        try { this._frame(0x8, Buffer.alloc(0)); } catch (err) { /* ignore */ }
        this.socket.end();
    }
}

module.exports = { connect };

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 18081);
const TOKEN = String(process.env.TOKEN || 'napcat_ws_token');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: PORT, token: TOKEN }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('napcat probe alive');
});

server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const auth = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const token = String(
      url.searchParams.get('access_token') ||
      req.headers['x-self-token'] ||
      req.headers['x-access-token'] ||
      req.headers['access_token'] ||
      auth ||
      ''
    ).trim();

    if (token !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      console.log('[probe] reject token=', token || '(empty)');
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    console.log('[probe] ws connected from', req.socket.remoteAddress, 'ua=', req.headers['user-agent'] || '');

    socket.on('data', (buf) => {
      if (!buf || !buf.length) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x9) {
        const payloadLen = buf[1] & 0x7f;
        const payload = buf.subarray(2, 2 + payloadLen);
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        socket.write(pong);
        return;
      }
      if (opcode === 0x8) {
        try { socket.end(); } catch {}
        return;
      }
      console.log('[probe] frame bytes=', buf.length);
    });

    socket.on('close', () => console.log('[probe] ws closed'));
    socket.on('error', (e) => console.log('[probe] ws error', e.message));
  } catch (e) {
    try { socket.destroy(); } catch {}
    console.log('[probe] upgrade error', e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[probe] listening on 0.0.0.0:${PORT}`);
  console.log(`[probe] ws url: ws://<server-ip>:${PORT}/ws?access_token=${TOKEN}`);
});

const crypto = require('crypto');
const { state, runtime } = require('./state');
const { nowSec } = require('./utils');
const { checkAccess } = require('./access');
const { broadcast } = require('./request');
const { decodeFrames } = require('./websocket');

function createUpgradeHandler() {
  return (req, socket) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const pathname = urlObj.pathname;
      const access = checkAccess(req, pathname, true);
      if (!access.ok) {
        socket.write(`HTTP/1.1 ${access.code || 403} Forbidden\r\n\r\n`);
        socket.destroy();
        return;
      }

      if (pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const auth = req.headers['authorization'] || '';
      const bearer = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
      const token =
        urlObj.searchParams.get('access_token') ||
        req.headers['x-self-token'] ||
        req.headers['access_token'] ||
        bearer ||
        '';
      if (String(token) !== String(state.wsToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      if (runtime.napcatSocket && runtime.napcatSocket !== socket) {
        try { runtime.napcatSocket.destroy(); } catch {}
      }

      runtime.napcatSocket = socket;
      runtime.napcatInfo = { connected: true, since: nowSec(), selfId: runtime.napcatInfo.selfId || '', name: runtime.napcatInfo.name || '' };
      broadcast({ type: 'system', text: 'napcat_connected' });

      socket.on('data', (chunk) => decodeFrames(socket, chunk));
      socket.on('close', () => {
        if (runtime.napcatSocket === socket) runtime.napcatSocket = null;
        runtime.napcatInfo.connected = false;
        for (const [k, p] of runtime.pendingRpc.entries()) {
          runtime.pendingRpc.delete(k);
          p.reject(new Error('NapCat WS 已断开'));
        }
        broadcast({ type: 'system', text: 'napcat_disconnected' });
      });
      socket.on('error', () => {});
    } catch {
      socket.destroy();
    }
  };
}

module.exports = { createUpgradeHandler };

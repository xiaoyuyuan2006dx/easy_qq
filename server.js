const http = require('http');
const https = require('https');
const config = require('./server/config');
const { state, runtime, saveState } = require('./server/state');
const { createRequestHandler } = require('./server/routes');
const { createUpgradeHandler } = require('./server/upgrade');
const { loadOrGenerateCert, HTTPS_PORT } = require('./server/cert');

const requestHandler = createRequestHandler();
const upgradeHandler = createUpgradeHandler();

// HTTP server
const httpServer = http.createServer(requestHandler);
httpServer.on('upgrade', upgradeHandler);

httpServer.listen(config.PORT, '0.0.0.0', () => {
  console.log(`[http] easy_qq running at http://0.0.0.0:${config.PORT}`);
  console.log(`[http] local access: http://127.0.0.1:${config.PORT}`);
  console.log(`[http] reverse ws endpoint: ws://127.0.0.1:${config.PORT}/ws?access_token=${state.wsToken}`);
  if (state.accessToken === 'easyqq') {
    console.log(`[!] 访问密码为默认值: easyqq  —— 请登录后在设置中修改`);
    console.log(`[!] 忘记密码？编辑 data/store.json 将 accessToken 改为 "easyqq" 即可恢复默认密码`);
  } else {
    console.log(`[OK] 访问密码已自定义设置`);
  }
});

// HTTPS server (self-signed, for FSA support)
let httpsServer;
if (HTTPS_PORT > 0) {
  const certInfo = loadOrGenerateCert();
  if (certInfo) {
    httpsServer = https.createServer({ cert: certInfo.cert, key: certInfo.key }, requestHandler);
    httpsServer.on('upgrade', upgradeHandler);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[https] easy_qq running at https://0.0.0.0:${HTTPS_PORT}`);
    });
  } else {
    console.log('[https] HTTPS disabled (set HTTPS_PORT=0 to suppress this message)');
  }
}

// Graceful shutdown — avoids Docker waiting the full 10s stop timeout
function gracefulShutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down gracefully...`);
  httpServer.close(() => console.log('[server] HTTP closed'));
  if (httpsServer) httpsServer.close(() => console.log('[server] HTTPS closed'));
  if (runtime.napcatSocket) { try { runtime.napcatSocket.destroy(); } catch {} }
  try { saveState(); console.log('[server] State saved'); } catch(e) {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

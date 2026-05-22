const http = require('http');
const config = require('./server/config');
const { state } = require('./server/state');
const { createRequestHandler } = require('./server/routes');
const { createUpgradeHandler } = require('./server/upgrade');

const server = http.createServer(createRequestHandler());
server.on('upgrade', createUpgradeHandler());

server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`easy_qq running at http://0.0.0.0:${config.PORT}`);
  console.log(`fixed local access: http://127.0.0.1:${config.PORT}`);
  console.log(`reverse ws endpoint: ws://127.0.0.1:${config.PORT}/ws?access_token=${state.wsToken}`);
  if (state.accessToken === 'easyqq') {
    console.log(`[!] 访问密码为默认值: easyqq  —— 请登录后在设置中修改`);
    console.log(`[!] 忘记密码？编辑 data/store.json 将 accessToken 改为 "easyqq" 即可恢复默认密码`);
  } else {
    console.log(`[OK] 访问密码已自定义设置`);
  }
});

# easy\_qq（NapCat 反向 WS 接入）

`easy_qq` 是一个 OneBot11 反向 WebSocket 服务端：
- NapCat 主动连到本服务的 `/ws`
- 浏览器打开本服务页面进行会话管理、收发消息、日志查看
>[!note]
>需要先部署NapCat
---

## 1. 环境与启动

### 1.1 安装依赖

```bash
cd /Users/你的用户名/easy_qq
npm install
```

### 1.2 启动服务

```bash
npm start
```

启动后：
- 页面地址：`http://127.0.0.1:18080`
- NapCat 反向 WS 地址：`ws://<你的IP>:18080/ws?access_token=<你的ws_token>`

> 页面会显示自动识别到的本机 IP，可直接复制给 NapCat 使用。

---

## 2. 两种 token 的区别（非常重要）

`easy_qq` 里有两个不同用途的 token：

1. **ws\_token（给 NapCat 反向 WS 用）**
   2. 用在 NapCat 的 websocket client 连接参数里
   3. 用于校验 NapCat 到 `/ws` 的连接
   4. 形如：`ws://IP:18080/ws?access_token=你的ws_token`

2. **访问 token（给浏览器页面用）**
   2. 用于网页端登录校验（不是 NapCat WS 校验）
   3. 非 `127.0.0.1` / 非本机 IP 访问时需要输入
   4. 仅本机访问可管理/修改该 token

---

## 3. NapCat 配置（反向 WS）

在 NapCat 的 `onebot11_<qq号>.json` 中配置 `websocketClients`（或对应客户端项）：

```json
{
  "enable": true,
  "name": "easy_qq",
  "url": "ws://<你的IP>:18080/ws?access_token=<你的ws_token>",
  "reportSelfMessage": false,
  "messagePostFormat": "array",
  "token": "",
  "debug": false,
  "heartInterval": 30000,
  "reconnectInterval": 3000
}
```

建议：
- `messagePostFormat` 使用 `array`
- 若你已经把 `ws_token` 放到 `url` 查询参数，`token` 字段可留空（避免双重不一致）
- `url` 不要写 `localhost`（NapCat 不在同一网络命名空间时会失败）

配置完后重启 NapCat，或者查看日志中有相关信息说明成功开启服务。

---

## 4. 连接自检流程（推荐按顺序）

1. 启动 `easy_qq`：`npm start`
2. 浏览器打开：`http://127.0.0.1:18080`
3. 在页面确认：
   4. 自动识别本机 IP
   5. NapCat ws 客户端地址提示正确
4. 启动/重启 NapCat
5. 在页面日志中确认已出现 WS 连接成功、消息事件

---

## 5. 多端登录（同一服务）

目标：手机/另一台电脑也能打开同一个 `easy_qq` 页面。
> [!note]
> 手机的访问页面仅保留少量功能

### 5.1 访问地址

局域网设备使用：

```text
http://<服务机器局域网IP>:18080
```

例如：`http://192.168.1.100:3001`

### 5.2 登录规则

- 地址里带 `?access_token=xxx`：页面会自动尝试校验
- 地址里不带 token：进入后手动输入
- `127.0.0.1` 访问默认不强制校验

### 5.3 多端一致性

- 会话、消息、配置保存在服务端（`data/store.json`）
- 不同设备登录同一个服务地址，看到的是同一份数据

---

## 6. 常见网络拓扑与配置建议

### 场景 A：NapCat 和 easy\_qq 在同一台机器

- NapCat `url` 直接填：`ws://<本机IP>:18080/ws?access_token=<ws_token>`
- 浏览器本机访问：`http://127.0.0.1:18080`

### 场景 B：NapCat 在 Windows（含 Docker），easy\_qq 在 WSL

常见可行方案：

1. 在 WSL 启动 easy\_qq（监听 `0.0.0.0:18080`）
2. Windows 做 `18080` 端口转发到 WSL `18080`
3. Windows 防火墙放行 `18080`
4. NapCat（Docker）用 `host.docker.internal:18080` 或 Windows 局域网地址访问

> 若网页能在另一台设备打开，但 NapCat 连不上，优先排查端口转发与防火墙。

---

## 7. 功能说明

- 会话管理（手动选择显示哪些私聊/群聊）
- 手动拉取消息、自动推送消息
- 发送文本、图片、文件
- 日志查看与导出
- 个性化设置（背景、自己的消息气泡颜色）
- 移动端简化页面（会话切换 + 最近消息 + 文本/文件发送）

---

## 8. 常见问题排查

### 8.1 浏览器 401

- 先确认访问 token 是否正确
- 本机访问优先用 `127.0.0.1:18080`
- 局域网访问要用服务机器真实 IP

### 8.2 NapCat 连不上 WS

- `url` 是否为：`ws://IP:18080/ws?access_token=ws_token`
- `token`项可以不填写 
- 服务是否已启动且监听正常
- 防火墙/端口转发是否放行

### 8.3 两台设备页面显示不一致

- 是否连接到同一个 `easy_qq` 服务地址
- 是否命中不同浏览器缓存（可强制刷新）
- 是否误连到不同机器/不同端口

---

## 9. 数据与目录

- 前端静态资源：`public/`
- 服务端入口：`server.js`
- 持久化数据：`data/store.json`



# easy_qq — NapCat 反向 WebSocket 管理面板

Web 端管理 QQ 机器人：收发消息、群文件管理、多端同步、访问控制。

NapCat（OneBot11）主动连接 `/ws`，浏览器打开面板进行操作。

> 需要先部署 [NapCat](https://napneko.github.io/)

---

## 1. 快速开始

### 1.1 Node.js 直接启动

```bash
git clone <repo> && cd easy_qq
npm install
npm start
```

- 面板地址：`http://127.0.0.1:18080`
- NapCat 反向 WS：`ws://<你的IP>:18080/ws?access_token=<你的ws_token>`

### 1.2 Docker 部署（推荐）

```bash
docker run -d \
  --name easyqq \
  -p 18080:18080 \
  -v ./easyqq/data:/app/data \
  tarodeluxe2006/easy_qq:latest
```

或使用 docker-compose：

```yaml
easyqq:
  image: tarodeluxe2006/easy_qq:latest
  container_name: easyqq
  restart: always
  ports:
    - 18080:18080
  volumes:
    - ./easyqq/data:/app/data
```

---

## 2. NapCat 配置

NapCat 的 `onebot11_<QQ号>.json` 中配置 websocketClients：

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

- `token` 字段留空即可（token 已包含在 URL 参数中）
- `messagePostFormat` 建议 `array`
- `url` 不要用 `localhost`（容器网络下不可达）

---

## 3. 鉴权体系

### 3.1 两种 Token

| 用途 | 说明 |
|------|------|
| **ws_token** | NapCat 连接 `/ws` 时使用，在设备管理页设置 |
| **访问密码** | 网页登录验证，默认 `easyqq`，首次登录强制修改 |

### 3.2 登录规则

- 默认密码 `easyqq`，登录后弹出改密窗口，必须设置新密码
- 连续 3 次输错显示找回指引（SSH 编辑 `data/store.json` 将 `accessToken` 改为 `easyqq`）
- `127.0.0.1` 本机访问免密校验

---

## 4. 功能详解

### 4.1 消息控制台

- **会话管理**：搜索好友/群、勾选显示，左侧栏只展示选中的会话
- **消息窗口**：选择会话后拉取历史消息（可指定数量），支持实时推送开关
- **发送消息**：文本、图片、文件，支持 @提及、回复指定消息、Ctrl+Enter 快捷发送
- **白名单**：只接收白名单会话的推送，过滤无关消息

### 4.2 文件管理

双栏布局，左侧为本机文件，右侧为群文件。

**左侧 — 本机文件** 两种模式：
- **容器存储**：浏览/管理服务器 `data/local_files/` 目录
- **本机电脑**：通过 File System Access API（需 HTTPS 或 localhost）直接读写本地文件夹；未满足安全上下文时使用 webkitdirectory 只读模式

**右侧 — 群文件**：
- 选择群聊，浏览群文件目录（支持子文件夹）
- 下载选中文件到本机
- 复制并移动到左侧（服务端直传，不经过浏览器，大文件无忧）
- 上传本地文件到群
- 删除、重命名、移动群文件（需群主/管理员权限）

### 4.3 设备管理

- 设置/修改 ws_token（NapCat 连接用）
- 设置/修改访问密码
- 设备监控：记录最近访问设备的 IP、User-Agent、最后访问时间

### 4.4 个性化设置

- **背景图片**：URL 或本地上传，支持透明度和位置调节
- **消息气泡**：自己气泡颜色自定义，他人气泡配色从 12 组预设中选
- 实时预览，统一保存

### 4.5 日志

- 按级别过滤（debug/info/warn/error/system）
- 导出为文本文件

---

## 5. 反向代理 & HTTPS（获取 FSA 完整写入能力）

浏览器 File System Access API 需要安全上下文（HTTPS 或 localhost）。推荐用 Caddy 反代：

```caddy
easyqq.example.com {
    reverse_proxy easyqq:18080
}
```

Caddy 自动申请 Let's Encrypt 证书。内网环境用 `tls internal` 自签证书：

```caddy
easyqq.tarobot:443 {
    tls internal
    reverse_proxy easyqq:18080
}
```

无需在 easy_qq 侧做任何 HTTPS 配置。

---

## 6. 网络拓扑

### 场景 A：全部同一台机器

- easy_qq 监听 `0.0.0.0:18080`
- NapCat `url` 填 `ws://127.0.0.1:18080/ws?access_token=xxx`
- 浏览器访问 `http://127.0.0.1:18080`（FSA 可用）

### 场景 B：NapCat 和 easy_qq 分离

- NapCat 所在机器需能访问 easy_qq 的 IP:18080
- 注意防火墙和端口转发

### 场景 C：手机/其他设备访问

- 局域网内访问 `http://<IP>:18080` 或反代域名
- 手机端界面自动简化

---

## 7. 数据目录

```
data/
├── store.json       # 持久化状态（token、会话、设置）
├── uploads/         # 上传文件（群文件转发缓存）
├── exports/         # 日志导出
└── local_files/     # 容器本地文件存储
    └── default.png  # 默认背景图片（可替换）
```

Docker 部署时将 `data/` 挂载为卷以持久化数据。

---

## 8. 故障排查

### 浏览器 401
- 确认访问密码正确，默认 `easyqq`
- 本机访问用 `127.0.0.1:18080`

### NapCat 连不上 WS
- `url` 格式：`ws://IP:18080/ws?access_token=ws_token`
- ws_token 是否一致（设备管理页可查看/修改）
- 防火墙是否放行 18080

### 文件复制失败
- `Load failed`：QQ 文件链接失效，重试或刷新群文件列表后重试
- 大文件建议用容器存储模式（服务端直传，不经过浏览器）

### FSA / 本机目录写入不可用
- 确认使用 `localhost` 或 HTTPS 访问
- Safari 不支持 FSA，仅可读取目录

### 忘记密码
- SSH 登录服务器：编辑 `data/store.json`，将 `accessToken` 改为 `"easyqq"`
- 重启服务后使用默认密码登录并设置新密码

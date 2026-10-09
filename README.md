# Echo

面向小型游戏小队的自托管 Web 聊天/语音应用。当前 Web 原型可直接从 `index.html` 打开，不依赖 CDN 或构建步骤。

## 当前 Web 原型

- 三栏布局：服务器切换、文字/语音频道、聊天时间线和成员列表；窄屏会自动收起成员侧栏。
- 统一 SVG 图标系统；导航、频道、消息操作和语音状态都使用图标。
- 多服务器和频道 mock 数据；切换频道查看各自消息。
- 消息发送、Enter 发送/Shift+Enter 换行、搜索、回复、emoji 反应、置顶消息面板和成员资料提示。
- file:// 原型使用语音演示状态；Docker Web 版本接入 LiveKit 实时语音。
- Docker Web 版本使用 LiveKit 实时语音，支持麦克风/扬声器选择、实时输入电平和本地输出测试音。
- `window.EchoApi` mock adapter 提供异步接口；消息与频道保存在 `localStorage`，刷新后保留。清除 `echo.mock.v1` 可恢复初始样例。

消息、频道和成员数据定义在 `src/mock-data.js`，mock adapter 位于 `src/mock-api.js`，UI 逻辑位于 `src/app.js`。界面不直接读取 fixture。接口草案见 [docs/api-contract.md](docs/api-contract.md)。

## 本地查看

直接双击 `index.html`，或从项目目录运行任意静态文件服务器。页面不需要 Node.js，也不需要安装 npm 包。

## Docker 本地完整栈

本机 Docker Desktop 与 NAS 使用同一份 Compose。启动前复制 `.env.example` 为 `.env`，修改本地数据库密码和 LiveKit secret，然后运行：

```powershell
docker compose up -d --build
```

浏览器打开 `http://localhost:8080`。栈包括 Web/Nginx、Node API、PostgreSQL、Redis、LiveKit；Web 消息和频道会写入数据库并由 WebSocket 推送，语音使用 LiveKit/WebRTC。点击左下角齿轮打开语音设置：先运行麦克风测试并查看输入电平，再选输出设备并播放测试音。外网访问时需使用 HTTPS，浏览器才会提供媒体设备权限和设备列表。`docker compose logs -f` 查看日志，`docker compose down` 停止；持久化数据保存在 Compose volumes。清空数据库需显式删除 `postgres-data` volume。

Cloudflare Tunnel 默认不启动。验证外网 Web 访问后，可把 Tunnel 配置为指向 `http://web:8080` 并用 `docker compose --profile public up -d` 启动。实时语音媒体需要公网可达的 UDP 7882；Cloudflare Tunnel 的普通 HTTP 代理不会转发该 UDP 媒体流量，因此需在路由器将 UDP 7882 转发到 NAS 并验证 NAT/防火墙。当前 API 是无登录的单人本地开发版本，固定使用 `user-lin`；不要直接暴露到公网供他人使用，公网阶段必须先完成身份认证、授权和邀请机制。

## Mock API 与后端契约

直接打开 `index.html` 时使用 `src/mock-api.js` 和浏览器 localStorage；通过 Docker 的 HTTP 页面时自动切换到 `src/http-api.js`。两个 adapter 共享 `window.EchoApi` 方法。HTTP API 和 WebSocket 路由见 `docs/api-contract.md`。LiveKit 客户端在容器构建时打包为 `voice.js`，file:// 模式不加载 SDK。

## 后续

1. 加入邀请制认证、权限检查和会话管理，再配置公网域名。
2. 完善语音设备选择、网络重连、参与者状态与跨网络 NAT 验证。
3. 稳定 Web 后，以这套 API 契约实现 Windows 壳和 Android 客户端。

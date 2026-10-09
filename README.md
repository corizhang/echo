# Echo

面向小型游戏小队的自托管 Web 聊天/语音应用。当前 Web 原型可直接从 `index.html` 打开，不依赖 CDN 或构建步骤。

## 当前 Web 原型

- 三栏布局：小队导航、聊天/房间内容区和成员列表；窄屏会自动调整成员侧栏。
- 统一 SVG 图标系统；导航、频道、消息操作和语音状态都使用图标。
- 单小队三栏布局：移除服务器切换栏；公共聊天、语音大厅和开黑房间共用左侧导航。
- 消息发送、Enter 发送/Shift+Enter 换行、搜索、回复、emoji 反应、置顶消息面板和成员资料提示。
- file:// 原型使用语音演示状态；Docker Web 版本接入 LiveKit 实时语音。
- Docker Web 版本使用 LiveKit 实时语音，支持麦克风/扬声器选择、实时输入电平和本地输出测试音。
- `window.EchoApi` mock adapter 提供异步接口；消息与频道保存在 `localStorage`，刷新后保留。清除 `echo.mock.v1` 可恢复初始样例。
- Warcraft III 1.24e 房间有独立页面：小队房间列表、加入前预览、成员、持久化房间聊天、邀请和语音控制。移除手动准备状态；启动游戏仍需后续 Windows 客户端。
- 查看房间不会加入或切换语音；可以仅加入房间，或加入并连接语音。切换现有通话会提示。
- 从已连接的语音大厅发起开黑可沿用通话。离开与结束房间分开；房主离开会转交给其他成员，最后一人离开则结束房间。

消息、频道和成员数据定义在 `src/mock-data.js`，mock adapter 位于 `src/mock-api.js`，UI 逻辑位于 `src/app.js`。界面不直接读取 fixture。接口草案见 [docs/api-contract.md](docs/api-contract.md)。

## 本地查看

直接双击 `index.html`，或从项目目录运行任意静态文件服务器。页面不需要 Node.js，也不需要安装 npm 包。

## Docker 本地完整栈

本机 Docker Desktop 与 NAS 使用同一份 Compose。启动前复制 `.env.example` 为 `.env`，修改本地数据库密码和 LiveKit secret，然后运行：

```powershell
docker compose up -d --build
```

浏览器打开 `http://localhost:8080`。栈包括 Web/Nginx、Node API、PostgreSQL、Redis、LiveKit；Web 消息和频道会写入数据库并由 WebSocket 推送，语音使用 LiveKit/WebRTC。点击左下角齿轮打开语音设置：先运行麦克风测试并查看输入电平，再选输出设备并播放测试音。外网访问时需使用 HTTPS，浏览器才会提供媒体设备权限和设备列表。`docker compose logs -f` 查看日志，`docker compose down` 停止；持久化数据保存在 Compose volumes。清空数据库需显式删除 `postgres-data` volume。

Cloudflare Tunnel 默认不启动。实时语音媒体需要 LiveKit 的公网 UDP 媒体端口；普通 HTTP Tunnel 不转发该 UDP 流量。当前开发栈面向本机验证，API 尚无完整用户账号系统，不要直接暴露到公网供他人使用。正式公网部署前需要补账户认证、授权、限流和正确的 LiveKit 公网地址/UDP 配置。

## Mock API 与后端契约

直接打开 `index.html` 时使用 `src/mock-api.js` 和浏览器 localStorage；通过 Docker 的 HTTP 页面时自动切换到 `src/http-api.js`。两个 adapter 共享 `window.EchoApi` 方法。HTTP API 和 WebSocket 路由见 `docs/api-contract.md`。LiveKit 客户端在容器构建时打包为 `voice.js`，file:// 模式不加载 SDK。

## 后续

1. 补邀请制账号认证与房间权限，再迁移到有 UDP 能力的 VPS 并验证公网语音。
2. 为 Windows 实现轻量 Tauri 壳：复用 Web UI，通过 Rust 本机代理检测/启动 1.24e，并验证 LAN 房间发现与转发。
3. 完成跨网络 1.24e 实机联机验证后，再实现 Android 客户端；Android 不依赖本地 Warcraft 启动代理。

## 房间流程检查

本地 Docker 服务启动后执行 `node scripts/check-room-flow.mjs`，检查房间发现、预览、消息权限、重复加入、房主转交、邀请和结束流程。脚本只创建独立临时房间，完成后关闭自己创建的房间；不修改现有房间。房间语音使用现有音频设备配置，真实双人通话与魔兽联机需要实机验证。

目前 `/me` 仍采用本地开发身份；房间昵称统一取当前资料。完整账号认证尚未实现，当前的小队直接加入能力只用于本地开发，不能作为公网访问控制。

## Windows 桌面端
运行 npm run build:desktop 构建本地开发客户端。使用说明与当前限制见 docs/windows-desktop.md。


## 魔兽联机实验

房间已接入局域网发现与双人 TCP 中转的实验入口。使用、部署与当前限制见 [联机说明](docs/warcraft-relay.md)。需要双机实测后才能确认实际对局兼容性。

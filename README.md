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

浏览器打开 `http://localhost:8080`。栈包括 Web/Nginx、Node API、PostgreSQL、Redis、LiveKit；Web 消息和频道会写入数据库并由 WebSocket 推送，语音使用 LiveKit/WebRTC。文字频道支持 PNG、JPEG、GIF、WebP 图片；文件持久化在 `echo-uploads` volume，备份时需和数据库一并备份。点击左下角齿轮打开语音设置：先运行麦克风测试并查看输入电平，再选输出设备并播放测试音。外网访问时需使用 HTTPS，浏览器才会提供媒体设备权限和设备列表。`docker compose logs -f` 查看日志，`docker compose down` 停止；持久化数据保存在 Compose volumes。清空数据库需显式删除 `postgres-data` volume。

## AI 机器人（初始阶段）

系统默认与个人表情库、机器人默认/专属图库的页面管理方法见 [表情库管理指南](docs/sticker-library-management.md)；Echo 与 dafeiyu-bot 的机器人能力对照见 [AI 机器人能力评估](docs/ai-agent-and-expression-assets.md)。

Web 设置中的“AI 机器人”目前支持管理鲸鱼娘、创建机器人、编辑人设和模型、授权文字频道，以及私聊和 `@机器人名称` 群聊。创建机器人后默认不授权任何频道；管理员明确勾选后才会响应。图片理解和联网搜索是可单独授权的内置能力，默认关闭。图片理解开启后只会将当前消息图片和明确回复引用的原消息图片（合计最多 4 张、12 MiB）发送给 DeepSeek Flash，不会扫描频道其他历史图片或私聊图片。要让机器人看之前发的图，在原图片消息上点“回复”，然后在回复里 @ 机器人。联网搜索开启后，模型按需调用 DeepSeek Search，普通闲聊不会搜索；每次成功搜索约 $0.75/1,000 次，回复会附来源链接。搜索词会发送给 DeepSeek。直接通过 `file://` 打开时使用本地 Mock 对话与模拟连接测试；HTTP/Docker 模式才会调用真实 DeepSeek API。

保存真实 API Key 前，必须给 API 容器配置持久的 32 字节加密密钥。PowerShell 可运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成 64 位十六进制字符串，把它写入 `.env` 的 `ECHO_AI_ENCRYPTION_KEY`，然后重建 API：`docker compose up -d --build api`。VPS 也必须设置相同格式的值。请备份此密钥并保持稳定；更换后，之前保存的供应商 Key 将无法解密。机器人设置只会在 TLS 页面上提交一次 API Key，服务端加密后保存，界面/API 不提供读回。

Cloudflare Tunnel 默认不启动。实时语音媒体需要 LiveKit 的公网 UDP 媒体端口；普通 HTTP Tunnel 不转发该 UDP 流量。当前账号系统面向两位好友的封闭测试，尚无管理员账号管理、密码重置和扩展成员能力；公网部署前请配置唯一强密码、正确的 LiveKit 公网地址/UDP 端口和防火墙规则。

## Mock API 与后端契约

直接打开 `index.html` 时使用 `src/mock-api.js` 和浏览器 localStorage；通过 Docker 的 HTTP 页面时自动切换到 `src/http-api.js`。两个 adapter 共享 `window.EchoApi` 方法。HTTP API 和 WebSocket 路由见 `docs/api-contract.md`。LiveKit 客户端在容器构建时打包为 `voice.js`，file:// 模式不加载 SDK。

## 后续

1. 补邀请制账号认证与房间权限，再迁移到有 UDP 能力的 VPS 并验证公网语音。
2. 为 Windows 实现轻量 Tauri 壳：复用 Web UI，通过 Rust 本机代理检测/启动 1.24e，并验证 LAN 房间发现与转发。
3. 完成跨网络 1.24e 实机联机验证后，再实现 Android 客户端；Android 不依赖本地 Warcraft 启动代理。

## 房间流程检查

本地 Docker 服务启动后执行 `node scripts/check-room-flow.mjs`，检查房间发现、预览、消息权限、重复加入、房主转交、邀请和结束流程。脚本只创建独立临时房间，完成后关闭自己创建的房间；不修改现有房间。房间语音使用现有音频设备配置，真实双人通话与魔兽联机需要实机验证。

HTTP 服务现已关闭公开注册，只提供 `lin`、`mori` 两个预置测试账号。首次启动 API 时会从 `.env` 读取两组至少 16 位密码，并写入 scrypt 密码哈希；登录会话有效期 7 天，可在左下角退出。密码保存在被 Git 忽略的 `.env`，本地生成的明文清单保存在被忽略的 `.test-accounts.local.txt`。不要公开这两个文件。直接用 `file://` 打开时仍是无登录的 mock 演示模式。

## Windows 桌面端
运行 npm run build:desktop 构建本地开发客户端。使用说明与当前限制见 docs/windows-desktop.md。


## 魔兽联机实验

房间已接入局域网发现与双人游戏流中转的实验入口。Windows 客户端优先使用 QUIC/UDP，连接阶段失败时回退 WSS/TCP；使用、部署与当前限制见 [联机说明](docs/warcraft-relay.md)。需要双机实测后才能确认实际对局兼容性。

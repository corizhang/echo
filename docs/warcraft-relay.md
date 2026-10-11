# 1.24e 双人联机实验

## 当前实现

- 房间成员用会话令牌申请一次性中转票据（30 秒有效），随后通过 WebSocket 首帧认证，令牌不放入 URL。
- 单个 API 实例维护房间转发，限制一名 Echo 房主和一名加入者，每人一个连接。不支持横向扩容。
- 房主代理每两秒从随机本地 UDP 端口查询 `127.0.0.1:6112` 的 W3GS_SEARCHGAME（冰封王座、主版本 24）。
- 仅接收本机 6112 返回的合法 W3GS_GAMEINFO，检查头、包长、字符串边界、产品、主版本和末尾端口；目标 TCP 端口限制 6112–6119。
- 加入者将 GAMEINFO 的端口改为随机本机 TCP 监听端口，向 `127.0.0.1:6112` 发布。保留房主原始 host counter、entry key、地图和名称。
- 魔兽连接本地代理后，游戏 TCP 字节流通过服务器双向传输。无驱动、无需房主公网 IP 或路由器端口转发。
- Windows 客户端优先尝试 QUIC/UDP 40000，QUIC 适配器将连接桥接到原 API WebSocket 中转，继续使用同一套一次性票据和房间鉴权。连接阶段无法使用 QUIC 时自动回退到 WSS/TCP；已建立的 QUIC 对局断线后不会在游戏中途切换传输。
- 广播六秒过期后发送 W3GS_DECREATEGAME 移除入口；对局开始后即使广播停止，已建立的 TCP 转发继续。
- 转发有消息大小、流数量、速率及积压上限；离开房间、房主变化、连接中断或超时会断开通道。不自动恢复正在进行的对局。

## 网络质量与稳定性

- 联机状态显示房主和加入者各自到 VPS 中转的 RTT、抖动和心跳超时次数。两端 RTT 之和只作为玩家间网络往返的粗略估算，不等于魔兽游戏内 Ping；语音使用 LiveKit/WebRTC，是另一条链路。
- WSS 和 QUIC 都沿用 API 应用层 Ping/Pong 心跳与房间 RTT 采样（JSON 心跳穿过 QUIC 到达真实 Windows 客户端），避免 QUIC 适配器的 WebSocket 自动 Pong 把测量变成仅测 API 到适配器的延迟。界面会显示实际使用的传输方式。
- API 每 30 秒记录最近 5 分钟各连接 RTT 样本的最小值、中位数、P95、最大值，以及心跳超时增量、WebSocket 排队字节数和 Node 事件循环 P95/最大延迟。样本不足 40 个时不报告 P95；日志保留最近 12 个带 Ping ID 的样本便于与客户端记录对照。
- Windows 客户端在联机面板提供最近 5 分钟 RTT 图表与样本统计，并每 30 秒在 `%APPDATA%\app.echo.squad\logs\echo-diagnostics.log` 记录本机 Ping 接收后发送 Pong 的耗时摘要；超过 5 ms 的单次处理会额外记录。
- 联机诊断日志还会记录 `game_advertisement` 的 `hostCounter`、`entryKey`、游戏端口/本地代理端口和广播摘要，用于判断同一个房间是否出现多个游戏标识；`game_tcp` 会记录代理接受、房主连接本机魔兽端口的结果/耗时、读写失败以及关闭方向。不会记录房间票据、聊天内容或游戏数据负载。
- QUIC relay 服务端日志按 15 秒窗口记录客户端与 API 之间的游戏帧数/字节数、控制帧及 QUIC 帧读取错误原因。排查 `connection lost` 时，将两端 `echo-diagnostics.log` 的 `game_tcp`、`relay_transport` 事件与 `docker compose logs --since=10m api game-quic-relay` 中的 peer disconnect 和 QUIC relay session 事件按时间及 roomId 对齐。
- 对照相同 Ping ID：服务端 RTT 尖峰而客户端 Ping/Pong 处理耗时正常，偏向公网路径延迟；服务端事件循环延迟也高，检查 VPS/API 调度；客户端处理耗时高，检查 Windows 客户端调度。客户端计时从收到 Ping 才开始，不能单独测出 Ping 到达客户端前的公网耗时。
- API 日志记录中转连接关闭码、原因、最后测得 RTT 和心跳超时数，可用 `docker compose logs --since=10m api` 查看。
- 游戏 TCP 流断开后目前不能恢复原有魔兽对局；即使重新连接中转，也需要回到游戏内重新建图或加入。

## 使用步骤

1. 两台 Windows 电脑使用相同的 1.24e 冰封王座客户端和地图，启动连接**同一个后端**的新版 Echo。
2. 一人创建 Echo 房间，另一人加入。两人分别点击「开启联机」。实验仅允许两名中转参与者，其他成员仍可聊天。
3. Echo 房主在魔兽的「局域网」中创建地图。另一人打开魔兽「局域网」列表，等待房主的对局出现并加入。
4. 核对角色、广播计数、TCP 状态和双向字节数，再在游戏内开始并持续进行一局。
5. 结束后「断开联机」。语音与联机各自独立。

## 后端地址与部署

默认编译地址是 `http://localhost:8080`，用于当前电脑开发；不能直接把这个构建发给另一台电脑连接同一个后端。

连接同一个部署地址的构建示例（替换为实际地址）：

```powershell
$env:ECHO_SERVER_URL = 'https://echo.example.com'
npm run build:desktop
```

构建脚本将地址同时写入包内前端、原生转发端点和 CSP。服务端已有 `/api/v1/game-relay` WebSocket 反向代理。WSS 仍由 Caddy 代理；QUIC 通过独立的 `40000/UDP` 端口直达 `game-quic-relay` 容器，不经 Caddy。启用 QUIC 时需在 VPS 云安全组和系统防火墙开放 UDP 40000，并给容器只读挂载与客户端域名匹配的 PEM 证书和私钥。默认 Docker Compose 不启动可选 QUIC profile，因此本地开发继续走 WSS。

可在 VPS 项目目录执行一次初始化脚本。它会自动从 Caddy 数据目录寻找该域名当前有效的证书/私钥，将 `.env` 中证书路径设为固定路径，安装每日检查的 systemd timer，并启动 QUIC relay。Caddy systemd 服务默认数据目录通常为 `/var/lib/caddy/.local/share/caddy`；Caddy 负责自动续期，timer 发现证书指纹变化后才复制新证书并重启 QUIC 容器。[Caddy 数据目录说明](https://caddyserver.com/docs/running)

```bash
sudo bash deploy/setup-quic-cert-sync.sh echo.corionline.com ~/echo
sudo ufw allow 40000/udp
```

如果 Caddy 使用了非默认数据目录，把它作为第三个参数传入，例如 `sudo bash deploy/setup-quic-cert-sync.sh echo.corionline.com ~/echo /custom/caddy/data`。云厂商安全组也需要添加 UDP 40000 入站规则。脚本只需安装一次；后续证书续期由 Caddy 自动完成，脚本负责同步并重启 QUIC relay。若玩家网络屏蔽 UDP，客户端会在连接阶段记录 QUIC 失败并回退 WSS；若 UDP 已建立后中途断开，需要重新连接中转并在游戏内重新加入。

现有业务账号仍是开发身份，因此本版本只适合受控实验，公开部署前必须补齐账号认证。未自动部署公网服务或更改 Windows 防火墙。

## 验收边界与排查

本次实现未执行双机游戏或自动化网络测试；编译成功不代表 1.24e 实机联机通过。

- 「中转已连接」仅表示端点通过房间认证。
- 「已发现/发布对局」表示收到了合法主版本 24 的广播，不等于文件补丁已确认为 1.24e。
- 「游戏 TCP 已连接」及字节数表示转发正在发生，不等于游戏加入、地图加载或持续对局成功。
- 只实现房主与一名玩家的通道；三人以上的玩家间地址、连接、掉线投票等尚待协议验证。
- 本机单游戏进程，UDP 查询端口固定 6112。其他端口、自定义补丁、回环广播不被客户端接收、地图传输及开局兼容性均需实机确认。
- 无广播：确认房主已在局域网中建图、使用冰封王座 1.24e，检查本机 6112 和防火墙。
- 有广播但看不到房间：检查加入者的局域网界面、版本一致性和回环消息接收。
- TCP 有流量但不能加入/开局：记录双方状态与游戏提示，继续分析游戏协议，不据字节数宣布联机成功。
- 国外中转的延迟直接影响体验，尚未测量延迟或带宽开销。

## 协议参考

- [WC3LanGame 的发现、重新发布与 TCP 代理说明](https://github.com/Qyperion/WC3LanGame)
- [gowarcraft3 W3GS 协议结构说明](https://pkg.go.dev/github.com/nielsAD/gowarcraft3/protocol/w3gs)

采用协议字段说明独立实现，没有引入上述项目的运行时或复制其源码。

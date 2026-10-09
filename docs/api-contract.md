# Echo API 契约草案（v1）

Web UI 通过 `window.EchoApi` 调用 `src/mock-api.js`，不要在 UI 里直接读取 fixture。Mock 使用与后续 HTTP/WebSocket 服务对应的请求和响应模型；替换时保持此 UI adapter 接口即可。

## HTTP 路由

| 方法 | 路由 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/api/v1/me` | — | `User` |
| `GET` | `/api/v1/servers` | — | `Server[]` |
| `GET` | `/api/v1/servers/{serverId}/channels` | — | `Channel[]` |
| `POST` | `/api/v1/servers/{serverId}/channels` | `{ name, type, topic? }` | `Channel` |
| `GET` | `/api/v1/servers/{serverId}/members` | — | `Member[]` |
| `GET` | `/api/v1/channels/{channelId}/messages` | — | `Message[]` |
| `POST` | `/api/v1/channels/{channelId}/messages` | `{ content, replyTo?: { id } }` | `Message` |
| `PUT` | `/api/v1/messages/{messageId}/reactions/{emoji}` | — | `{ ok: true }` |
| `PUT` | `/api/v1/messages/{messageId}/pin` | — | `{ id, channelId, pinned }` |
| `POST` | `/api/v1/voice/token` | `{ channelId }` | `{ url, token, room, expiresAt }` |
| `POST` | `/api/v1/voice/presence` | `{ channelId, connected }` | `VoicePresence` |
| `POST` | `/api/v1/servers/{serverId}/game-rooms` | `{ title, mapName?, displayName }` | `{ room, sessionToken, inviteCode }`（固定 `gameVersion: "1.24e"`）|
| `GET` | `/api/v1/game-rooms/{roomId}` | `X-Echo-Game-Session` | `{ room, memberId, role }` |
| `POST` | `/api/v1/game-rooms/{roomId}/join` | `{ inviteCode, displayName }` | `{ room, memberId, role, sessionToken }` |
| `PUT` | `/api/v1/game-rooms/{roomId}/status` | `X-Echo-Game-Session`，`{ memberStatus, roomStatus? }` | `{ room, memberId, role }` |
| `POST` | `/api/v1/game-rooms/{roomId}/leave` | `X-Echo-Game-Session` | `{ ok: true }` |
| `POST` | `/api/v1/game-rooms/{roomId}/voice-token` | `X-Echo-Game-Session` | `{ url, token, room, expiresAt }` |

登录后接口使用 `Authorization: Bearer <session-token>`。v1 消息正文是纯文本，客户端必须按文本渲染，不能当作 HTML 插入页面。

房间 session token 只以明文返回创建/加入请求，并仅存浏览器当前 origin 的 `localStorage`；服务端只存 SHA-256 摘要。邀请链接携带 192-bit 随机 capability，七天过期。加入者不获得房主邀请 capability。状态值为 `waiting | in_game | closed`，玩家状态为 `joined | ready | starting | running | left`。此轻量期使用房间会话令牌而非完整账号系统；正式公开部署前必须补账户认证、访问控制、限流和会话撤销。

## Warcraft Windows 桌面代理契约（待实现）

Web 端通过 Tauri command 与本机代理交互，不直接读取本地进程/网卡：`detect_installations`、`launch_game(version, roomId)`、`get_agent_status`、`stop_game_session`。代理只负责定位用户自有的 Warcraft III 1.24e 安装、启动游戏、为房间建立/撤销本机 UDP 6112 LAN 广播代理；控制面仍走上述 HTTPS API，语音仍走 LiveKit。实际 LAN 发现与 NAT 穿透尚未实现或验证，首版不引入内核虚拟网卡驱动。实现时需要独立测试 1.24e 游戏公告包、TCP 游戏流量以及进程启动参数。

## WebSocket 事件

`/api/v1/events`（升级握手时鉴权）。事件 envelope：

```json
{ "type": "message.created", "serverTime": "2026-10-08T12:00:00Z", "data": {} }
```

首批事件类型：`message.created`、`message.updated`、`channel.created`、`game-room.updated`、`voice.participant_joined`、`voice.participant_left`、`presence.updated`。客户端断线后按最后消息 cursor 重新拉取；v1 暂不承诺事件持久投递。

## 数据模型

```ts
type User = { id: string; username: string; displayName: string; status: 'online' | 'idle' | 'offline'; avatar?: string }
type Server = { id: string; name: string; iconUrl?: string; unread?: number }
type Channel = { id: string; serverId: string; name: string; type: 'text' | 'voice'; topic?: string; unread?: number }
type Reaction = { emoji: string; count: number; reacted: boolean }
type Message = { id: string; channelId: string; authorId: string; author: string; createdAt: string; content: string; replyToId?: string | null; pinned: boolean; reactions: Reaction[] }
type Member = User & { activity?: string; voiceChannelId?: string | null }
```

## Mock adapter 方法

`getMe`、`getServers`、`getChannels`、`getMessages`、`getMembers`、`createChannel`、`sendMessage`、`toggleReaction`、`togglePin`、`getVoiceToken`、`setVoicePresence`、`createGameRoom`、`joinGameRoom`、`getGameRoom`、`setGameMemberStatus`、`leaveGameRoom`、`getGameVoiceToken`、`subscribe`。Mock 数据只存于当前浏览器的 `localStorage`，不是服务端数据；mock voice token 也不能连接 LiveKit。


## 单小队房间交互（2026-10-09）

前端只呈现一个小队，保留默认 `serverId` 作为内部数据归属，不删除原频道和历史消息。页面状态（查看哪个房间）、房间成员身份以及语音连接独立管理。查看房间不会连接语音。

新增 adapter：`listGameRooms(serverId)`、`previewGameRoom(roomId, inviteCode?)`、`hasGameSession(roomId)`、`forgetGameSession(roomId)`、`getGameMessages(roomId)`、`sendGameMessage(roomId, content)`、`createGameInvite(roomId)`。HTTP 和 file 模式 mock 共用这些方法；mock 仍仅供本浏览器原型使用。

| 方法 | 路径（前缀 /api/v1） | 行为 |
|---|---|---|
| GET | /servers/:serverId/game-rooms | 返回未结束房间与成员摘要；检查当前开发用户的小队成员关系 |
| POST | /game-rooms/:roomId/preview | 小队成员或持有效邀请者预览；不创建成员、不返回聊天记录 |
| GET / POST | /game-rooms/:roomId/messages | 房间会话必需；纯文本最多 4000 字符；最近 200 条按时间顺序返回 |
| POST | /game-rooms/:roomId/invite | 房主可生成新邀请；新邀请会替换旧邀请，通常客户端复用尚未过期的邀请 |

创建请求可带 `voiceChannelId`，必须是本小队语音频道。省略时使用独立 LiveKit 房间；指定时沿用大厅，客户端已在该大厅时不重连、不重新申请麦克风。一个大厅只允许关联一个未结束的游戏房间。

加入请求对小队成员可省略邀请码；已有有效房间会话时重复加入复用同一成员，避免重复人数。当前 `USER_ID` 仍固定为开发身份，不代表已经完成账号鉴权；公网部署前必须替换为真实身份。

`leaveGameRoom(roomId, endRoom=false)`：普通离开将成员设为 left。房主离开时在同一事务中将房主转给最早加入的剩余成员；最后一人离开则关闭房间。`endRoom=true` 仅限房主，直接结束房间。浏览器掉线不会自动结束房间。平台房主转交不代表 Warcraft 对局主机迁移。

新增事件 `game-room.message`，载荷只含 `{ roomId }`，客户端凭房间会话取消息。创建、加入、离开写入 system 消息。`game-room.updated` 驱动导航、成员和关闭状态；事件连接恢复后重新拉取，事件不持久化。

游戏启动、真实游戏内状态、地图/队伍同步与异地 LAN 转发仍待 Windows 代理实现。UI 不以进程启动状态推断正式开局，且不提供虚假的游戏准备/队伍槽位。

## 游戏中转实验接口

`POST /api/v1/game-rooms/:roomId/relay-ticket` 使用 `X-Echo-Game-Session` 授权，返回 `{ ticket, roomId, expiresIn: 30 }`，仅活动的 1.24e 房间成员可申请。

`WS /api/v1/game-relay` 首帧为 JSON `{ ticket }`。票据仅使用一次。认证成功返回 `{ type: "ready", role: "host" | "guest" }`，以及 `{ type: "peers", count }`。

房主发送 `{ type: "advertisement", packet: number[] }`，服务端仅转发至同房间的一位加入者。二进制帧为 `kind:u8 + streamId:u32le + payload`：1 打开（仅加入者），2 数据（最多 32768 字节），3 关闭。一个房间只支持一个游戏流。

房间生命周期约束、部署和验收边界见 `warcraft-relay.md`。

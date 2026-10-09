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

登录后接口使用 `Authorization: Bearer <session-token>`。v1 消息正文是纯文本，客户端必须按文本渲染，不能当作 HTML 插入页面。

## WebSocket 事件

`/api/v1/events`（升级握手时鉴权）。事件 envelope：

```json
{ "type": "message.created", "serverTime": "2026-10-08T12:00:00Z", "data": {} }
```

首批事件类型：`message.created`、`message.updated`、`channel.created`、`voice.participant_joined`、`voice.participant_left`、`presence.updated`。客户端断线后按最后消息 cursor 重新拉取；v1 暂不承诺事件持久投递。

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

`getMe`、`getServers`、`getChannels`、`getMessages`、`getMembers`、`createChannel`、`sendMessage`、`toggleReaction`、`togglePin`、`getVoiceToken`、`setVoicePresence`、`subscribe`。Mock 数据只存于当前浏览器的 `localStorage`，不是服务端数据；mock voice token 也不能连接 LiveKit。

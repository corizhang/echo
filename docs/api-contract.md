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
| `GET` | `/api/v1/ai/servers/{serverId}/agents` | — | `{ agents, canManage, canCreate }`; each agent includes `canManage`; key material is never returned |
| `GET` | `/api/v1/ai/servers/{serverId}/tts` | — | `{ configured, canManage, provider?, baseUrl?, model?, voice?, resourceId?, keySuffix? }`；不返回密钥 |
| `PUT` | `/api/v1/ai/servers/{serverId}/tts` | `{ provider, baseUrl?, model, voice, resourceId?, apiKey? }` | `{ configured, provider, baseUrl, model, voice, resourceId, keySuffix? }`；仅小队管理员可保存，首次保存需提供密钥 |
| `POST` | `/api/v1/ai/servers/{serverId}/tts/test` | — | `{ ok, latencyMs, durationMs, audioBytes }`；生成并丢弃测试语音 |
| `POST` | `/api/v1/ai/servers/{serverId}/agents` | `{ name, description, persona, model? }` | `{ agent }`（小队成员可创建；频道默认关闭）|
| `PATCH` | `/api/v1/ai/agents/{agentId}` | `{ name, description, persona, model, temperature, maxOutputTokens, enabled, voiceRepliesEnabled }` | `{ agent }`（机器人创建者或管理员）|
| `PUT` | `/api/v1/ai/agents/{agentId}/provider` | `{ provider: "deepseek", apiKey }` | `{ configured, provider, keySuffix }`; write-only secret |
| `POST` | `/api/v1/ai/agents/{agentId}/provider/test` | — | `{ ok, provider, latencyMs, availableModels }` |
| `PUT` | `/api/v1/ai/agents/{agentId}/installations` | `{ channels: [{ channelId, enabled, triggerMode, cooldownSeconds }] }` | `{ ok: true }`（机器人创建者或管理员）|
| `GET` | `/api/v1/ai/tools` | — | `{ tools: [{ key, name, description, enabledByDefault }] }` |
| `PUT` | `/api/v1/ai/agents/{agentId}/tools` | `{ tools: [{ key: "image.read" }, { key: "web.search" }] }` | Updated tool grants（机器人创建者或管理员）；省略的工具会关闭 |
| `GET` | `/api/v1/ai/agents/{agentId}/stickers` | — | `{ stickers, canManage, canManageSystem }`（系统默认 + 当前机器人专属）|
| `POST` | `/api/v1/ai/agents/{agentId}/stickers` | 原始图片字节；`Content-Type`、`X-Bot-Sticker-Name`、`X-Bot-Sticker-Emotion`、`X-Bot-Sticker-Description`、`X-Bot-Sticker-Scope` 请求头 | `{ sticker }`；agent 范围为创建者/管理员，system 范围仅管理员；≤2 MiB |
| `DELETE` | `/api/v1/ai/agents/{agentId}/stickers/{stickerId}` | — | `{ ok: true }`；下架，历史消息保留图片 |
| `GET` | `/api/v1/ai/agents/{agentId}/conversation` | — | Current user's private conversation and messages |
| `GET` | `/api/v1/ai/agents/{agentId}/conversation/messages/{messageId}/audio` | 登录凭证 | 私聊机器人生成的 WAV 音频（仅对话所有者可读）|
| `POST` | `/api/v1/ai/agents/{agentId}/conversation/messages` | `{ content }` | `{ conversationId, messages }` |
| `DELETE` | `/api/v1/ai/agents/{agentId}/conversation` | — | Clears only the current user's conversation |
| `GET` | `/api/v1/channels/{channelId}/messages?limit=50&before={messageId}` | — | `{ messages, hasMore, before }`（稳定游标分页，返回消息按时间正序排列）；支持 `q`、`authorId`、`fromDate`、`toDate`、`hasImage=true` 筛选当前频道 |
| `GET` | `/api/v1/servers/{serverId}/messages/search?limit=50&before={messageId}` | — | `{ messages, hasMore, before }`（只搜索小队文字频道，消息含 `channelName`；至少提供关键词或一个筛选条件） |
| `GET` | `/api/v1/channels/{channelId}/pins` | — | `{ messages }`（最多最近 100 条置顶消息）|
| `GET` | `/api/v1/messages/{messageId}/context` | — | `{ channelId, messages, hasOlder, hasNewer }`（目标消息及前后上下文）|
| `PUT` | `/api/v1/channels/{channelId}/read-state` | `{ messageId }` | `{ ok, messageId }`（推进当前用户在此频道的已读位置）|
| `POST` | `/api/v1/channels/{channelId}/messages` | `{ content, mentions?: [{ userId, start, end }], attachmentIds?: string[], audioAttachmentId?: string, stickerId?: string, replyTo?: { id } }` | `Message` (文本为空时需有图片、语音或表情包) |
| `PATCH` | `/api/v1/messages/{messageId}` | `{ content }` | Updated `Message`（仅作者可编辑，最多 4000 字）|
| `DELETE` | `/api/v1/messages/{messageId}` | — | `{ ok, id, channelId, deletedAt }`（仅作者可删除；保留删除占位以维护回复和已读游标）|
| `POST` | `/api/v1/channels/{channelId}/attachments` | 原始图片字节；`Content-Type` 和 `X-File-Name` 请求头 | `{ attachment }`（待发送上传）|
| `POST` | `/api/v1/channels/{channelId}/audio` | 原始音频字节；`Content-Type`、`X-File-Name`、`X-Audio-Duration-Ms` 请求头 | `{ attachment }`（待发送上传；支持 WebM、Ogg、MP4、MP3、WAV；0.5 秒至 2 分钟，单文件 ≤8 MiB，消息附件合计 ≤24 MiB）|
| `GET` | `/api/v1/attachments/{attachmentId}` | 登录凭证 | 图片或音频字节（仅当前小队成员可读）|
| `DELETE` | `/api/v1/attachments/{attachmentId}` | 登录凭证 | 删除当前用户尚未发送的上传 |
| `GET` | `/api/v1/servers/{serverId}/expressions` | — | `{ emojis, stickers, groups, canUpload, canManageSystem }`；系统默认 + 当前用户个人库 |
| `POST` | `/api/v1/servers/{serverId}/expressions` | 原始图片字节；`Content-Type`、`X-Expression-Name`、`X-Expression-Kind`、可选 `X-Expression-Scope`、`X-Expression-Group` 请求头 | `{ expression }`；个人范围仅上传者，系统范围仅管理员；Emoji ≤256 KiB，Sticker ≤2 MiB |
| `GET` | `/api/v1/expressions/{expressionId}` | 登录凭证 | 系统表情、本人个人表情或可见历史消息中的图片 |
| `DELETE` | `/api/v1/expressions/{expressionId}` | 登录凭证 | 上传者下架个人资源；管理员下架系统资源；历史 Sticker 消息仍可显示 |
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

登录后接口使用 `Authorization: Bearer <session-token>`。v1 消息正文是纯文本，附件使用独立字段；客户端必须将正文按文本渲染，不能当作 HTML 插入页面。

AI 管理权限按资源区分：小队成员可创建机器人，只有机器人创建者或小队管理员能编辑该机器人、人设、频道安装、工具授权和专属表情包；只有 `ai_bot_admins` 管理员能设置共享 DeepSeek API Key、共享 TTS API Key、测试供应商连接和管理所有机器人共用的系统表情库。初始迁移将 `user-lin` 设为 `server-squad` 管理员。私聊历史以当前登录用户作为 owner，WebSocket 的私聊事件只发送到该用户的已认证连接。AI provider 与 TTS API Key 都只接受写入，不提供读取；保存前需要配置 `ECHO_AI_ENCRYPTION_KEY`（64 位十六进制，即 32 字节），数据库只保存 AES-256-GCM 密文。当前聊天模型使用 DeepSeek Responses API 和 `deepseek-flash`、`deepseek-v4-pro`；TTS 是独立服务，可选 OpenAI Audio Speech 兼容接口或火山引擎豆包语音，不依赖 DeepSeek Key。豆包接入使用新版 `X-Api-Key` 鉴权、资源 ID 和音色 speaker ID，通过 SSE 接收 PCM 后在服务端封装为 WAV；默认资源 `seed-tts-2.0`、模型 `seed-tts-2.0-standard`，音色需从豆包控制台音色库选择且必须与资源授权匹配。语音回复默认关闭，管理员配置 TTS 服务后，由机器人创建者逐个开启。语音与文字同属一条回复；TTS 不可用时仍发送文字。TTS 限制为 WAV 输出、最大 8 MiB 与 2 分钟；服务器会把回复文本发送给所配置的语音服务商。群聊使用 `@机器人名称` 或回复机器人消息触发，频道未授权时不调用模型。`image.read` 和 `web.search` 都是默认关闭的机器人能力。图片理解启用后，可发送触发消息自身图片，以及该消息 `replyTo.id` 明确引用的原消息图片给 DeepSeek Flash，合计最多 4 张且 12 MiB；不会自动扫描频道其他历史图片，图片私聊目前不支持。联网搜索启用后，模型按需通过 DeepSeek Responses API 请求 Echo 服务端的 `search_web` 工具，再由服务端调用 DeepSeek Search API；每次成功搜索约 $0.75/1,000 次，普通闲聊不会触发搜索。搜索词会发送给 DeepSeek，回复会附最多 3 条来源链接。每次回复最多实际执行一次搜索。

房间 session token 只以明文返回创建/加入请求，并仅存浏览器当前 origin 的 `localStorage`；服务端只存 SHA-256 摘要。邀请链接携带 192-bit 随机 capability，七天过期。加入者不获得房主邀请 capability。状态值为 `waiting | in_game | closed`，玩家状态为 `joined | ready | starting | running | left`。此轻量期使用房间会话令牌而非完整账号系统；正式公开部署前必须补账户认证、访问控制、限流和会话撤销。

## Warcraft Windows 桌面代理契约（待实现）

Web 端通过 Tauri command 与本机代理交互，不直接读取本地进程/网卡：`detect_installations`、`launch_game(version, roomId)`、`get_agent_status`、`stop_game_session`。代理只负责定位用户自有的 Warcraft III 1.24e 安装、启动游戏、为房间建立/撤销本机 UDP 6112 LAN 广播代理；控制面仍走上述 HTTPS API，语音仍走 LiveKit。实际 LAN 发现与 NAT 穿透尚未实现或验证，首版不引入内核虚拟网卡驱动。实现时需要独立测试 1.24e 游戏公告包、TCP 游戏流量以及进程启动参数。

## WebSocket 事件

`/api/v1/events`（升级握手时鉴权）。事件 envelope：

```json
{ "type": "message.created", "serverTime": "2026-10-08T12:00:00Z", "data": {} }
```

首批事件类型：`message.created`、`message.updated`、`channel.created`、`expression.created`、`expression.deleted`、`game-room.updated`、`voice.participant_joined`、`voice.participant_left`、`presence.updated`、`ai.typing`、`ai.reply.failed`、`ai.direct.typing`、`ai.direct.message.created`、`ai.direct.reply.failed`。表情事件包含 `serverId`，客户端只更新当前小队的资源列表。私聊类事件在服务端按收件人用户 ID 过滤，不能广播给其他登录用户。客户端断线后按最后消息 cursor 重新拉取；v1 暂不承诺事件持久投递。

## 数据模型

```ts
type User = { id: string; username: string; displayName: string; status: 'online' | 'idle' | 'offline'; avatar?: string }
type Server = { id: string; name: string; iconUrl?: string; unread?: number }
type Channel = { id: string; serverId: string; name: string; type: 'text' | 'voice'; topic?: string; unread?: number }
type Reaction = { emoji: string; count: number; reacted: boolean }
type Expression = { id: string; kind: 'emoji' | 'sticker'; name: string; mimeType: string; sizeBytes: number; ownerUserId: string }
type Message = { id: string; channelId: string; authorId: string; author: string; createdAt: string; editedAt?: string | null; deletedAt?: string | null; content: string; sticker?: Expression | null; replyToId?: string | null; pinned: boolean; reactions: Reaction[] }
type Member = User & { activity?: string; voiceChannelId?: string | null }
```

## Mock adapter 方法

`getMe`、`getServers`、`getChannels`、`getMessages`、`getMembers`、`getExpressions`、`uploadExpression`、`deleteExpression`、`createChannel`、`sendMessage`、`editMessage`、`deleteMessage`、`getPins`、`getMessageContext`、`markChannelRead`、`createAiAgent`、`updateAiAgent`、`saveAiProvider`、`testAiProvider`、`updateAiInstallations`、`getAiConversation`、`sendAiDirectMessage`、`clearAiConversation`、`toggleReaction`、`togglePin`、`getVoiceToken`、`setVoicePresence`、`createGameRoom`、`joinGameRoom`、`getGameRoom`、`setGameMemberStatus`、`leaveGameRoom`、`getGameVoiceToken`、`subscribe`。Mock 数据只存于当前浏览器的 `localStorage`，不是服务端数据；mock API Key 只保存脱敏状态，不保存原文；mock AI 回复与连接测试都是模拟结果，mock voice token 也不能连接 LiveKit。

频道消息以 `created_at,id` 组成稳定游标，每页默认 50 条、最多 100 条；向上滚动时以最旧消息 ID 请求更早的消息。历史搜索可限定当前频道或扩展到整个小队文字频道，按 `q` 匹配消息正文和作者，并可按成员、日期范围、是否含图片筛选；日期按客户端本地日历日解释，HTTP adapter 转换为本地日界线对应的 ISO 时间戳，结束日期为次日零点（不含）。搜索结果可分页并显示所属频道，点击后跳转到原消息上下文。已读游标保存在 `channel_read_states`，迁移时将已有历史初始化为已读；频道列表返回 `unread` 数量和 `unreadMessageId`，进入有未读的频道时显示未读分隔线并定位到首条未读，滚到最新后推进已读游标。发送消息会在同一数据库事务内推进发送者自己的游标；读游标只允许单调前进，软删除保留消息行以避免游标失效。

消息编辑仅允许作者修改正文；编辑会清除旧提及区间，客户端将内容作为纯文本渲染。删除采用软删除并显示“此消息已删除”，同时取消置顶、清除反应与图片附件；引用该消息的回复仍保留，但显示已删除占位。Mock 和 HTTP adapter 都提供 `editMessage`、`deleteMessage`。

## 成员提及

频道输入框在输入 `@` 后从当前小队成员列表筛选成员，选择后显示 `@显示名称`。消息仍保留可读文本，另带 `mentions` 数组保存目标用户 ID 和文本区间：`[{ "userId": "user-mori", "start": 0, "end": 5 }]`。`start`/`end` 使用 JavaScript 字符串下标（UTF-16，左闭右开）。服务端只接受本小队成员且区间文本与其当前显示名完全一致的条目，并将该身份随 `message.created` 事件广播。机器人通过被提及用户 ID 判断触发；手动输入机器人名称的旧用法仍兼容。

## 图片附件

文字频道支持 PNG、JPEG、GIF 和 WebP；单张最多 8 MiB，每条最多 10 张且总大小不超过 24 MiB。上传文件按随机存储名放在 API 容器的 `/app/uploads`，Compose 使用 `echo-uploads` 命名卷持久化。上传时服务端核对文件签名；未发送的临时上传 24 小时后清理。发送消息时只能关联当前用户在同一频道尚未发送的附件。图片读取需要有效登录且属于该小队成员。Mock 模式可预览图片，但仅在当前页面会话内保存。

## 系统默认与个人 Emoji、表情包

表情选择器提供标准 Emoji、系统默认库和当前用户的个人库。个人资源只有上传者能在选择器中看到、选择和管理；发送到频道后，频道成员仍可查看该历史消息图片。系统资源可由小队管理员管理。自定义 Emoji 上传 PNG/JPEG/GIF/WebP，最大 256 KiB，名称为 2–32 位 ASCII 字母、数字或下划线；在消息正文插入 `:name:` 短码，客户端按当前用户可访问的库安全渲染，找不到时显示原短码。Sticker 最大 2 MiB，点选后作为独立消息发送，可在消息中点击放大。文件存入既有 `/app/uploads` 持久卷。上传者可下架自己的个人资源；管理员可下架系统资源；已发送 Sticker 的历史消息继续引用并显示原图。

每种资源均可归入分组。个人分组仅创建者可见和管理；系统分组仅管理员管理。管理员可通过表情选择器上传系统资源，普通用户可直接上传到个人库，无需编辑服务端清单。旧的仓库 `expression-packs/<serverId>/manifest.json` 与 `api/scripts/sync-expression-packs.js` 仍用于开发期批量导入，不是日常配置要求。HTTP 上传可附带 `X-Expression-Scope`、`X-Expression-Group`；列表返回 `groups.emoji`、`groups.sticker` 和资源的 `scope`、`ownerUserId`、`groupId` 字段。Mock 模式会将个人库保存在当前浏览器 localStorage，不等同服务端同步。

## AI 机器人专属表情包

AI 机器人的图库与用户表情库完全独立。每个机器人默认继承管理员维护的系统表情库，机器人创建者或小队管理员可以在机器人设置中为该机器人上传专属表情；无需为每个机器人预先建一套图库。每个图库可有多组情绪分类；模型仅得到该机器人可用图片的 key、情绪和描述，按需调用 `send_sticker` 工具。每次回复最多选择一张；文字回复和贴图写成两条独立消息，先文字后图片。支持频道多人聊天和机器人私聊。机器人创建者或管理员可在机器人设置中关闭“机器人发表情包”。旧的 `ai-sticker-packs/<agentId>/manifest.json` 与同步脚本保留给开发期批量导入。

AI 贴图存于独立 `ai_agent_stickers` 表，消息引用独立的 `message_ai_stickers` 或 `ai_direct_messages.sticker_id`，不会读取用户上传的 `expression_assets`，也不能通过普通表情库管理操作删除。仅小队成员可读取图片；下架的图片不再用于新回复，但历史消息仍保留可访问引用。图片支持 PNG/JPEG/GIF/WebP，每张最多 2 MiB。上传时填写的描述是给模型的选图线索，应描述表情内容和适用情绪，不能写指令。


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

API 每 5 秒发送 `{ type: "ping", pingId }` 应用层心跳，客户端返回 `{ type: "pong", pingId }`。心跳通过 WSS 或 QUIC 适配器转发至真实桌面客户端后再回到 API，以统一测量两个传输路径的端到端 RTT。QUIC 客户端首个双向流承载与 WSS 一致的认证 JSON；之后以长度前缀帧转发 WebSocket 文本/二进制消息，QUIC relay 再连接内部 API WebSocket。公网 QUIC 端口默认 UDP 40000。

房主发送 `{ type: "advertisement", packet: number[] }`，服务端转发给同房间所有加入者。二进制帧为 `kind:u8 + streamId:u32le + payload`：1 加入者请求打开流，2 数据（最多 32768 字节），3 关闭，4 服务端返回房间唯一流 ID（头部 ID 是客户端本地流 ID，四字节负载是房间流 ID）。服务端将各加入者的独立 TCP 游戏流映射到房主；每个加入者最多一个活动流，一个房间最多 8 个在线成员（房主加 7 名加入者）。

房间生命周期约束、部署和验收边界见 `warcraft-relay.md`。

## 豆包语音情绪

仅当机器人启用语音回复且共享 TTS 服务商为豆包时，模型才会按需调用内部 `set_voice_emotion` 工具，为当前这一条回复选择可选情绪和 1–5 强度；普通闲聊或判断不明确时不传情绪参数。该标签只用于当前语音，不保存为机器人长期心情。豆包合成接收 `audio_params.emotion` / `emotion_scale`；若供应商明确拒绝情绪参数，会自动以中性参数重试一次，尽量保留语音回复。可用情绪受 speaker 音色授权限制。

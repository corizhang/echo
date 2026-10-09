# 在 VPS 上给朋友试用

## 先理解当前测试范围

目前没有账号/密码系统；服务端所有访客都会映射成开发用户 Lin。直接开放 API 会让任何人访问服务并加入房间。本指南按**小范围封闭测试**写：用 VPS 防火墙仅允许自己和朋友当前的公网 IP 访问 TCP 443、UDP 7882，并只允许管理员 IP SSH。朋友 IP 变化时需更新云厂商防火墙/UFW 规则。无法稳定维护 IP 白名单时，先不要公开运行，先补应用账号认证。

这不是正式公网发布配置。测试用户彼此共享开发身份，聊天署名、权限和审计不能视为真实账号隔离。

## 网络与域名

1. 在 VPS 防火墙/安全组和系统防火墙中配置：TCP 80 用于 HTTP 到 HTTPS 跳转及证书续期；TCP 443 仅允许测试成员公网 IP；UDP 7882 仅允许测试成员公网 IP；SSH 仅允许管理员 IP。不要开放 TCP 8080、3000、5432、6379 或 LiveKit TCP 7880。
2. 将自己的域名 `echo.example.com` 添加一条指向 VPS 公网 IPv4 的 DNS A 记录，设置为 DNS only（非代理）。这样 Caddy 可直接签发/续期证书，服务器也能看到连接者源 IP。不要把动态 DDNS 地址填到已固定的 VPS 记录。
3. 确认 VPS 入站 UDP 7882 可达；LiveKit 使用单个 UDP mux 媒体端口。只有 HTTP 80/443 而没有这个 UDP 端口，语音不可用。

如果朋友的公网 IP 会变化，请在云防火墙中临时更新白名单；此原型没有登录页可抵御未经授权的访问。

## 部署应用栈

以干净的 Ubuntu VPS 为例，先安装 Docker Engine 和 Compose 插件；不要在生产服务器运行未经审阅的安装脚本。SSH 登录后：

```bash
git clone https://github.com/corizhang/echo.git
cd echo
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，设置高强度随机值：

```dotenv
POSTGRES_PASSWORD=<使用 openssl rand -hex 32 生成>
LIVEKIT_API_KEY=<使用随机字母数字生成>
LIVEKIT_API_SECRET=<使用 openssl rand -hex 32 生成>
```

`CLOUDFLARE_TUNNEL_TOKEN` 可留空；本方案由 VPS 上的 Caddy 处理 HTTPS，不需要 Cloudflare Tunnel。永远不要提交 `.env`。

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api web livekit
```

Compose 已将 Web 发布在 `127.0.0.1:8080`，Postgres、Redis、API 只在 Docker 网络中提供服务，LiveKit 映射 UDP 7882。不要改成 `0.0.0.0:8080`。

## 配置 HTTPS 反代

在 VPS 主机安装 Caddy，确认域名 A 记录已生效、TCP 80/443 可到达 Caddy，将仓库中的 `deploy/Caddyfile.example` 复制到 Caddy 的配置目录，并把 `echo.example.com` 换成自己的域名。校验/加载配置后确认 Caddy 已签发证书。配置核心是：

```caddyfile
echo.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 会代理 HTTP、WebSocket 升级（语音信令、事件和游戏 TCP 中转），并自动提供 HTTPS。LiveKit 的语音媒体随后直接走 UDP 7882，不能只靠 HTTP 反代。

## 构建连接 VPS 的 Windows 客户端

在 Windows 开发电脑的项目目录执行（不是在 VPS 上）：

```powershell
$env:ECHO_SERVER_URL = 'https://echo.example.com'
npm run build:desktop
```

将构建日志指向的 `dist/windows/<时间>/Echo.exe` 用安全方式发给朋友。每个人安装/运行后进入同一个房间并打开「异地联机」。一人作为 Echo 房主，在魔兽局域网建图，另一人在局域网列表加入。

首次部署后先访问 `https://echo.example.com` 确认页面，再用双人语音验证麦克风、扬声器和 UDP 7882，最后做 Warcraft 1.24e 双机对局。不同阶段分别通过后再开始下一项；“信令连接成功”不能证明 UDP 或游戏流量可用。

## 更新和备份

更新代码前先备份数据库，再执行 `git pull --ff-only` 与 `docker compose up -d --build`。Postgres/Redis 数据保存在 Docker volumes；容器重建不会自动清除 volume，但应定期做异机备份并验证恢复。不要执行带 `-v` 的 `docker compose down`，除非明确要删除数据。

## 后续必须补齐

- 邀请制账号认证和逐用户权限；移除固定开发身份。
- 让桌面端使用正式发布渠道/签名，并设计用户登录和房间邀请。
- 评估日志、限流、数据库备份/恢复和密钥轮换。
- 与另一台真实 Windows 电脑验证 1.24e 局域网发现、TCP 入房、加载地图和完整对局。服务器中转延迟由你和朋友所在地区决定。

公网 HTTPS 由 Caddy 和证书机构提供；VPS、防火墙或 DNS 供应商可能收费。UDP 流量会消耗 VPS 出站流量配额。

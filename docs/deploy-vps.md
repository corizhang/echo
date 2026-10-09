# 在 VPS 上给朋友试用

## 先理解当前测试范围

应用关闭了公开注册，服务启动时会创建/更新两个预置账号 `lin` 和 `mori`。本指南按**小范围封闭测试**写：仍建议用 VPS 防火墙仅允许自己和朋友当前的公网 IP 访问 TCP 443、UDP 7882，并只允许管理员 IP SSH。朋友 IP 变化时需更新云厂商防火墙/UFW 规则。

这不是正式公网发布配置。只有两组预置账号，没有管理员账号管理、密码重置或公开注册。Docker 发布的端口在一些配置下会绕过 UFW 的常规规则；请优先在云厂商安全组设置源 IP 白名单，Docker 网络规则则参考 Docker 官方 `DOCKER-USER` 链文档并验证实际过滤效果。不要只凭 `ufw status` 判断 UDP 7882 已被限制。

## 网络与域名

1. 在 VPS 防火墙/安全组和系统防火墙中配置：TCP 80 用于 HTTP 到 HTTPS 跳转及证书续期；TCP 443 仅允许测试成员公网 IP；UDP 7882 为首选语音媒体端口，TCP 7881 为网络受限时的 ICE 回退端口，两者均允许测试成员公网 IP；SSH 仅允许管理员 IP。不要开放 TCP 8080、3000、5432、6379 或 LiveKit API TCP 7880。
2. 将自己的域名 `echo.example.com` 添加一条指向 VPS 公网 IPv4 的 DNS A 记录，设置为 DNS only（非代理）。这样 Caddy 可直接签发/续期证书，服务器也能看到连接者源 IP。不要把动态 DDNS 地址填到已固定的 VPS 记录。
3. 确认 VPS 入站 UDP 7882 可达；LiveKit 使用单个 UDP mux 媒体端口。TCP 7881 是 ICE 回退端口。只有 HTTP 80/443 而没有 UDP 7882，语音不可用。

如果朋友的公网 IP 会变化，请在云防火墙中临时更新白名单。登录认证能区分这两个账号，但仍建议在小范围测试阶段限制来源 IP。

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
ECHO_TEST_LIN_PASSWORD=<lin 测试账号专用密码，至少 16 位>
ECHO_TEST_MORI_PASSWORD=<mori 测试账号专用密码，至少 16 位>
```

将两个密码分别生成并妥善保存；服务不会返回或显示原始密码。每次修改 `.env` 中的账号密码后重建 API，旧会话会自动撤销：`docker compose up -d --build api`。登录名为 `lin` 和 `mori`，没有注册入口。

`CLOUDFLARE_TUNNEL_TOKEN` 可留空；本方案由 VPS 上的 Caddy 处理 HTTPS，不需要 Cloudflare Tunnel。永远不要提交 `.env`。

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api web livekit
```

Compose 已将 Web 发布在 `127.0.0.1:8080`，Postgres、Redis、API 只在 Docker 网络中提供服务，LiveKit 映射 TCP 7881 ICE 回退和 UDP 7882 媒体端口。不要改成 `0.0.0.0:8080`。

## 配置 HTTPS 反代

以下假设使用 Ubuntu/Debian + systemd，Caddy 二进制已安装在 `/usr/bin/caddy`。命令可从任意目录执行。将示例域名 `chat.example.com` 替换成自己的域名。

### 前置条件

1. 为域名添加 A 记录，指向 VPS 公网 IPv4；等待 DNS 生效。若使用 Cloudflare DNS，测试时设为 **DNS only**。
2. 在云厂商安全组/防火墙允许 TCP 80 和 443 入站，供 Caddy 获取 HTTPS 证书和接收请求；另需允许 UDP 7882 入站供 LiveKit 传输语音，并允许 TCP 7881 作为 ICE 回退。
3. 确认 Echo Web 已在本机回环地址的 8080 端口运行：

```bash
cd ~/echo
docker compose ps
curl -I http://127.0.0.1:8080
```

不要为了让 Caddy 访问而把 Web 改为公网监听；Compose 默认发布到 `127.0.0.1:8080` 即可。

### 编写 Caddyfile

```bash
sudo mkdir -p /etc/caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
EOF
sudo chmod 755 /etc/caddy
sudo chmod 644 /etc/caddy/Caddyfile
```

### 配置 systemd 服务

如果 `systemctl status caddy` 已能找到并显示 Caddy 服务，可跳过本节的服务创建步骤，直接使用现有服务。直接复制二进制安装的 Caddy 通常需要手动创建 systemd unit：

```bash
getent group caddy >/dev/null || sudo groupadd --system caddy
id caddy >/dev/null 2>&1 || sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin --comment "Caddy web server" caddy
sudo install -d -o caddy -g caddy -m 750 /var/lib/caddy
sudo tee /etc/systemd/system/caddy.service >/dev/null <<'EOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
```

检查配置并启动：

```bash
sudo /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy --no-pager -n 80
```

Caddy 会自动申请和续期证书、把 HTTP 跳转到 HTTPS，并反向代理普通 HTTP 和 WebSocket 请求。浏览器访问 `https://chat.example.com`。LiveKit 的语音媒体优先通过 UDP 7882 传输，TCP 7881 提供 ICE 回退，所以 HTTP 反代不能替代这些端口的防火墙规则。

## 构建连接 VPS 的 Windows 客户端

在 Windows 开发电脑的项目目录执行（不是在 VPS 上）：

```powershell
$env:ECHO_SERVER_URL = 'https://echo.example.com'
npm run build:desktop
```

将构建日志指向的 `dist/windows/<时间>/Echo.exe` 用安全方式发给朋友。每个人安装/运行后进入同一个房间并打开「异地联机」。一人作为 Echo 房主，在魔兽局域网建图，另一人在局域网列表加入。

首次部署后先访问 `https://echo.example.com` 确认页面，再用双人语音验证麦克风、扬声器和 UDP 7882（受限网络下也检查 TCP 7881 回退），最后做 Warcraft 1.24e 双机对局。不同阶段分别通过后再开始下一项；“信令连接成功”不能证明 UDP 或游戏流量可用。

## 更新和备份

更新代码前先备份数据库，再执行 `git pull --ff-only` 与 `docker compose up -d --build`。Postgres/Redis 数据保存在 Docker volumes；容器重建不会自动清除 volume，但应定期做异机备份并验证恢复。不要执行带 `-v` 的 `docker compose down`，除非明确要删除数据。

## 后续必须补齐

- 管理员账号管理和密码重置能力。
- 让桌面端使用正式发布渠道/签名，并设计用户登录和房间邀请。
- 评估日志、限流、数据库备份/恢复和密钥轮换。
- 与另一台真实 Windows 电脑验证 1.24e 局域网发现、TCP 入房、加载地图和完整对局。服务器中转延迟由你和朋友所在地区决定。

公网 HTTPS 由 Caddy 和证书机构提供；VPS、防火墙或 DNS 供应商可能收费。UDP 流量会消耗 VPS 出站流量配额。

# 11 对战平台双机网络取证流程

第一次双机测试请先按 [快速操作手册](11-platform-two-pc-quickstart.md) 准备两台电脑、运行采集脚本并归档材料；本文保留更完整的测试背景、手动抓包方法和后续分析问题。

## 目标与范围

这次测试的对象是 **11 对战平台（5211）和 Warcraft III 1.24e**，目标是从房主与加入者两端确认：平台控制连接、虚拟局域网/游戏转发、Warcraft 房间发现与游戏数据分别经过哪些端点和协议；加入过程何时建立连接、何时中断；两端观察到的路径是否一致。

本轮不要同时运行 Echo 的魔兽联机/中转功能，避免把 Echo 的 QUIC、WSS 或本机代理流量混进 11 的数据。Echo 只在 11 的链路分析完成后，作为对照设计对象。

双机抓包可以补上之前只有房主抓包的缺口，但仍不能仅凭流量大小给加密/私有协议命名。需要把包时间、端点、进程 PID、11 平台日志和游戏阶段相互印证。

## 测试前准备

两台 Windows 电脑分别作为 **房主** 和 **加入者**：

- 安装同一版本的 11 对战平台，并确认能正常登录；记录平台版本、Windows 版本和 Warcraft 客户端版本/位数。
- 使用相同 Warcraft III 1.24e 客户端、相同地图与必要补丁。先单独启动游戏确认两台都能正常运行。
- 两台电脑使用不同的互联网接入网络，尽量避免处于同一个路由器/同一个局域网。记录地区、运营商、网络类型（有线/Wi‑Fi/手机热点）及是否使用 VPN。
- 关闭下载、云盘同步、视频流等大流量程序；暂停 Echo 的联机、语音或其他网络中继测试。
- 校准两台电脑时间，并统一记录时区。开始前准备一份时间表，精确记录登录、进房、建图、加入、开局、卡顿/掉线和退出的时间。
- 创建单独的测试目录，例如 `C:\11NetTest\2026-10-13`。pcapng/ETL 可能暴露公网 IP、局域网 IP、DNS 查询和设备信息，只通过可信渠道分享。

测试以复现一次完整流程为目标：从创建平台房间前开始采集，成功进入 Warcraft 后进行 3–5 分钟短局，再正常退出。不要一开始就边测试边改防火墙、平台设置或路由器参数。

## 一键采集脚本（推荐）

仓库提供 `scripts/11-platform-capture.ps1`，房主和加入者各运行一份。它会建立桌面固定归档目录 `11PlatformNetTest\<时间>-<角色>`，记录网卡、Pktmon 组件和进程信息，启停抓包、保存关键阶段 TCP/UDP 端点快照、转换 pcapng，并在结束时尝试复制最近更新的 11 会话日志目录。脚本不会修改 11、游戏、防火墙或网络配置。

两台电脑分别以管理员身份打开 PowerShell，在仓库目录下执行。下面房主电脑用 `host`，加入者电脑用 `guest`：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\11-platform-capture.ps1 -Action Start -Role host
```

`ExecutionPolicy` 只对当前 PowerShell 进程生效。加入者将角色改为 `guest`。开始后不要关闭 11 或游戏；测试到下列阶段时，在各自电脑的另一个管理员 PowerShell 窗口运行快照命令：

```powershell
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase room-created
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase warcraft-hosting
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase in-game
```

加入者也运行对应命令。阶段标签仅允许英文字母、数字、下划线和连字符。脚本自动在 `timeline.md` 追加采样时间；具体事件时间、现象和时区请补充到同一文件。

游戏正常退出、11 日志已经写入后，分别执行：

```powershell
.\scripts\11-platform-capture.ps1 -Action Stop -Role host
```

加入者改为 `guest`。结束时脚本会显示它找到的最近更新日志目录；确认是本轮会话后按 Enter 复制。若目录不对，输入 `n`，再将正确的 11 会话日志目录手动复制到屏幕给出的归档目录。若 11 日志不在默认的 `E:\010-games\014-11对战\5211platform\yybins\log` 下，可通过 `-LogRoot '实际日志父目录'` 覆盖。

完成后材料集中在两台电脑桌面各自的 `11PlatformNetTest` 目录内。请检查归档中的 `host/guest.pcapng`、ETL、快照、`timeline.md` 和 `11-platform-logs`。如果脚本提示抓包已经在运行或无法启动，不要直接停止未知采集任务；记录提示并使用手动流程排查。分享材料前检查公网 IP、账号标识及其他隐私信息。

## 采集 Windows 网络流量

### 1. 记录网络组件和平台进程

在两台电脑以管理员身份打开 PowerShell，分别执行并保存输出：

```powershell
New-Item -ItemType Directory -Force -Path 'C:\11NetTest\2026-10-13' | Out-Null
pktmon status
pktmon list | Out-File 'C:\11NetTest\2026-10-13\pktmon-components.txt'
Get-NetAdapter | Format-Table -AutoSize | Out-File 'C:\11NetTest\2026-10-13\network-adapters.txt'
```

留意 11 安装的虚拟网卡或隧道适配器名称、状态和地址；不要禁用它。记录 11 主进程、`War3Shell`、`war3.exe` 及相关服务的 PID。可在任务管理器「详细信息」页查看，也可用：

```powershell
Get-Process | Where-Object { $_.ProcessName -match '5211|War3|VirtualGame|GameRoom|Vpn' } |
  Select-Object ProcessName, Id, Path | Format-Table -AutoSize |
  Out-File 'C:\11NetTest\2026-10-13\processes.txt'
```

进程名可能随版本变化；如筛选结果为空，使用任务管理器记录实际名称和 PID。

### 2. 开始抓包

Pktmon 采集需要管理员权限。为同时观察物理网卡上的公网外层连接、虚拟网卡上的内层流量以及 Windows 组件路径，本轮先不限制组件和端口。时间控制在几分钟，避免生成过大的文件。

```powershell
pktmon start --capture --pkt-size 0 --file-name 'C:\11NetTest\2026-10-13\host.etl'
```

加入者将文件名改成 `guest.etl`。确认 `pktmon status` 显示正在采集。若已有采集任务，先确认其用途后再处理，不要直接覆盖别的诊断记录。

### 3. 记录连接与 PID

在以下关键时刻（创建平台房间前、加入平台房间后、Warcraft 建图后、加入者进图后）各保存一次 TCP/UDP 端点和 PID 快照。文件名要标出角色和阶段：

```powershell
Get-NetTCPConnection -ErrorAction SilentlyContinue |
  Select-Object State, LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess |
  Export-Csv 'C:\11NetTest\2026-10-13\host-tcp-created-room.csv' -NoTypeInformation

Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Export-Csv 'C:\11NetTest\2026-10-13\host-udp-created-room.csv' -NoTypeInformation
```

后续快照将 `host` 替换为 `guest`，并把 `created-room` 改为 `joined-platform-room`、`warcraft-hosting`、`in-game`。用 `OwningProcess` 对照 `processes.txt`。UDP 端点列表只显示本地端口，不提供远端地址；远端五元组从抓包里分析。

如果 PowerShell 命令采集时提示权限或系统版本错误，记录完整错误和 Windows 版本，不要因此中断抓包。

## 双机同步测试时间表

两位操作者通过电话或其他独立方式同步操作，并在表格中记到秒。每个阶段都写明房主/加入者本地时间和时区。

| 阶段 | 操作 | 记录内容 |
|---|---|---|
| A：登录基线 | 两边启动 11 并登录，暂不进房，等待 30 秒 | 登录时间、账号角色（可匿名标为 A/B）、平台版本、网卡状态 |
| B：创建平台房间 | 房主创建 11 对战房间，加入者通过好友/房间入口加入 | 房间创建与加入时间、房间号（分享时可遮挡部分）、成员状态、是否触发虚拟网卡/服务启动 |
| C：进入游戏房间 | 房主从 11 启动或切换到 Warcraft 房间，创建局域网游戏 | `War3Shell`/`war3.exe` 启动时间、地图名、平台界面状态、虚拟网卡状态 |
| D：发现与加入 | 加入者打开 Warcraft 局域网列表，刷新并加入房主游戏 | 列表中房间数量、房间名称/地图、加入点击时间、游戏提示、房主端变化 |
| E：短局观察 | 成功进图后活动 3–5 分钟 | 卡顿/掉线时间、持续时间、双方游戏内表现、平台状态是否变化 |
| F：正常退出 | 两边正常退出游戏，再退出 11 房间/平台 | 退出时间、虚拟网卡/连接何时关闭、日志中的退出原因 |

出现重复房间时，逐条记录每个条目是否能加入、加入失败的时间和错误提示。失败后先不要快速重复操作，先让两边保存当前状态和时间点；首个失败连接通常更有诊断价值。

## 停止采集与转换

阶段 F 完成后，两台电脑各自执行：

```powershell
pktmon stop
pktmon etl2pcap 'C:\11NetTest\2026-10-13\host.etl' --out 'C:\11NetTest\2026-10-13\host.pcapng'
```

加入者将 `host` 改为 `guest`。保留 `.etl` 原文件；它有助于查看 Pktmon 组件路径和丢包事件，pcapng 更方便在 Wireshark 中分析。多个组件可能观察到同一数据包，所以 pcapng 中出现重复包时，应结合 ETL 和组件列表判断，不能直接认定是线上重复发送。转换会丢失部分组件路径/丢包上下文，相关说明见 [Microsoft Pktmon pcapng 文档](https://learn.microsoft.com/en-us/windows-server/networking/technologies/pktmon/pktmon-pcapng-support)。

## 必须收集的 11 平台日志

复制 11 本次会话的整个日志目录，保留相对目录结构和原始文件名。已知本机日志位置形式如下（日期目录会变化）：

```text
E:\010-games\014-11对战\5211platform\yybins\log\<本次会话目录>\
```

重点保留实际存在的：

- `VirtualGameRoomService.log`
- `GameRoomService.log`
- `VpnService.log`
- `War3Shell*.txt`
- 同一会话目录内其他 11 平台服务日志及崩溃记录

房主与加入者分别打包，并明确标记 `host` / `guest`。不要只截取最后几十行；要保留登录至退出的完整时间段，以便关联建房、加入、虚拟网络建立、游戏发现、代理连接和关闭。日志可能包含账号标识或房间信息，分享前先检查敏感字段。

## 分析时要回答的问题

1. 11 的登录/房间控制 TCP 连接分别连到哪些远端端点、何时建立和关闭？
2. 创建/加入 11 房间后，`VpnService` 是否建立新的 TCP、UDP 或虚拟网卡通道？流量是否与 Warcraft 建图/加入/对局阶段同步变化？
3. 房主和加入者之间是否存在可识别的直接公网 UDP 流？若没有，是否有双方持续连接到同一平台服务端的流量，可能承担中转？不能仅凭地址相同就断言该端点在转发游戏数据。
4. 虚拟网卡上是否出现 Warcraft 局域网发现/游戏流量，物理网卡上对应的是原始 IP/UDP/TCP，还是封装后的平台隧道？
5. 加入失败或掉线前，哪一端先停止发送、先收到 FIN/RST/ICMP，或先由平台日志报告断开？
6. 重复局域网房间的两个条目，其 W3GS 游戏标识/端口/广播源是否相同？是否分别对应 Warcraft 本机广播和 11 虚拟网络重发？须将包特征与客户端日志对应后再结论。

## 交付材料清单

房主和加入者各提供：

1. `.pcapng`，最好同时保留 `.etl`。
2. 11 本次会话的完整日志目录。
3. `pktmon-components.txt`、`network-adapters.txt`、`processes.txt` 和 TCP/UDP 快照。
4. 双机时间表：各阶段时间（含时区）、平台/游戏版本、网络类型、游戏房间条目数量、错误提示和卡顿情况。

分析前不要公开上传原始抓包。抓包可能包含公网 IP、局域网地址、DNS 查询、设备名和非 11 应用流量；需要对外分享时先脱敏。测试完成后再按同样阶段另做 Echo 双机测试，才能逐项比较 11 与 Echo 的连接路径和故障表现。

## 命令参考

- [Microsoft：pktmon start](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/pktmon-start)
- [Microsoft：Pktmon pcapng 支持与 etl2pcap](https://learn.microsoft.com/en-us/windows-server/networking/technologies/pktmon/pktmon-pcapng-support)

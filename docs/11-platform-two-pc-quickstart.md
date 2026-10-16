# 11 对战平台双机联机测试：快速操作手册

本文面向你和一位好友，按房主/加入者两台 Windows 电脑组织一次 Warcraft III 1.24e 联机测试，并采集分析 11 对战平台网络链路所需的资料。更深入的协议分析目标和数据判读说明见 [双机网络取证流程](11-platform-two-pc-capture.md)。

## 好友电脑需要安装什么

必需项：

- **Windows 10 或 Windows 11**。Pktmon 是 Windows 内置的网络采集工具；无需另装抓包驱动。[Microsoft Pktmon 文档](https://learn.microsoft.com/en-us/windows-server/networking/technologies/pktmon/pktmon)
- **11 对战平台**：与房主使用相同的平台版本，能正常登录。
- **Warcraft III 1.24e**：与房主使用相同版本，并准备相同地图及双方需要的补丁。
- **本项目的 PowerShell 脚本**：不需要安装软件或 PowerShell 模块。可以把 `scripts/11-platform-capture.ps1` 单独通过可信渠道发给好友，也可以让好友下载项目文件。
- **Windows 管理员权限**：开始、保存快照和停止抓包时都要在管理员 PowerShell 中执行脚本。

可选项：

- **Wireshark**：只在需要自己查看 `.pcapng` 时安装；采集和归档不需要它。`.etl` 也请保留，便于继续分析 Pktmon 的组件路径和丢包事件。
- Git：只有选择 `git clone` 下载项目时才需要；单独拿到 `.ps1` 脚本就不需要安装 Git。

## 测试前约定

1. 两台电脑尽量使用不同的互联网连接（例如不同家庭宽带），不要接入同一个路由器。这样才能观察跨公网链路。
2. 记录两边的 Windows、11 平台和 Warcraft 版本，以及所在地区、运营商、网线/Wi-Fi/热点、是否使用其他 VPN。不要关闭 11 平台自己的虚拟网卡或服务。
3. 测试期间暂停 Echo 的联机/语音、下载、云同步和视频流，减少无关流量。
4. 两边确认 Windows 时间已同步，并约定使用本地时间及 `+08:00` 时区记录事件。通过电话或其他语音方式协调操作。
5. 目标是完整复现一局：从建 11 平台房间前开始采集，成功进入 Warcraft 后玩 3–5 分钟，再正常退出。第一轮不要中途调整防火墙或网络设置。
6. 每台电脑都用**同一个 Windows 账号**完成 Start、Snapshot 和 Stop；可使用“以管理员身份运行”，不要中途切换到另一个 Windows 账号。

## 准备脚本

若收到的是单独的脚本，将它放在一个固定目录，例如 `C:\11NetTest\11-platform-capture.ps1`。若下载了整个 Echo 项目，则脚本路径是项目目录下的 `scripts\11-platform-capture.ps1`。

两台电脑分别打开**管理员 PowerShell**，切换到脚本所在目录。只对当前 PowerShell 进程放宽脚本执行策略：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

可先确认命令存在：

```powershell
Get-Command pktmon.exe
```

若找不到 `pktmon.exe`，记录 Windows 版本并先更新 Windows；不要从不明网站下载替代版本。

## 开始采集

在创建或加入 11 房间之前，房主和好友分别运行一次。下面以项目目录形式为例；若脚本是单独放置的，将路径改成 `C:\11NetTest\11-platform-capture.ps1`。

房主电脑：

```powershell
.\scripts\11-platform-capture.ps1 -Action Start -Role host
.\11-platform-capture.ps1 -Action Start -Role host
```

加入者电脑：

```powershell
.\scripts\11-platform-capture.ps1 -Action Start -Role guest
```

若只拿到单独的脚本并将 PowerShell 当前目录切换到脚本所在目录，把命令中的 `.\scripts\11-platform-capture.ps1` 改成 `.\11-platform-capture.ps1`；Snapshot 和 Stop 命令也同样替换脚本路径。

脚本会在桌面创建 `11PlatformNetTest\<时间>-<角色>` 归档目录，保存电脑、网卡、Pktmon 组件和相关进程信息，然后开始写入 `.etl` 抓包。开始后确认没有报错，再开始登录与建房。

如果好友的 11 日志不在默认目录 `E:\010-games\014-11对战\5211platform\yybins\log`，开始采集时用 `-LogRoot` 指定**日志父目录**，例如：

```powershell
.\scripts\11-platform-capture.ps1 -Action Start -Role guest -LogRoot 'D:\Games\11Platform\yybins\log'
```

停止采集时也要带相同的 `-LogRoot`。

## 双机操作与阶段快照

在两台电脑各自的管理员 PowerShell 中执行对应角色的快照命令。开始抓包的窗口可以继续使用；也可另开管理员 PowerShell，但必须仍是同一 Windows 账号。

| 阶段 | 房主操作 | 加入者操作 | 快照阶段名 |
|---|---|---|---|
| 登录基线 | 启动 11 并登录，等待约 30 秒 | 同样登录并等待 | `login-idle` |
| 进入 11 房间 | 创建 11 对战房间 | 加入房主的 11 房间 | `platform-room` |
| 房主建图 | 启动 Warcraft，在局域网建立游戏 | 留在平台房间，观察状态 | `warcraft-hosting` |
| 加入者进图 | 等待加入 | 刷新局域网列表并点击房主游戏 | `join-click`，进入后再记 `in-game` |
| 对局结束 | 正常退出游戏及平台房间 | 正常退出游戏及平台房间 | `test-end` |

房主示例：

```powershell
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase login-idle
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase platform-room
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase warcraft-hosting
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase join-click
.\scripts\11-platform-capture.ps1 -Action Snapshot -Role host -Phase in-game
```

加入者把 `host` 改为 `guest`，并在自己电脑发生相应事件时执行。`-Phase` 仅使用英文字母、数字、下划线和连字符。

同时把下面事件时间和现象填写到各自归档中的 `timeline.md`：登录、创建/加入 11 房间、房主建图、加入者点击加入、进入游戏、卡顿/掉线、正常退出。记录到秒并写时区；若出现重复房间，写清显示数量、每个条目是否能加入、错误提示和发生时间。不要在失败后连续快速重试，先记录当时状态。

脚本把快照的精确执行时间追加到 `timeline.txt`；`timeline.md` 是供双方补记测试事件的时间表，两者都要保留。

## 停止采集和归档

双方正常退出 Warcraft 与 11 平台，等 11 的本轮日志写入后，各自在管理员 PowerShell 执行 Stop。

房主：

```powershell
.\scripts\11-platform-capture.ps1 -Action Stop -Role host
```

加入者：

```powershell
.\scripts\11-platform-capture.ps1 -Action Stop -Role guest
```

若日志目录不是默认位置，加入 `-LogRoot '实际日志父目录'`。脚本会停止 Pktmon，把 ETL 转为 `.pcapng`，保存结束快照，并显示最近更新的 11 日志目录。**确认显示的确实是本轮会话后再按 Enter 复制**；不正确就输入 `n`，之后手工复制正确目录到本次归档下的 `11-platform-logs`。

每台电脑的材料在桌面 `11PlatformNetTest\<时间>-<角色>` 下，主要包括：

- `<角色>.etl` 与 `<角色>.pcapng`
- `timeline.md` 与 `timeline.txt`
- 网卡、Pktmon 组件和进程清单
- 各阶段 TCP/UDP 端点与进程快照 CSV
- 本轮 11 平台完整日志目录（脚本成功识别并确认复制时）

分享前请将房主与加入者归档分别压缩并标明 `host`、`guest`。抓包和日志可能含有公网 IP、局域网 IP、DNS 查询、设备信息、账号标识和房间信息；不要公开上传，先通过可信渠道交付，并在分享前检查隐私字段。

## 常见情况

- **提示不是管理员**：关闭当前 PowerShell，从开始菜单右键 PowerShell，选择“以管理员身份运行”，再执行脚本。
- **提示找不到活动抓包记录**：确认 Start 与 Stop 的 `-Role` 一致，并且使用同一 Windows 账号。
- **提示 Pktmon 已在运行/不能启动**：不要直接执行 `pktmon stop`，这可能停止其他诊断任务。先记录提示，确认现有采集用途。
- **没有自动找到 11 日志**：使用 `-LogRoot` 指向日志父目录，或手动把本轮完整日志目录复制进归档。
- **pcapng 里看到重复包**：Pktmon 会在网络栈多个组件位置观察数据包；这不一定代表线上重复发送。保留 ETL、组件清单和阶段时间一起分析。
- **不需要额外打开防火墙端口或安装服务**：采集只在本机进行，不更改 11、Warcraft、防火墙或路由器设置。

## 测试完成后提交给分析者

房主和加入者各自提供完整归档，并补充以下信息：

1. 11 对战平台和 Warcraft 版本、Windows 版本。
2. 所在地区、运营商、接入方式、是否使用 VPN；账号可匿名标为 A/B。
3. `timeline.md` 中的阶段时间和现象，特别是加入/掉线时间。
4. 是否出现重复局域网房间、房间显示数量、尝试加入结果和错误提示。
5. 正常进入游戏时是否完成 3–5 分钟对局，双方观察到的卡顿/掉线情况。


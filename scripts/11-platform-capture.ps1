param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Start', 'Snapshot', 'Stop')]
    [string]$Action,

    [ValidateSet('host', 'guest')]
    [string]$Role,

    [string]$Phase,

    [string]$LogRoot = 'E:\010-games\014-11对战\5211platform\yybins\log'
)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$outputRoot = Join-Path $desktop '11PlatformNetTest'
$stateRoot = Join-Path $env:LOCALAPPDATA '11PlatformNetTest'
New-Item -ItemType Directory -Force -Path $outputRoot, $stateRoot | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请以管理员身份打开 PowerShell 后运行此脚本。'
}

$pktmon = Get-Command pktmon.exe -ErrorAction SilentlyContinue
if (-not $pktmon) { throw '找不到 pktmon.exe。请确认 Windows 版本支持 Pktmon。' }

function Invoke-Pktmon {
    param([string[]]$Arguments)
    & $pktmon.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pktmon $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE。"
    }
}

function Get-ProcessSnapshot {
    param([string]$Destination)
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '5211|War3|VirtualGame|GameRoom|Vpn' } |
        Select-Object ProcessName, Id, Path |
        Export-Csv -LiteralPath $Destination -NoTypeInformation -Encoding UTF8
}

function Save-NetworkSnapshot {
    param([string]$Directory, [string]$Name)
    $safeName = $Name -replace '[^A-Za-z0-9_-]', '-'
    $prefix = Join-Path $Directory $safeName

    Get-NetTCPConnection -ErrorAction SilentlyContinue |
        Select-Object State, LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess |
        Export-Csv -LiteralPath "$prefix-tcp.csv" -NoTypeInformation -Encoding UTF8

    Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, LocalPort, OwningProcess |
        Export-Csv -LiteralPath "$prefix-udp.csv" -NoTypeInformation -Encoding UTF8

    Get-ProcessSnapshot -Destination "$prefix-processes.csv"
    "$(Get-Date -Format o) | $Name" | Add-Content -LiteralPath (Join-Path $Directory 'timeline.txt') -Encoding UTF8
    Write-Host "已保存网络端点和进程快照：$prefix-*"
}

function Get-SessionDirectory {
    param([string]$RoleName)
    $marker = Join-Path $stateRoot "active-$RoleName.txt"
    if (-not (Test-Path -LiteralPath $marker)) {
        throw "没有找到 $RoleName 的活动抓包记录。请确认 Start 与 Stop 使用相同角色和 Windows 账号。"
    }
    $directory = (Get-Content -LiteralPath $marker -Raw).Trim()
    $resolved = [IO.Path]::GetFullPath($directory)
    $rootResolved = [IO.Path]::GetFullPath($outputRoot).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($rootResolved, [StringComparison]::OrdinalIgnoreCase)) {
        throw '活动抓包目录不在固定输出目录下，已停止以避免操作其他文件。'
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "抓包目录不存在：$resolved"
    }
    return $resolved
}

function Find-LatestPlatformLogDirectory {
    if (-not (Test-Path -LiteralPath $LogRoot -PathType Container)) { return $null }
    $latestFile = Get-ChildItem -LiteralPath $LogRoot -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latestFile) { return $null }

    $candidate = $latestFile.Directory
    while ($candidate.Parent -and $candidate.Parent.FullName.TrimEnd('\') -ne $LogRoot.TrimEnd('\')) {
        $candidate = $candidate.Parent
    }
    if ($candidate.Parent -and $candidate.Parent.FullName.TrimEnd('\') -eq $LogRoot.TrimEnd('\')) {
        return $candidate.FullName
    }
    if ($latestFile.Directory.FullName.TrimEnd('\') -ne $LogRoot.TrimEnd('\')) {
        return $latestFile.Directory.FullName
    }
    return $null
}

if ($Action -ne 'Start' -and -not $Role) {
    $Role = Read-Host '请输入角色 host（房主）或 guest（加入者）'
    if ($Role -notin @('host', 'guest')) { throw '角色只能是 host 或 guest。' }
}

switch ($Action) {
    'Start' {
        if (-not $Role) {
            $Role = Read-Host '请输入角色 host（房主）或 guest（加入者）'
            if ($Role -notin @('host', 'guest')) { throw '角色只能是 host 或 guest。' }
        }
        $marker = Join-Path $stateRoot "active-$Role.txt"
        if (Test-Path -LiteralPath $marker) {
            throw "$Role 已有活动抓包。请先用 -Action Stop -Role $Role 完成归档。"
        }

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $sessionDirectory = Join-Path $outputRoot "$stamp-$Role"
        if (Test-Path -LiteralPath $sessionDirectory) {
            throw "归档目录已存在，未覆盖：$sessionDirectory"
        }
        New-Item -ItemType Directory -Force -Path $sessionDirectory | Out-Null
        Set-Content -LiteralPath $marker -Value $sessionDirectory -Encoding UTF8

        try {
            Get-NetAdapter | Format-Table -AutoSize | Out-File (Join-Path $sessionDirectory 'network-adapters.txt') -Encoding UTF8
            & pktmon.exe list 2>&1 | Out-File (Join-Path $sessionDirectory 'pktmon-components.txt') -Encoding UTF8
            Get-ProcessSnapshot -Destination (Join-Path $sessionDirectory 'processes-start.csv')
            $guidePath = Join-Path $PSScriptRoot '..\docs\11-platform-two-pc-capture.md'
            if (Test-Path -LiteralPath $guidePath) {
                Copy-Item -LiteralPath $guidePath -Destination (Join-Path $sessionDirectory 'test-guide.md')
            }
            @"
Role: $Role
Computer: $env:COMPUTERNAME
Started: $(Get-Date -Format o)
Windows: $([Environment]::OSVersion.VersionString)
PowerShell: $($PSVersionTable.PSVersion)
Platform log root: $LogRoot
"@ | Set-Content -LiteralPath (Join-Path $sessionDirectory 'capture-info.txt') -Encoding UTF8

            @"
| 阶段 | 时间（含时区） | 现象/备注 |
|---|---|---|
| 开始抓包 | $(Get-Date -Format o) | $Role |
| 登录 11 |  |  |
| 创建/加入平台房间 |  |  |
| 魔兽房主建图 |  |  |
| 加入者点击加入 |  |  |
| 进入游戏 |  |  |
| 卡顿/断线 |  |  |
| 正常退出 |  |  |
"@ | Set-Content -LiteralPath (Join-Path $sessionDirectory 'timeline.md') -Encoding UTF8

            $etlPath = Join-Path $sessionDirectory "$Role.etl"
            Invoke-Pktmon -Arguments @('start', '--capture', '--pkt-size', '0', '--file-name', $etlPath)
            Save-NetworkSnapshot -Directory $sessionDirectory -Name 'snapshot-start'
            Write-Host "抓包已开始。归档目录：$sessionDirectory" -ForegroundColor Green
            Write-Host "结束后运行：.\11-platform-capture.ps1 -Action Stop -Role $Role"
        }
        catch {
            Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
            throw
        }
    }

    'Snapshot' {
        if (-not $Phase) { $Phase = Read-Host '输入阶段标签，例如 room-created、warcraft-hosting、in-game' }
        if (-not $Phase -or $Phase -notmatch '^[A-Za-z0-9_-]+$') { throw '阶段标签只能包含英文字母、数字、下划线和连字符。' }
        $sessionDirectory = Get-SessionDirectory -RoleName $Role
        Save-NetworkSnapshot -Directory $sessionDirectory -Name "snapshot-$Phase"
    }

    'Stop' {
        $sessionDirectory = Get-SessionDirectory -RoleName $Role
        Invoke-Pktmon -Arguments @('stop')
        $etlPath = Join-Path $sessionDirectory "$Role.etl"
        $pcapPath = Join-Path $sessionDirectory "$Role.pcapng"
        if (Test-Path -LiteralPath $etlPath) {
            Invoke-Pktmon -Arguments @('etl2pcap', $etlPath, '--out', $pcapPath)
        }
        else {
            Write-Warning "找不到 ETL 文件：$etlPath"
        }
        Save-NetworkSnapshot -Directory $sessionDirectory -Name 'snapshot-stop'

        $latestLogDirectory = Find-LatestPlatformLogDirectory
        if ($latestLogDirectory) {
            Write-Host "最近更新的 11 日志目录：$latestLogDirectory"
            $answer = Read-Host '复制此目录到本次归档？[Y/n]'
            if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^(y|yes)$') {
                $destination = Join-Path $sessionDirectory '11-platform-logs'
                Copy-Item -LiteralPath $latestLogDirectory -Destination $destination -Recurse
                Write-Host '11 日志已复制。'
            }
            else {
                Write-Host "请手动将本次 11 日志目录复制到：$sessionDirectory"
            }
        }
        else {
            Write-Warning "没有在日志目录中找到文件：$LogRoot"
            Write-Host "请将本次 11 日志目录复制到：$sessionDirectory"
        }

        Remove-Item -LiteralPath (Join-Path $stateRoot "active-$Role.txt") -Force -ErrorAction SilentlyContinue
        Write-Host "抓包已结束，材料位于：$sessionDirectory" -ForegroundColor Green
        Write-Host '分享前检查 pcapng、ETL 和平台日志中的 IP、账号及其他隐私信息。'
    }
}

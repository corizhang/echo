param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_.@:-]+$')]
    [string]$SshTarget,

    [ValidatePattern('^\d+[smhd]$')]
    [string]$Since = '30m',

    [ValidateSet('api', 'game-quic-relay', 'web', 'livekit', 'postgres', 'redis')]
    [string[]]$Services = @('api', 'game-quic-relay'),

    [ValidatePattern('^[~/A-Za-z0-9._-]+$')]
    [string]$RemotePath = '~/echo',

    [string]$IdentityFile,

    [switch]$Follow
)

$ErrorActionPreference = 'Stop'
$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $ssh) { throw '找不到 Windows OpenSSH 的 ssh.exe。请在 Windows 可选功能中安装 OpenSSH Client。' }

$desktop = [Environment]::GetFolderPath('Desktop')
$outputDirectory = Join-Path $desktop 'EchoServerLogs'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$serviceTag = ($Services -join '+')
$modeTag = if ($Follow) { 'follow' } else { "last-$Since" }
$outputFile = Join-Path $outputDirectory "echo-vps-$timestamp-$serviceTag-$modeTag.log"

$composeArgs = @('logs', '--no-log-prefix', "--since=$Since")
if ($Follow) {
    $composeArgs += @('--follow', '--tail=300')
}
$composeArgs += $Services
$remoteCompose = 'docker compose ' + ($composeArgs -join ' ')
$remoteCommand = "cd $RemotePath && $remoteCompose"

$sshArgs = @('-T', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2')
if ($IdentityFile) {
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        throw "SSH 私钥文件不存在：$IdentityFile"
    }
    $sshArgs += @('-i', $IdentityFile)
}
$sshArgs += @($SshTarget, $remoteCommand)

@"
Started: $(Get-Date -Format o)
SSH target: $SshTarget
Remote path: $RemotePath
Services: $($Services -join ', ')
Since: $Since
Follow: $Follow
"@ | Set-Content -LiteralPath "$outputFile.info.txt" -Encoding UTF8

Write-Host "正在通过 SSH 读取 $SshTarget 上的 Docker 日志。"
Write-Host "本地文件：$outputFile"
if ($Follow) { Write-Host '实时跟随中，按 Ctrl+C 结束；已显示的内容会同时保存到本地文件。' }

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    & $ssh.Source @sshArgs 2>&1 | ForEach-Object {
        $line = [string]$_
        [System.IO.File]::AppendAllText($outputFile, $line + "`r`n", $utf8NoBom)
        Write-Output $_
    }
    $sshExitCode = $LASTEXITCODE
}
finally {
    "Finished: $(Get-Date -Format o)" | Add-Content -LiteralPath "$outputFile.info.txt" -Encoding UTF8
}

if ($sshExitCode -ne 0) {
    Write-Warning "SSH/远端命令退出码为 $sshExitCode。请查看本地日志文件中的错误信息。"
}
else {
    Write-Host "日志已保存：$outputFile" -ForegroundColor Green
}

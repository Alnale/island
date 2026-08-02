# =============================================================================
# SMTC Reader (PowerShell 5.1 + 强类型 C# WinRT)
#
# 常驻子进程:通过 WinRT 的 GlobalSystemMediaTransportControlsSessionManager
# 读取 Windows 系统媒体会话(SMTC)中活跃平台的播放状态,响应
# system-media-bridge.ts 的 stdin 行命令,每行输出一条 JSON(Write-Output)。
#
# 为什么用 csc 编译 C#:PS 5.1 把 WinRT 集合元素包装为 System.__ComObject,
# 无法直接绑定实例方法;C# 反射同样拿到 __ComObject。直接引用 Windows 自带
# 的 WinMetadata(Windows.Media.winmd)强类型编译,在 Windows 10/11 稳定。
#
# 命令协议:
#   state                        -> 播放状态 JSON(含曲目/进度/播放状态)
#   control play|pause|next|previous -> {"accepted": <bool>}
#   control repeat-one|repeat-all|shuffle|shuffle-off -> {"accepted": false}
#                                (SMTC 无播放模式 API,如实上报不支持)
#   control seek <seconds>       -> {"accepted": <bool>}
#   quit                         -> 退出进程
#
# 注意:桥接进程以 -Mta 参数启动(PS 默认 STA 下 WinRT await 有死锁风险)。
# =============================================================================

# stdout 必须是 UTF-8:中文 Windows 默认 GBK 会导致 JSON 中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---- 编译并加载强类型 SMTC 桥接 --------------------------------------------

$bridgeDll = Join-Path ([System.IO.Path]::GetTempPath()) 'smtc-bridge.dll'
$bridgeCs = Join-Path $PSScriptRoot 'smtc-bridge.cs'

if (-not (Test-Path $bridgeCs)) {
    [Console]::Error.WriteLine('[smtc-reader] smtc-bridge.cs not found: ' + $bridgeCs)
    exit 1
}

# 每次启动都重新编译(常驻进程生命周期内只编译一次,~1s 可接受;
# 不缓存 dll,避免桥接源码更新后残留旧版)
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    $winmdDir = 'C:\Windows\System32\WinMetadata'
    # 新版 WinMD 元数据引用 .NET Core 风格 System.Runtime facade,需显式补充
    $frameworkDir = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $refSystemRuntime = Join-Path $frameworkDir 'System.Runtime.dll'
    # 引用 System32\WinMetadata 契约(Windows.Media + Windows.Foundation)。
    # 异步等待用轮询 Status/GetResults,不需要 System.Runtime.WindowsRuntime。
    $winmdRefs = @(
        "/reference:$winmdDir\Windows.Media.winmd",
        "/reference:$winmdDir\Windows.Foundation.winmd"
    )
    $compileOut = & $csc /nologo /target:library "/out:$bridgeDll" `
        "/reference:$refSystemRuntime" `
        @winmdRefs `
        $bridgeCs 2>&1
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('[smtc-reader] csc failed:')
    [Console]::Error.WriteLine(($compileOut -join "`n"))
    exit 1
}

try {
    [System.Reflection.Assembly]::LoadFrom($bridgeDll) | Out-Null
} catch {
    [Console]::Error.WriteLine('[smtc-reader] failed to load smtc-bridge.dll: ' + $_.Exception.Message)
    exit 1
}

# ---- 命令处理 ---------------------------------------------------------------

function Write-State {
    try {
        $state = [SmtcBridge]::State()
        if ($null -eq $state) {
            [Console]::WriteLine('{"sourceAppId":null,"track":null,"isPlaying":false,"position":0,"duration":0,"modeSupported":false}')
            return
        }
        [Console]::WriteLine(($state | ConvertTo-Json -Compress -Depth 3))
    } catch {
        [Console]::WriteLine('{"sourceAppId":null,"track":null,"isPlaying":false,"position":0,"duration":0,"modeSupported":false}')
    }
}

function Write-Control($action, $position) {
    try {
        $ok = [SmtcBridge]::Control($action, $position)
        [Console]::WriteLine("{`"accepted`":" + $ok.ToString().ToLower() + "}")
    } catch {
        [Console]::WriteLine('{"accepted":false}')
    }
}

# ---- 主循环 ---------------------------------------------------------------

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq 'quit') { break }

    if ($line -eq 'state') {
        Write-State
    }
    elseif ($line -like 'control *') {
        $parts = $line -split ' '
        $action = $parts[1]
        $position = ''
        if ($parts.Count -ge 3) { $position = $parts[2] }
        Write-Control $action $position
    }
}

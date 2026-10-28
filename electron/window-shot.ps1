# window-shot.ps1 — 电脑操控:窗口枚举 / 置前 / 截图(引擎 computer 工具的后端)
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-shot.ps1 -Mode list
#   ... -Mode shot  -Title <窗口标题子串> [-Hwnd <句柄>] [-Output <png>]
#   ... -Mode focus -Title <窗口标题子串> [-Hwnd <句柄>]
#   ... -Mode screen [-Output <png>]
# 输出:单个 JSON(stdout,UTF-8);ok=false 时带 error。
#
# 截图裁残根因(2026-10-22 实测):进程未声明 DPI 感知时 GetWindowRect 返回
# **逻辑像素**(150% 缩放下 380x640 窗口返回 380x640),而位图若按该尺寸
# 分配、CopyFromScreen/PrintWindow 又按物理像素绘制,实际只截到窗口左上
# 380x640 物理像素(窗口实际 570x960)——右边约 1/3、下边约 1/3 被裁掉。
# 本脚本进程内 SetProcessDpiAwarenessContext(-4)=Per-Monitor V2,坐标与
# 位图统一物理像素,任何缩放/多显示器下按窗口完整边框截取,不裁切。
param(
  [ValidateSet('list', 'shot', 'focus', 'screen')]
  [string]$Mode = 'shot',
  [string]$Title = '',
  [long]$Hwnd = 0,
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinShot {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

# DPI 感知必须在任何窗口查询之前声明(否则坐标系已定格为逻辑像素)
$dpiAware = $true
try {
  if (-not [WinShot]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    $dpiAware = [WinShot]::SetProcessDPIAware()
  }
} catch {
  $dpiAware = [WinShot]::SetProcessDPIAware()
}

function Get-VisibleWindows {
  $list = New-Object System.Collections.ArrayList
  $cb = {
    param($h, $l)
    if ([WinShot]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][WinShot]::GetWindowTextW($h, $sb, 512)
      if ($sb.Length -gt 0) {
        $r = New-Object WinShot+RECT
        [void][WinShot]::GetWindowRect($h, [ref]$r)
        $dpi = 96
        try { $dpi = [WinShot]::GetDpiForWindow($h) } catch { }
        [void]$list.Add([pscustomobject]@{
          hwnd = [long]$h; title = $sb.ToString()
          x = $r.L; y = $r.T; width = ($r.R - $r.L); height = ($r.B - $r.T)
          dpi = $dpi; minimized = [WinShot]::IsIconic($h)
        })
      }
    }
    return $true
  }
  [void][WinShot]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Resolve-TargetWindow($wins) {
  if ($Hwnd -ne 0) {
    $t = $wins | Where-Object { $_.hwnd -eq $Hwnd } | Select-Object -First 1
    if (-not $t) { throw "未找到句柄为 $Hwnd 的可见窗口" }
    return $t
  }
  if (-not $Title) { throw '需要 -Title(标题子串)或 -Hwnd(窗口句柄)' }
  $t = $wins | Where-Object { $_.title -like "*$Title*" } | Select-Object -First 1
  if (-not $t) {
    $titles = ($wins | ForEach-Object { $_.title }) -join ' / '
    throw "未找到标题含「$Title」的可见窗口。当前可见窗口:$titles"
  }
  return $t
}

# 窗口截图:PrintWindow(PW_RENDERFULLCONTENT=2,被遮挡也拿得到完整渲染)
# 优先;疑似黑屏回退桌面 BitBlt(窗口已置前);最后裁掉 Win10+ 隐形
# 调整边框(可见边框 = DWMWA_EXTENDED_FRAME_BOUNDS),得到"窗口原样"。
function Save-WindowShot($win, $outPath) {
  $wr = New-Object WinShot+RECT
  [void][WinShot]::GetWindowRect($win.hwnd, [ref]$wr)
  $w = $wr.R - $wr.L; $ht = $wr.B - $wr.T
  if ($w -le 0 -or $ht -le 0) { throw "窗口矩形无效 ${w}x${ht}" }

  # 最小化则还原,置前(截图不完全依赖前台,但 BitBlt 兜底需要)
  if ([WinShot]::IsIconic($win.hwnd)) { [void][WinShot]::ShowWindow($win.hwnd, 9) }
  [void][WinShot]::SetForegroundWindow($win.hwnd)
  [void][WinShot]::BringWindowToTop($win.hwnd)
  Start-Sleep -Milliseconds 150

  # 置前后窗口位置可能变化,重取矩形
  [void][WinShot]::GetWindowRect($win.hwnd, [ref]$wr)
  $w = $wr.R - $wr.L; $ht = $wr.B - $wr.T

  $bmp = New-Object System.Drawing.Bitmap([int]$w, [int]$ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $hdc = $g.GetHdc()
    $ok = [WinShot]::PrintWindow($win.hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    if (-not $ok) {
      $g.CopyFromScreen($wr.L, $wr.T, 0, 0, (New-Object System.Drawing.Size([int]$w, [int]$ht)))
    } else {
      # 疑似全黑(GPU 合成窗口 PrintWindow 偶发黑帧)→ 桌面截取兜底
      $samples = @(
        $bmp.GetPixel([int]($w / 2), [int]($ht / 2)),
        $bmp.GetPixel([int]($w / 4), [int]($ht / 4)),
        $bmp.GetPixel([int]($w * 3 / 4), [int]($ht * 3 / 4))
      )
      if (($samples | Where-Object { $_.ToArgb() -eq -16777216 }).Count -eq $samples.Count) {
        $g.CopyFromScreen($wr.L, $wr.T, 0, 0, (New-Object System.Drawing.Size([int]$w, [int]$ht)))
      }
    }
  } finally {
    $g.Dispose()
  }

  # 裁到可见边框(DWM 扩展框架边界 = 不含 Win10+ 隐形调整边框)
  $ext = New-Object WinShot+RECT
  $haveExt = ([WinShot]::DwmGetWindowAttribute($win.hwnd, 9, [ref]$ext, 16) -eq 0)
  if ($haveExt) {
    $dx = $ext.L - $wr.L; $dy = $ext.T - $wr.T
    $cw = $ext.R - $ext.L; $ch = $ext.B - $ext.T
    $inside = $dx -ge 0 -and $dy -ge 0 -and $cw -gt 0 -and $ch -gt 0 -and ($dx + $cw) -le $w -and ($dy + $ch) -le $ht
    $smaller = $cw -lt $w -or $ch -lt $ht -or $dx -gt 0 -or $dy -gt 0
    if ($inside -and $smaller) {
      $rect = New-Object System.Drawing.Rectangle([int]$dx, [int]$dy, [int]$cw, [int]$ch)
      $crop = $bmp.Clone($rect, $bmp.PixelFormat)
      $bmp.Dispose()
      $bmp = $crop
    }
  }

  $dir = Split-Path -Parent $outPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $fw = $bmp.Width; $fh = $bmp.Height
  $bytes = (Get-Item $outPath).Length
  $bmp.Dispose()
  return @{ width = [int]$fw; height = [int]$fh; bytes = [int]$bytes }
}

try {
  $wins = Get-VisibleWindows

  if ($Mode -eq 'list') {
    # -InputObject 保数组形状(空→[],单元素→[{}]——管道形式两者都退化)
    Write-Output (ConvertTo-Json -InputObject @($wins) -Depth 5 -Compress)
    exit 0
  }

  if ($Mode -eq 'screen') {
    if (-not $Output) { throw 'screen 模式需要 -Output(输出 png 路径)' }
    $vsL = [WinShot]::GetSystemMetrics(76); $vsT = [WinShot]::GetSystemMetrics(77)
    $vsW = [WinShot]::GetSystemMetrics(78); $vsH = [WinShot]::GetSystemMetrics(79)
    $bmp = New-Object System.Drawing.Bitmap([int]$vsW, [int]$vsH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($vsL, $vsT, 0, 0, (New-Object System.Drawing.Size([int]$vsW, [int]$vsH)))
    } finally {
      $g.Dispose()
    }
    $dir = Split-Path -Parent $Output
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $info = Get-Item $Output
    Write-Output ([pscustomobject]@{
      ok = $true; mode = 'screen'
      x = [int]$vsL; y = [int]$vsT; width = [int]$vsW; height = [int]$vsH
      output = $info.FullName; bytes = [int]$info.Length; dpiAware = $dpiAware
    } | ConvertTo-Json -Depth 5 -Compress)
    exit 0
  }

  $target = Resolve-TargetWindow $wins

  if ($Mode -eq 'focus') {
    if ([WinShot]::IsIconic($target.hwnd)) { [void][WinShot]::ShowWindow($target.hwnd, 9) }
    [void][WinShot]::SetForegroundWindow($target.hwnd)
    [void][WinShot]::BringWindowToTop($target.hwnd)
    Write-Output ([pscustomobject]@{
      ok = $true; mode = 'focus'; hwnd = $target.hwnd; title = $target.title
    } | ConvertTo-Json -Depth 5 -Compress)
    exit 0
  }

  # shot
  if (-not $Output) { throw 'shot 模式需要 -Output(输出 png 路径)' }
  $meta = Save-WindowShot $target $Output
  $info = Get-Item $Output
  Write-Output ([pscustomobject]@{
    ok = $true; mode = 'shot'; hwnd = $target.hwnd; title = $target.title
    width = $meta.width; height = $meta.height
    output = $info.FullName; bytes = [int]$info.Length; dpiAware = $dpiAware
  } | ConvertTo-Json -Depth 5 -Compress)
  exit 0
} catch {
  Write-Output ([pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress)
  exit 1
}

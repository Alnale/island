# 系统主音量 读取/设置(2026-08-10,LLM 工具 set_system_volume)
# - Action=get:输出 volume=<0-100 整数>
# - Action=set Value=<0-100>:设置后输出 volume=<设置后的实际值>
# 经 winmm waveOutGetVolume/SetVolume(低 16 位 = 左声道、高 16 位 =
# 右声道,0x0000-0xFFFF)——waveOut 映射默认渲染设备,零 COM 最稳
# (CoreAudio COM 接口方案在本机 E_NOINTERFACE 实测失败,2026-08-10)
param([string]$Action = 'get', [string]$Value = '50')

Add-Type -Namespace Posh -Name Volume -MemberDefinition @'
[DllImport("winmm.dll")]
public static extern int waveOutGetVolume(IntPtr hwo, out uint dwVolume);
[DllImport("winmm.dll")]
public static extern int waveOutSetVolume(IntPtr hwo, uint dwVolume);
'@

try {
  if ($Action -eq 'set') {
    $target = [float]$Value
    if ($target -lt 0) { $target = 0 }
    if ($target -gt 100) { $target = 100 }
    # 双声道同值(低 16 位左 + 高 16 位右)
    $v = [uint32]([Math]::Round($target / 100.0 * 65535))
    $packed = ($v -band 0xFFFF) -bor (($v -band 0xFFFF) -shl 16)
    $rc = [Posh.Volume]::waveOutSetVolume([IntPtr]::Zero, $packed)
    if ($rc -ne 0) {
      Write-Output "error=设置音量失败(winmm 错误码 $rc)"
      exit 1
    }
  }
  $now = 0
  $rc = [Posh.Volume]::waveOutGetVolume([IntPtr]::Zero, [ref]$now)
  if ($rc -ne 0) {
    Write-Output "error=读取音量失败(winmm 错误码 $rc)"
    exit 1
  }
  $left = $now -band 0xFFFF
  $level = [Math]::Round(($left / 65535.0) * 100)
  Write-Output "volume=$level"
  exit 0
} catch {
  Write-Output "error=音量操作失败: $($_.Exception.Message)"
  exit 1
}

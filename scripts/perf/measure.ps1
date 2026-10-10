<#
.SYNOPSIS
  常驻性能基线测量（实施计划 1.11）。

.DESCRIPTION
  用一个全新的临时数据目录启动 Nivlo，测量：
    1. 冷启动：从进程创建到悬浮窗可见（毫秒）；
    2. 空闲 CPU：整个进程树（主进程 + WebView2 子进程）按采样间隔统计的平均 / 峰值 CPU 占用；
    3. 内存：进程树的工作集（MB），起点、终点与增长百分比。
  结果打印为 Markdown 表格，并把每次采样写入 CSV，方便贴进 docs/development/perf-baseline.md。

  测量的是**已安装 / Release** 构建（`pnpm tauri build --no-bundle` 产出的 nivlo-desktop.exe），
  Debug 构建的数字没有参考价值。

.PARAMETER Exe
  nivlo-desktop.exe 的路径，默认是 target\release\nivlo-desktop.exe。

.PARAMETER Minutes
  空闲采样时长（分钟），默认 10。8 小时长稳测试传 480。

.PARAMETER IntervalSeconds
  采样间隔（秒），默认 10。

.PARAMETER OutCsv
  逐次采样结果的 CSV 输出路径。

.EXAMPLE
  powershell -File scripts\perf\measure.ps1 -Minutes 10
#>
param(
  [string]$Exe = (Join-Path $PSScriptRoot "..\..\target\release\nivlo-desktop.exe"),
  [double]$Minutes = 10,
  [int]$IntervalSeconds = 10,
  [string]$OutCsv = (Join-Path $env:TEMP "nivlo-perf.csv")
)

$ErrorActionPreference = "Stop"
$Exe = (Resolve-Path $Exe).Path

Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class NivloWin {
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  // 进程是否已有一个可见的 Tauri 顶层窗口（悬浮窗）。
  public static bool HasVisibleWindow(uint pid) {
    bool found = false;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var c = new StringBuilder(100); GetClassName(h, c, 100);
        if (c.ToString() == "Tauri Window") found = true;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# 进程树：主进程 + 它的所有后代（WebView2 的 msedgewebview2.exe 是子进程）。
function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($rootPid)
  do {
    $before = $ids.Count
    foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } }
  } while ($ids.Count -ne $before)
  return $ids
}

# 进程树的 CPU 累计时间（秒）与工作集（MB）。
function Get-Usage([int]$rootPid) {
  $cpu = 0.0; $mem = 0.0
  foreach ($id in (Get-Tree $rootPid)) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { $cpu += $p.TotalProcessorTime.TotalSeconds; $mem += $p.WorkingSet64 / 1MB }
  }
  return [pscustomobject]@{ Cpu = $cpu; MemMb = $mem }
}

$dataDir = Join-Path $env:TEMP ("nivlo-perf-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory $dataDir | Out-Null
$env:NIVLO_DATA_DIR = $dataDir
# 首次运行的「开机自启」询问是模态对话框，会打断自动化测量；用环境变量跳过（不会记录「已询问」）。
$env:NIVLO_SKIP_FIRST_RUN_PROMPTS = "1"

$startedAt = Get-Date
$proc = Start-Process $Exe -PassThru -WindowStyle Hidden
$visibleMs = $null
for ($i = 0; $i -lt 600; $i++) {
  if ([NivloWin]::HasVisibleWindow([uint32]$proc.Id)) { $visibleMs = [int]((Get-Date) - $startedAt).TotalMilliseconds; break }
  Start-Sleep -Milliseconds 20
}
Write-Host "cold start -> floating window visible: $visibleMs ms"

# 等 WebView2 与首次渲染安静下来，再开始空闲采样。
Start-Sleep -Seconds 15

$cores = [Environment]::ProcessorCount
$rows = @()
$prev = Get-Usage $proc.Id
$prevAt = Get-Date
$first = $prev
$samples = [int][math]::Ceiling($Minutes * 60 / $IntervalSeconds)
for ($n = 1; $n -le $samples; $n++) {
  Start-Sleep -Seconds $IntervalSeconds
  $now = Get-Usage $proc.Id
  $nowAt = Get-Date
  $elapsed = ($nowAt - $prevAt).TotalSeconds
  $cpuPct = 100.0 * ($now.Cpu - $prev.Cpu) / ($elapsed * $cores)
  $rows += [pscustomobject]@{ T = $n * $IntervalSeconds; CpuPct = [math]::Round($cpuPct, 3); MemMb = [math]::Round($now.MemMb, 1) }
  $prev = $now; $prevAt = $nowAt
}
$rows | Export-Csv $OutCsv -NoTypeInformation

$avg = ($rows | Measure-Object CpuPct -Average).Average
$max = ($rows | Measure-Object CpuPct -Maximum).Maximum
$memStart = $rows[0].MemMb
$memEnd = $rows[-1].MemMb
$growth = if ($memStart -gt 0) { 100.0 * ($memEnd - $memStart) / $memStart } else { 0 }

Write-Host ""
Write-Host "| 指标 | 结果 |"
Write-Host "|---|---|"
Write-Host ("| 冷启动到悬浮窗可见 | {0} ms |" -f $visibleMs)
Write-Host ("| 空闲 CPU（{0} 分钟，{1} 核，进程树）平均 / 峰值 | {2:N3}% / {3:N3}% |" -f $Minutes, $cores, $avg, $max)
Write-Host ("| 内存（进程树工作集）起 / 终 / 增长 | {0:N1} MB / {1:N1} MB / {2:N1}% |" -f $memStart, $memEnd, $growth)
Write-Host "采样明细：$OutCsv"

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue

# 真实的 OLE 拖放，供 e2e.mjs --native 使用。数据对象可以是文件列表（CF_HDROP，资源管理器拖文件）、
# 纯文本（CF_UNICODETEXT，编辑器里拖选中的文字）或链接（UniformResourceLocatorW + 文本，浏览器拖链接）。
#
# 在 (FromX, FromY) 放一个小窗口，真实左键在它上面按下后调用 DoDragDrop；另一个线程用真实光标
# 把拖动带到 (ToX, ToY) 并松开左键。坐标是物理像素。输出 DoDragDrop 的结果（None 表示目标拒绝）。
param(
  [string[]]$Files,
  [string]$Text,
  [string]$Url,
  [string]$LandingFile,
  [Parameter(Mandatory = $true)][int]$FromX,
  [Parameter(Mandatory = $true)][int]$FromY,
  [Parameter(Mandatory = $true)][int]$ToX,
  [Parameter(Mandatory = $true)][int]$ToY
)

Add-Type -AssemblyName PresentationFramework
Add-Type -Namespace E2EDrag -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT point);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr handle, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr handle, System.IntPtr insertAfter, int x, int y, int w, int h, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr handle, out uint process);
public struct POINT { public int X; public int Y; }
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
[void][E2EDrag.Mouse]::SetProcessDPIAware()

$data = New-Object Windows.DataObject
if ($Files) {
  $list = New-Object System.Collections.Specialized.StringCollection
  foreach ($file in $Files) { [void]$list.Add($file) }
  $data.SetFileDropList($list)
}
if ($Url) {
  # 浏览器拖链接时给的格式：以 NUL 结尾的 UTF-16 网址，同时附带纯文本。
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($Url + [char]0)
  $data.SetData("UniformResourceLocatorW", (New-Object System.IO.MemoryStream(,$bytes)))
  $data.SetText($Url, [Windows.TextDataFormat]::UnicodeText)
}
if ($Text) {
  $data.SetText($Text, [Windows.TextDataFormat]::UnicodeText)
}

$form = New-Object Windows.Window
$form.WindowStyle = 'None'
$form.ResizeMode = 'NoResize'
$form.Width = 40
$form.Height = 40
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.WindowStartupLocation = 'Manual'
$form.Content = New-Object Windows.Controls.Border
$form.Tag = $data
$script:result = 'NotStarted'
$form.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)
    $effects = [Windows.DragDropEffects]::Copy -bor [Windows.DragDropEffects]::Link -bor [Windows.DragDropEffects]::Move
    $script:result = [Windows.DragDrop]::DoDragDrop($sender, $sender.Tag, $effects)
    $sender.Close()
  })

# 另一个线程驱动真实光标：DoDragDrop 在窗口线程上是模态的。
$script:mover = [PowerShell]::Create().AddScript({
    param($fromX, $fromY, $toX, $toY, $source, $landingFile)
    Start-Sleep -Milliseconds 400
    [void][E2EDrag.Mouse]::SetCursorPos($fromX, $fromY)
    Start-Sleep -Milliseconds 100
    $cursor = New-Object E2EDrag.Mouse+POINT
    [void][E2EDrag.Mouse]::GetCursorPos([ref]$cursor)
    $hit = [E2EDrag.Mouse]::WindowFromPoint($cursor)
    $owner = 0
    [void][E2EDrag.Mouse]::GetWindowThreadProcessId($hit, [ref]$owner)
    $processName = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
    "cursor=$($cursor.X),$($cursor.Y); hit=$hit ($processName)"
    if ($hit -ne $source) { return }
    [E2EDrag.Mouse]::mouse_event(0x2, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
    $steps = 24
    for ($i = 1; $i -le $steps; $i++) {
      $x = [int]($fromX + ($toX - $fromX) * $i / $steps)
      $y = [int]($fromY + ($toY - $fromY) * $i / $steps)
      [void][E2EDrag.Mouse]::SetCursorPos($x, $y)
      # 零位移的 MOVE 产生一条真实的鼠标输入，OLE 的拖放循环据此更新目标。
      [E2EDrag.Mouse]::mouse_event(0x1, 0, 0, 0, [System.UIntPtr]::Zero)
      Start-Sleep -Milliseconds 30
    }
    # 徽标展开后，测试端用 DOM 测量用户选中的放置区。
    if ($landingFile) {
      for ($i = 0; $i -lt 100 -and -not (Test-Path -LiteralPath $landingFile); $i++) {
        [E2EDrag.Mouse]::mouse_event(0x1, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 50
      }
      if (Test-Path -LiteralPath $landingFile) {
        $landing = Get-Content -LiteralPath $landingFile -Raw | ConvertFrom-Json
        [void][E2EDrag.Mouse]::SetCursorPos($landing.x, $landing.y)
      }
    }
    # 在目标上停一会儿（DragOver 之后页面才会显示可放下），再松开。
    for ($i = 0; $i -lt 10; $i++) {
      [E2EDrag.Mouse]::mouse_event(0x1, 0, 0, 0, [System.UIntPtr]::Zero)
      Start-Sleep -Milliseconds 50
    }
    [E2EDrag.Mouse]::mouse_event(0x4, 0, 0, 0, [System.UIntPtr]::Zero)
  })
$script:handle = $null
$script:sourceTrace = ''
$form.Add_Loaded({
  param($sender, $eventArgs)
  $source = (New-Object Windows.Interop.WindowInteropHelper($sender)).Handle
  [void][E2EDrag.Mouse]::SetWindowPos($source, [IntPtr](-1), ($FromX - 20), ($FromY - 20), 40, 40, 0x40)
  [void]$sender.Activate()
  $bounds = New-Object E2EDrag.Mouse+RECT
  [void][E2EDrag.Mouse]::GetWindowRect($source, [ref]$bounds)
  $fromCenterX = [int](($bounds.Left + $bounds.Right) / 2)
  $fromCenterY = [int](($bounds.Top + $bounds.Bottom) / 2)
  $script:sourceTrace = "source=$source; bounds=$($bounds.Left),$($bounds.Top),$($bounds.Right),$($bounds.Bottom)"
  [void]$script:mover.AddArgument($fromCenterX).AddArgument($fromCenterY).AddArgument($ToX).AddArgument($ToY).AddArgument($source).AddArgument($LandingFile)
  $script:handle = $script:mover.BeginInvoke()
})

# 万一拖放没有开始（按键没落在窗口上），10 秒后自己关掉，不让测试挂住。
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(10)
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
$trace = if ($null -ne $script:handle) { $script:mover.EndInvoke($script:handle) }
$driverErrors = $script:mover.Streams.Error | Out-String
$script:mover.Dispose()
if ($script:result -eq 'NotStarted') {
  [Console]::Error.WriteLine("OLE requested=$FromX,$FromY; $script:sourceTrace; $trace; $driverErrors")
}
$script:result

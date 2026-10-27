# 真实的 OLE 拖放，供 e2e.mjs --native 使用。数据对象可以是文件列表（CF_HDROP，资源管理器拖文件）、
# 纯文本（CF_UNICODETEXT，编辑器里拖选中的文字）或链接（UniformResourceLocatorW + 文本，浏览器拖链接）。
#
# 在 (FromX, FromY) 放一个小窗口，真实左键在它上面按下后调用 DoDragDrop；另一个线程用真实光标
# 把拖动带到 (ToX, ToY) 并松开左键。坐标是物理像素。输出 DoDragDrop 的结果（None 表示目标拒绝）。
param(
  [string[]]$Files,
  [string]$Text,
  [string]$Url,
  [Parameter(Mandatory = $true)][int]$FromX,
  [Parameter(Mandatory = $true)][int]$FromY,
  [Parameter(Mandatory = $true)][int]$ToX,
  [Parameter(Mandatory = $true)][int]$ToY
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace E2EDrag -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[void][E2EDrag.Mouse]::SetProcessDPIAware()

$data = New-Object System.Windows.Forms.DataObject
if ($Files) {
  $list = New-Object System.Collections.Specialized.StringCollection
  foreach ($file in $Files) { [void]$list.Add($file) }
  $data.SetFileDropList($list)
}
if ($Url) {
  # 浏览器拖链接时给的格式：以 NUL 结尾的 UTF-16 网址，同时附带纯文本。
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($Url + [char]0)
  $data.SetData("UniformResourceLocatorW", (New-Object System.IO.MemoryStream(,$bytes)))
  $data.SetText($Url, [System.Windows.Forms.TextDataFormat]::UnicodeText)
}
if ($Text) {
  $data.SetText($Text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Bounds = New-Object System.Drawing.Rectangle(($FromX - 20), ($FromY - 20), 40, 40)
$script:result = 'NotStarted'
$form.Add_MouseDown({
    $effects = [System.Windows.Forms.DragDropEffects]::Copy -bor [System.Windows.Forms.DragDropEffects]::Link -bor [System.Windows.Forms.DragDropEffects]::Move
    $script:result = $form.DoDragDrop($data, $effects)
    $form.Close()
  })

# 另一个线程驱动真实光标：DoDragDrop 在窗口线程上是模态的。
$mover = [PowerShell]::Create().AddScript({
    param($fromX, $fromY, $toX, $toY)
    Start-Sleep -Milliseconds 400
    [void][E2EDrag.Mouse]::SetCursorPos($fromX, $fromY)
    Start-Sleep -Milliseconds 100
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
    # 在目标上停一会儿（DragOver 之后页面才会显示可放下），再松开。
    for ($i = 0; $i -lt 10; $i++) {
      [E2EDrag.Mouse]::mouse_event(0x1, 0, 0, 0, [System.UIntPtr]::Zero)
      Start-Sleep -Milliseconds 50
    }
    [E2EDrag.Mouse]::mouse_event(0x4, 0, 0, 0, [System.UIntPtr]::Zero)
  }).AddArgument($FromX).AddArgument($FromY).AddArgument($ToX).AddArgument($ToY)
$handle = $mover.BeginInvoke()

# 万一拖放没有开始（按键没落在窗口上），10 秒后自己关掉，不让测试挂住。
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
$mover.EndInvoke($handle) | Out-Null
$mover.Dispose()
$script:result

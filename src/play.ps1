# Play one audio file and wait until it ends, fails or times out.
#
# Exit codes (player.js turns them into Chinese messages):
#   0  played to the end
#   1  unexpected exception
#   2  MediaFailed (format / codec / decoder problem)
#   3  timed out
#   4  file missing or could not be opened
#   5  playback flow did not finish normally
#
# Keep everything here ASCII: Windows PowerShell reads BOM-less .ps1 files in the
# system code page, and non-ASCII comments can break the parser on some locales.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Volume = 80,
  [int]$TimeoutMs = 120000
)

$ErrorActionPreference = 'Stop'
$exitCode = 0
$detail = ''
$player = $null
$timer = $null
$frame = $null

if (-not [System.IO.File]::Exists($Path)) {
  [Console]::Error.WriteLine('file-not-found')
  exit 4
}
if ($TimeoutMs -lt 1000) { $TimeoutMs = 1000 }
if ($Volume -lt 0) { $Volume = 0 }
if ($Volume -gt 100) { $Volume = 100 }

try {
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase

  $player = New-Object System.Windows.Media.MediaPlayer
  $player.Volume = $Volume / 100.0
  $script:opened = $false
  $script:ended = $false
  $script:failed = ''
  $script:timedOut = $false

  $frame = New-Object System.Windows.Threading.DispatcherFrame

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds($TimeoutMs)
  $timer.add_Tick({
    $script:timedOut = $true
    $timer.Stop()
    $frame.Continue = $false
  })

  $player.add_MediaOpened({
    $script:opened = $true
    $player.Play()
  })
  $player.add_MediaEnded({
    $script:ended = $true
    $timer.Stop()
    $frame.Continue = $false
  })
  $player.add_MediaFailed({
    param($sender, $args)
    $script:failed = [string]$args.ErrorException.Message
    $timer.Stop()
    $frame.Continue = $false
  })

  $timer.Start()
  $player.Open([Uri]$Path)
  [System.Windows.Threading.Dispatcher]::PushFrame($frame)
  $timer.Stop()

  if ($script:failed) {
    $exitCode = 2
    $detail = 'media-failed: ' + $script:failed
  } elseif ($script:timedOut) {
    $exitCode = 3
    $detail = 'timed-out'
  } elseif (-not $script:opened) {
    $exitCode = 4
    $detail = 'open-failed'
  } elseif (-not $script:ended) {
    $exitCode = 5
    $detail = 'not-ended'
  }
} catch {
  $exitCode = 1
  $detail = 'exception: ' + [string]$_.Exception.Message
} finally {
  if ($timer) {
    try { $timer.Stop() } catch { }
  }
  if ($player) {
    try { $player.Close() } catch { }
  }
}

if ($detail) { [Console]::Error.WriteLine($detail) }
exit $exitCode

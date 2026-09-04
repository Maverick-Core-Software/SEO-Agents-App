# Breakaway start for thumbtack-worker. Do not use Grok background jobs or
# unelevated `pm2` (that forks a stray daemon on this PC).
$ErrorActionPreference = 'Stop'
$root = 'D:\Workspace\Active\SEO-Agents-App'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(node|cmd)\.exe$' -and $_.CommandLine -match 'scripts\\thumbtack-worker\.mjs'
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
$node = 'C:\Program Files\nodejs\node.exe'
$cmd = 'cmd.exe /c ""' + $node + '" "' + (Join-Path $root 'scripts\thumbtack-worker.mjs') + '" >> "' + (Join-Path $logDir 'thumbtack-worker.log') + '" 2>&1"'
$r = ([wmiclass]'Win32_Process').Create($cmd, $root)
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($r.ReturnValue)" }
Write-Output "started pid=$($r.ProcessId)"

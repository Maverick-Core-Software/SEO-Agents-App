# run-electrical-classify.ps1
# Weekly job (Grizzly-Electrical-Classify, Monday 02:00): classify new camera-roll
# photos and move the electrical ones into the GBP cache.
#
# The classifier's vision backend is whatever ELECTRICAL_VISION_URL in .env points
# at. When that is a hosted endpoint (the current setup -- OpenAI vision), this
# script just runs the classifier and touches nothing else.
#
# Only when ELECTRICAL_VISION_URL is a LOCAL address does it do the old GPU dance:
# stop local-llm, start Gemma 3 on :8082, classify, stop Gemma, restart local-llm.
# That path is now opt-in. Running it unattended fought llama-guardian for the GPU
# seat every Monday at 02:00, against a Gemma model that is not installed here.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-electrical-classify.ps1
#   ... -Backfill -Source "D:\PhotoExport\Takeout"   # one-time library sweep
#   ... -DryRun                                      # classify, copy nothing

param(
  [switch]$DryRun,
  [switch]$Backfill,
  [switch]$Delete,
  [string]$Source
)
$ErrorActionPreference = 'Continue'

$REPO      = 'C:\Workspace\Active\SEO-Agents-App'
$CLASSIFY  = Join-Path $REPO 'scripts\classify-electrical.mjs'
$LLAMA_EXE = 'C:\Workspace\Infrastructure\llama-cpp-server-cuda-b10488\llama-server.exe'
$MODEL     = 'C:\Workspace\Infrastructure\llama-cpp-server\models\google_gemma-3-12b-it-Q4_K_M.gguf'
$MMPROJ    = 'C:\Workspace\Infrastructure\llama-cpp-server\models\mmproj-google_gemma-3-12b-it-f16.gguf'
$PORT      = 8082
$LOGDIR    = 'C:\Workspace\Infrastructure\llama-cpp-server\logs'
$LOG       = Join-Path $LOGDIR 'gemma-vision-server.log'
$ERRLOG    = Join-Path $LOGDIR 'gemma-vision-server.err.log'

Write-Output "=== Electrical photo classification job  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

# Which vision backend is the classifier configured for?
$visionUrl = ''
$envFile = Join-Path $REPO '.env'
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^ELECTRICAL_VISION_URL=(.*)$' -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if ($line) { $visionUrl = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $visionUrl) { $visionUrl = 'http://127.0.0.1:8082/v1' }
$isLocalVision = $visionUrl -match '127\.0\.0\.1|localhost|::1'

Write-Output "Vision backend: $visionUrl"

function Invoke-Classifier {
  $cArgs = @($CLASSIFY)
  if ($DryRun)   { $cArgs += '--dry-run' }
  if ($Backfill) { $cArgs += '--backfill' }
  if ($Delete)   { $cArgs += '--delete' }
  if ($Source)   { $cArgs += @('--source', $Source) }
  Push-Location $REPO
  try {
    & node @cArgs
    Write-Output ("  classifier exit code: {0}" -f $LASTEXITCODE)
  } finally { Pop-Location }
}

if (-not $isLocalVision) {
  Write-Output "[1/1] Hosted vision endpoint - running classifier directly (no GPU changes)."
  Invoke-Classifier
  Write-Output "=== Done  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
  return
}

# ---- Local Gemma path (only when ELECTRICAL_VISION_URL is loopback) ----
Write-Output "[1/6] Local vision endpoint - stopping local-llm to free VRAM..."
pm2 stop local-llm 2>&1 | Out-Null
$freed = $false
for ($i = 0; $i -lt 20; $i++) {
  $listening = netstat -ano -p tcp 2>$null | Select-String "LISTENING" | Select-String ":8081 "
  if (-not $listening) { $freed = $true; break }
  Start-Sleep -Seconds 1
}
if ($freed) { Write-Output "  GPU free (port 8081 released)." }
else        { Write-Output "  WARNING: port 8081 still listening - local-llm may still hold VRAM." }

Write-Output "[2/6] Starting Gemma 3 vision server on :$PORT ..."
if (-not (Test-Path $MODEL)) {
  Write-Output "  ERROR: $MODEL not found. Point ELECTRICAL_VISION_URL at a hosted endpoint instead."
  pm2 start local-llm 2>&1 | Out-Null
  return
}
New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null
$srvArgs = @('--model',$MODEL,'--mmproj',$MMPROJ,'--host','127.0.0.1','--port',"$PORT",'--gpu-layers','99','--ctx-size','8192','--jinja','--flash-attn','on')
$proc = Start-Process -FilePath $LLAMA_EXE -ArgumentList $srvArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $LOG -RedirectStandardError $ERRLOG
Write-Output ("  pid {0}" -f $proc.Id)

Write-Output "[3/6] Waiting for vision server readiness..."
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 2
  if ($proc.HasExited) { Write-Output "  server exited early (code $($proc.ExitCode))"; break }
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/health" -UseBasicParsing -TimeoutSec 3
    if ($resp.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}
if (-not $ready) {
  Write-Output "  ERROR: vision server did not become ready. See $LOG / $ERRLOG"
} else {
  Write-Output "  ready."
  Write-Output "[4/6] Running electrical classifier..."
  Invoke-Classifier
}

Write-Output "[5/6] Stopping Gemma vision server..."
if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

Write-Output "[6/6] Restoring local-llm..."
pm2 start local-llm 2>&1 | Out-Null
Start-Sleep -Seconds 2

Write-Output "=== Done  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

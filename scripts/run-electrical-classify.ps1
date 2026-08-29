# run-electrical-classify.ps1
# 2:00 AM weekly job: free the GPU, load Gemma 3 vision, classify new iCloud photos,
# move electrical ones into the GBP cache, then restore GLM.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File run-electrical-classify.ps1 [-DryRun]

param([switch]$DryRun, [switch]$Backfill, [switch]$Delete)
$ErrorActionPreference = 'Continue'

$LLAMA_EXE = 'C:\Workspace\Infrastructure\llama-cpp-server-cuda-b10488\llama-server.exe'
$MODEL     = 'C:\Workspace\Infrastructure\llama-cpp-server\models\google_gemma-3-12b-it-Q4_K_M.gguf'
$MMPROJ    = 'C:\Workspace\Infrastructure\llama-cpp-server\models\mmproj-google_gemma-3-12b-it-f16.gguf'
$PORT      = 8082
$CLASSIFY  = 'C:\Workspace\Active\SEO-Agents-App\scripts\classify-electrical.mjs'
$LOGDIR    = 'C:\Workspace\Infrastructure\llama-cpp-server\logs'
$LOG       = Join-Path $LOGDIR 'gemma-vision-server.log'
$ERRLOG    = Join-Path $LOGDIR 'gemma-vision-server.err.log'

Write-Output "=== Electrical photo classification job  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

# 1. Free VRAM: stop GLM (guardian may have it stopped already)
Write-Output "[1/6] Stopping GLM (local-llm) to free VRAM..."
pm2 stop local-llm 2>&1 | Out-Null
$freed = $false
for ($i = 0; $i -lt 20; $i++) {
  $listening = netstat -ano -p tcp 2>$null | Select-String "LISTENING" | Select-String ":8081 "
  if (-not $listening) { $freed = $true; break }
  Start-Sleep -Seconds 1
}
if ($freed) { Write-Output "  GPU free (port 8081 released)." }
else        { Write-Output "  WARNING: port 8081 still listening - GLM may still hold VRAM." }

# 2. Start Gemma 3 vision server on :8082
Write-Output "[2/6] Starting Gemma 3 vision server on :$PORT ..."
New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null
$srvArgs = @('--model',$MODEL,'--mmproj',$MMPROJ,'--host','127.0.0.1','--port',"$PORT",'--gpu-layers','99','--ctx-size','8192','--jinja','--flash-attn','on')
$proc = Start-Process -FilePath $LLAMA_EXE -ArgumentList $srvArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $LOG -RedirectStandardError $ERRLOG
Write-Output ("  pid {0}" -f $proc.Id)

# 3. Wait for /health
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
  # 4. Run classifier
  Write-Output "[4/6] Running electrical classifier..."
  $cArgs = @($CLASSIFY)
  if ($DryRun) { $cArgs += '--dry-run' }
  if ($Backfill) { $cArgs += '--backfill' }
  if ($Delete) { $cArgs += '--delete' }
  & node @cArgs
  Write-Output ("  classifier exit code: {0}" -f $LASTEXITCODE)
}

# 5. Stop Gemma server
Write-Output "[5/6] Stopping Gemma vision server..."
if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# 6. Restore GLM
Write-Output "[6/6] Restoring GLM (local-llm)..."
pm2 start local-llm 2>&1 | Out-Null
Start-Sleep -Seconds 2

Write-Output "=== Done  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

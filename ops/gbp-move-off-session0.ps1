# Move the GBP worker off session 0 (Carter, 2026-09-25).
# Run from an ELEVATED PowerShell. Stops ONLY gbp-worker inside the session-0 pm2
# (via a one-shot S4U task, the only context that can reach that pm2's pipe), saves
# the pm2 list so a reboot does not resurrect it, then enables the interactive-session
# launcher task. Other pm2 apps (mav-bridge, fb-comment-agent, ...) are untouched.
$ErrorActionPreference = 'Stop'
$name = 'Grizzly Temp pm2 stop gbp-worker'
$cmd  = 'pm2 stop gbp-worker && pm2 save --force > "%USERPROFILE%\.pm2\gbp-move-off-session0.log" 2>&1'
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $name
Start-Sleep 20
Unregister-ScheduledTask -TaskName $name -Confirm:$false
Get-Content "$env:USERPROFILE\.pm2\gbp-move-off-session0.log" -ErrorAction SilentlyContinue
"session-0 gbp-worker (PID from state\gbp-worker.pid) alive: " + [bool](Get-Process -Id (Get-Content 'D:\Workspace\Active\SEO-Agents-App\state\gbp-worker.pid') -ErrorAction SilentlyContinue)
Enable-ScheduledTask -TaskName 'Grizzly SEO GBP Worker' | Select-Object TaskName, State

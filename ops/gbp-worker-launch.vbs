' Hidden launcher for the GBP worker. The scheduled task runs this via wscript.exe
' instead of node.exe directly, so no console window appears on the desktop (an
' accidentally-closed console killed the worker on 2026-07-10 with 0xC000013A).
' sh.Run(..., 0, True): window style 0 = hidden; True = wait, so Task Scheduler
' still sees the task as Running, IgnoreNew still blocks duplicate instances,
' and restart-on-failure still applies. Node's output goes to logs\gbp-worker.log.
Dim sh, fso, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FolderExists("C:\Workspace\Active\SEO-Agents-App\logs") Then
  fso.CreateFolder("C:\Workspace\Active\SEO-Agents-App\logs")
End If
sh.CurrentDirectory = "C:\Workspace\Active\SEO-Agents-App"
cmd = "cmd /c """"C:\Program Files\nodejs\node.exe"" ""C:\Workspace\Active\SEO-Agents-App\scripts\gbp-worker.mjs"" >> ""C:\Workspace\Active\SEO-Agents-App\logs\gbp-worker.log"" 2>&1"""
WScript.Quit sh.Run(cmd, 0, True)

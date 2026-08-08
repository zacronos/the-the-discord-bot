# Deterministic bot restart. Task Scheduler's stop doesn't reliably kill the
# launcher's child node process; a lingering bot then holds data\bot.log and
# silently blocks the next task start. This script stops the task, kills any
# leftover bot process, starts the task, and verifies the outcome.
$ErrorActionPreference = 'Stop'

try {
  Stop-ScheduledTask -TaskName 'TheTheDiscordBot' -ErrorAction Stop
} catch {
  # task not running — fine
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]index\.js' } |
  ForEach-Object {
    Write-Output "Stopping leftover bot process (pid $($_.ProcessId))..."
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 2

Start-ScheduledTask -TaskName 'TheTheDiscordBot'
Start-Sleep -Seconds 8

$state = (Get-ScheduledTask -TaskName 'TheTheDiscordBot').State
$proc = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]index\.js' }
if ($proc) {
  Write-Output "Bot running (pid $($proc.ProcessId); task state: $state)."
} else {
  Write-Error "Bot process not found after start (task state: $state). Check data\bot.log."
}

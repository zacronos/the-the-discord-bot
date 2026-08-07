# Stops and removes the auto-start task. Safe to run if it was never installed.
$ErrorActionPreference = 'Stop'
$existing = Get-ScheduledTask -TaskName 'TheTheDiscordBot' -ErrorAction SilentlyContinue
if ($existing) {
  try { Stop-ScheduledTask -TaskName 'TheTheDiscordBot' -ErrorAction Stop } catch {}
  Unregister-ScheduledTask -TaskName 'TheTheDiscordBot' -Confirm:$false
  Write-Output "Task 'TheTheDiscordBot' removed."
} else {
  Write-Output "Task 'TheTheDiscordBot' was not registered."
}

# Registers (or replaces) the user-level Task Scheduler task that starts
# The The Bot at logon. No admin rights needed; re-running replaces the task.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'scripts\start-bot.cmd'
if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path (Join-Path $repo '.env'))) {
  Write-Warning "No .env found in $repo -- the bot will not start until it exists (see README)."
}

$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:UserName
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'TheTheDiscordBot' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Task 'TheTheDiscordBot' registered: starts at logon of $env:UserName, restarts up to 3 times on failure."
Write-Output "Start it now with: Start-ScheduledTask -TaskName TheTheDiscordBot"

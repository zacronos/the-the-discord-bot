@echo off
rem The The Bot launcher (used by the Task Scheduler task). Reads secrets
rem from the gitignored .env; appends output to data\bot.log, keeping the
rem previous run as data\bot.log.1. The bot never logs its token.
rem NOTE: keep this file CRLF-terminated and ASCII-only. cmd.exe misparses
rem LF-only batch files and can execute stray comment fragments.
cd /d "%~dp0.."
if not exist data mkdir data
rem Rotation is best-effort: a lingering handle makes the move fail
rem harmlessly (node appends to the existing file), so errors are hidden.
if exist data\bot.log move /Y data\bot.log data\bot.log.1 >nul 2>&1
node --env-file=.env src/index.js >> data\bot.log 2>&1

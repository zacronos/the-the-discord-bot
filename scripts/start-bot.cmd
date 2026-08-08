@echo off
rem The The Bot launcher (used by the Task Scheduler task). Reads secrets
rem from the gitignored .env; appends output to data\bot.log, keeping the
rem previous run as data\bot.log.1. The bot never logs its token.
cd /d "%~dp0.."
if not exist data mkdir data
rem Rotation is best-effort: if a lingering handle still holds the log, the
rem move fails harmlessly (node appends to the existing file) — silence it.
if exist data\bot.log move /Y data\bot.log data\bot.log.1 >nul 2>&1
node --env-file=.env src/index.js >> data\bot.log 2>&1

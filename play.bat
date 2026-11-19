@echo off
title VECTOR ATC server
cd /d "%~dp0"
where node >nul 2>nul || goto nonode
if not exist node_modules call npm install
if not exist .env copy .env.example .env >nul
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process http://localhost:8787"
echo Starting VECTOR... keep this window open while you play.
node server.mjs
echo.
echo The server stopped. Read any error above.
pause
exit /b
:nonode
echo Node.js is not installed. Get it from https://nodejs.org and run this again.
pause

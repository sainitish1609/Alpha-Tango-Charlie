@echo off
title VECTOR on the GX10
rem Plays the game running on the GX10 (gx177). The game opens at http://localhost:8800 through an encrypted SSH tunnel,
rem so the browser treats it as local and the microphone works. Keep this window open while you play.
echo.
echo   Connecting to the GX10...
ssh -o BatchMode=yes -o ConnectTimeout=8 gx177 "systemctl --user is-active vector-atc >/dev/null || systemctl --user start vector-atc"
if errorlevel 1 (
  echo   Could not reach the GX10. Check it is on and that "ssh gx177" works.
  pause
  exit /b 1
)
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process http://localhost:8800"
echo   Connected. The game is open in your browser at http://localhost:8800
echo   Keep this window open while you play. Close it to disconnect.
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L 8800:127.0.0.1:8787 gx177
echo.
echo   Disconnected from the GX10.
pause

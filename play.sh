#!/usr/bin/env bash
# VECTOR on Linux (the GX10): makes sure the game server is running, then opens the game in the browser.
# The server itself runs as a user service (vector-atc), so it keeps going after this window closes.
cd "$(dirname "$0")"
if systemctl --user list-unit-files vector-atc.service >/dev/null 2>&1; then
  systemctl --user is-active --quiet vector-atc || systemctl --user start vector-atc
else
  # no service installed: run the server here
  export PATH="$HOME/.local/bin:$PATH"
  nohup node server.mjs > /tmp/vector.log 2>&1 &
fi
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:8787/api/health && break; sleep 0.5; done
xdg-open http://localhost:8787 >/dev/null 2>&1 &
echo "VECTOR is open at http://localhost:8787"

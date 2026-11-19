#!/usr/bin/env bash
# Copies the game from this PC to the GX10 (ssh host gx177) and restarts it there.
# The GX10 keeps its own node_modules, voice models and map tile cache.
set -euo pipefail
cd "$(dirname "$0")/.."
tar czf - --exclude=./node_modules --exclude=./asr-bench --exclude=./cache --exclude=./certs --exclude=./.env --exclude=./.session-key --exclude=./downloads --exclude=./desktop --exclude=./data/leaderboard.json --exclude=./data/replays . \
  | ssh -o BatchMode=yes gx177 'tar xzf - -C ~/Work/vector-atc && systemctl --user restart vector-atc && sleep 2 && systemctl --user is-active vector-atc'

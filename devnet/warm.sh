#!/usr/bin/env bash
# Warm the local devnet past the recap-development fork ladder and keep it moving.
# Samples the cut height; restarts the node (then the miner) when it stops increasing, and
# exits once the chain has reached TARGET and advanced across the last sample.
#   usage: devnet/warm.sh [TARGET_HEIGHT]   (default 760 per chain: past the recap-development fork ladder)
set -u
cd "$(dirname "$0")" || exit 1
TARGET="${1:-760}"
API="http://localhost:8095/chainweb/0.0/recap-development/cut"
height() { curl -s --max-time 8 "$API" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["hashes"]["1"]["height"])' 2>/dev/null || echo -1; }
last=$(height); stalls=0; restarts=0
echo "$(date +%T) start: chain-1 height $last (target $TARGET)"
while true; do
  sleep 30
  h=$(height)
  if [ "$h" -gt "$last" ] 2>/dev/null; then
    stalls=0
    if [ "$h" -ge "$TARGET" ]; then echo "$(date +%T) warm: chain-1 height $h (restarts: $restarts)"; exit 0; fi
  else
    stalls=$((stalls+1))
    echo "$(date +%T) stalled at $h (x$stalls)"
    if [ "$stalls" -ge 2 ]; then
      restarts=$((restarts+1)); stalls=0
      echo "$(date +%T) restarting node + miner (restart #$restarts)"
      docker compose restart bootstrap-node >/dev/null 2>&1; sleep 25
      docker compose restart miner >/dev/null 2>&1
    fi
  fi
  last=$h
done

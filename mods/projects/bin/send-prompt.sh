#!/bin/sh
# send-prompt.sh <terminal> <prompt-file> [timeout-seconds]
# Types a send-mode prompt into an agent that starts after a setup chain, once herdr reports it ready.
# Started detached by the projects mod (hc run --bg), so the launch popup never waits on setup.
# Exits 0 once sent, 1 when the agent is blocked or the terminal is gone, 2 on timeout (default 1800 s).
terminal=$1
file=$2
timeout=${3:-1800}
waited=0
while :; do
  if ! out=$(hc get "$terminal" --json 2>/dev/null); then exit 1; fi
  case $out in
    *'"status":"idle"'* | *'"status":"done"'*)
      hc send "$terminal" "$(cat "$file")" || exit 1
      rm -f "$file"
      exit 0 ;;
    *'"status":"blocked"'*) exit 1 ;;
  esac
  [ "$waited" -ge "$timeout" ] && exit 2
  sleep 2
  waited=$((waited + 2))
done

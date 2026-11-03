#!/bin/sh
# send-prompt.sh <terminal> <prompt-file> <agent-program> [timeout-seconds]
# Types a send-mode prompt into an agent that starts after a setup chain, once it is ready.
# Started detached by the projects mod (hc run --bg), so the launch popup never waits on setup.
# Ready: herdr reports the agent idle or done; or herdr reports no status and the agent program itself
# (hermes and other status-less agents) has held the foreground for 6 s. While the setup chain runs
# (npm, node, ...) the foreground is something else, so the prompt is never typed into setup.
# `hc get <t> --json` prints the agent status as an object, "status":{"app":"…","state":"idle"}, or
# "status":null; the terminal's own top-level "state" is live/exited, which the patterns below never match.
# Exits 0 once sent, 1 when the agent is blocked, the terminal is gone (4 failed `hc get` in a row) or the
# prompt file is empty, 2 on timeout (default 1800 s). The prompt file is removed on every exit.
terminal=$1
file=$2
agent=$3
timeout=${4:-1800}
trap 'rm -f "$file"' EXIT
[ -s "$file" ] || exit 1
waited=0
fails=0
steady=-1 # seconds the agent program has been in the foreground; -1 while it isn't
send() {
  hc send "$terminal" -- "$(cat "$file")" || exit 1
  exit 0
}
while :; do
  if out=$(hc get "$terminal" --json 2>/dev/null); then
    fails=0
    case $out in
      *'"state":"idle"'* | *'"state":"done"'*) send ;;
      *'"state":"blocked"'*) exit 1 ;;
      *'"status":{'*) steady=-1 ;;
      *)
        fg=$(printf '%s' "$out" | sed -n 's/.*"foreground":{[^}]*"name":"\([^"]*\)".*/\1/p')
        if [ -n "$agent" ] && [ "$fg" = "$agent" ]; then
          if [ "$steady" -lt 0 ]; then steady=0; else steady=$((steady + 2)); fi
        else
          steady=-1
        fi
        [ "$steady" -ge 6 ] && send ;;
    esac
  else
    fails=$((fails + 1))
    [ "$fails" -gt 3 ] && exit 1
  fi
  [ "$waited" -ge "$timeout" ] && exit 2
  sleep 2
  waited=$((waited + 2))
done

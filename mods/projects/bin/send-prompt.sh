#!/bin/sh
# send-prompt.sh <terminal> <prompt-file> [timeout-seconds]
# Types a send-mode prompt into an agent that starts after a setup chain, once it is ready.
# Started detached by the projects mod (hc run --bg), so the launch popup never waits on setup.
# Ready (sendWhenReady's rule): herdr reports it idle or done; or herdr reports no status and the
# foreground program has been something other than a shell for 6 s (hermes and other status-less agents).
# Exits 0 once sent, 1 when the agent is blocked or the terminal is gone, 2 on timeout (default 1800 s).
terminal=$1
file=$2
timeout=${3:-1800}
waited=0
steady=-1 # seconds the foreground has been a non-shell program; -1 while it isn't
send() {
  hc send "$terminal" "$(cat "$file")" || exit 1
  rm -f "$file"
  exit 0
}
while :; do
  if ! out=$(hc get "$terminal" --json 2>/dev/null); then exit 1; fi
  case $out in
    *'"status":"idle"'* | *'"status":"done"'*) send ;;
    *'"status":"blocked"'*) exit 1 ;;
    *'"status":"'*) steady=-1 ;;
    *)
      fg=$(printf '%s' "$out" | sed -n 's/.*"foreground":{[^}]*"name":"\([^"]*\)".*/\1/p')
      case $fg in
        '' | bash | sh | zsh | fish | dash) steady=-1 ;;
        *) if [ "$steady" -lt 0 ]; then steady=0; else steady=$((steady + 2)); fi ;;
      esac
      [ "$steady" -ge 6 ] && send ;;
  esac
  [ "$waited" -ge "$timeout" ] && exit 2
  sleep 2
  waited=$((waited + 2))
done

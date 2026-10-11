#!/usr/bin/env bash
# Keep startup failures observable after Daytona detaches the launch command.
# State sits outside Vite's served workspace, alongside dev.log.
set -u
state_dir=${1:-/workspace}
printf '%s\n' "$$" > "$state_dir/dev.pid"
if [ -r /sys/fs/cgroup/memory.events ]; then
  awk '$1 == "oom_kill" { print $2 }' /sys/fs/cgroup/memory.events > "$state_dir/dev.oom-kills"
fi
./scripts/dev-native.sh &
app_pid=$!
trap 'kill -TERM "$app_pid" 2>/dev/null || true' TERM INT
wait "$app_pid"
status=$?
printf '%s\n' "$status" > "$state_dir/dev.exit.tmp"
mv "$state_dir/dev.exit.tmp" "$state_dir/dev.exit"
exit "$status"

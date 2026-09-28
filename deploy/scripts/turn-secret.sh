#!/usr/bin/env bash
# Create the TURN REST shared secret once. Two copies with matching content:
# one readable by the control center (uid 10001), one by coturn (nobody).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/deploy/secrets"
install -d -m 700 "$dir"
if [ ! -s "$dir/turn_secret" ]; then
  umask 077
  head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$dir/turn_secret"
fi
install -m 0640 -g 10001 "$dir/turn_secret" "$dir/turn_secret.tmp" && mv "$dir/turn_secret.tmp" "$dir/turn_secret"
install -m 0640 -g 65534 "$dir/turn_secret" "$dir/turn_secret.coturn"
echo "TURN secret ready in $dir"

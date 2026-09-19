#!/bin/sh
set -eu
umask 077

# Run from the deployment root. Pass the same -f/--env-file flags used to deploy.
# Docker host access is the authorization boundary; this is never exposed by HTTP.
docker compose "$@" stop control-center
if docker compose "$@" ps --status running --services | grep -qx control-center; then
  echo "Control-center is still running; recovery refused" >&2
  exit 1
fi
docker compose "$@" run --rm --no-deps --entrypoint node control-center \
  dist/recover-admin.js --confirm-service-stopped
docker compose "$@" up -d --no-deps control-center
printf '%s\n' 'Use the one-hour temporary password above and change it immediately. Re-enable MFA after recovery.'

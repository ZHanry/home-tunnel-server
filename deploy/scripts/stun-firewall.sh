#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
rules="$root/deploy/stun/firewall.nft"
case "${1:-check}" in
  check) nft --check --file "$rules" ;;
  apply)
    [ "$(id -u)" -eq 0 ] || { echo 'Installing STUN firewall rules requires root' >&2; exit 1; }
    if nft list table inet home_tunnel_stun >/dev/null 2>&1; then
      echo 'STUN table already exists; inspect it before replacing rules' >&2; exit 1
    fi
    nft --check --file "$rules"
    nft --file "$rules"
    ;;
  status) nft list table inet home_tunnel_stun ;;
  *) echo 'Usage: stun-firewall.sh check|apply|status' >&2; exit 2 ;;
esac

#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "bash is required... /ᐠ - ˕ -マ"
  exit 1
fi

set -euo pipefail

export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}:/usr/local/sbin:/usr/sbin:/sbin"

usage() {
  cat <<'USAGE'
usage: bash setup.sh [--block] [--yes]

  (no option)  install or update lyra on this server
  --block      add ips to the block list without rerunning the setup
  --yes, -y    skip the confirmation before services are stopped
  --help, -h   show this help

unattended runs read these instead of prompting:
  LYRA_WIREGUARD=1          route mochi and nuru through /etc/wireguard/wg0.conf
  LYRA_ADCASH=y|n           enable or disable adcash
  LYRA_ADCASH_TAG_FILE=...  inline adcash zone script
  LYRA_RESET_TUTORIALS=y|n  make everyone redo the tutorials
  LYRA_BLOCK="ip, cidr"     ips for --block
  LYRA_PUBLIC_IP=...        public ipv4 when detection fails
  MOCHI_INSTANCES, NURU_INSTANCES, TURN_HOST, TURN_PORT, TURN_USERNAME, TURN_CREDENTIAL
USAGE
}

BLOCK_MODE=0
ASSUME_YES=0
for argument in "$@"; do
  case "$argument" in
    --block) BLOCK_MODE=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h) usage; exit 0 ;;
    *)
      printf '[setup] unknown option: %s... /ᐠ - ˕ -マ\n' "$argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

NEGATIVE="... /ᐠ - ˕ -マ"
POSITIVE="!! (˵◝ ⩊  ◜˵マ"

TAG="[setup]"
TAG_FAIL="[setup]"
TAG_OK="[setup]"
STEP_MARK="==>"
DIM=""
RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  TAG=$'\033[1;35m[setup]\033[0m'
  TAG_FAIL=$'\033[1;31m[setup]\033[0m'
  TAG_OK=$'\033[1;32m[setup]\033[0m'
  STEP_MARK=$'\033[1;36m==>\033[0m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
fi

log() {
  printf '%s %s\n' "$TAG" "$*"
}

fail() {
  printf '%s %s%s\n' "$TAG_FAIL" "$*" "$NEGATIVE" >&2
}

success() {
  printf '%s %s%s\n' "$TAG_OK" "$*" "$POSITIVE"
}

SETUP_STARTED_AT=$SECONDS
STEP_INDEX=0
STEP_TOTAL=12
STEP_STARTED_AT=$SECONDS

elapsed() {
  local seconds=$(($1))
  if [ "$seconds" -ge 60 ]; then
    printf '%dm %02ds' $((seconds / 60)) $((seconds % 60))
  else
    printf '%ds' "$seconds"
  fi
}

step() {
  if [ "$STEP_INDEX" -gt 0 ]; then
    printf '%s    took %s%s\n' "$DIM" "$(elapsed SECONDS-STEP_STARTED_AT)" "$RESET"
  fi
  STEP_INDEX=$((STEP_INDEX + 1))
  STEP_STARTED_AT=$SECONDS
  printf '\n%s [%d/%d] %s\n' "$STEP_MARK" "$STEP_INDEX" "$STEP_TOTAL" "$*"
}

trap 'fail "setup failed at line $LINENO, see the output above"' ERR

retry() {
  local attempts="$1"
  shift
  local n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then
      return 1
    fi
    n=$((n + 1))
    sleep 2
  done
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "$cmd is required but was not found"
    exit 1
  fi
}

ask_yes_no() {
  local question="$1"
  local default="$2"
  local hint="[y/N]"
  local answer
  [ "$default" = y ] && hint="[Y/n]"
  while true; do
    read -r -p "$TAG $question $hint " answer || return 1
    case "${answer:-$default}" in
      y | yes | Y | YES) return 0 ;;
      n | no | N | NO) return 1 ;;
    esac
    fail "please type 'y' or 'n'"
  done
}

backup_file() {
  local file="$1"
  local stale
  sudo test -f "$file" || return 0
  sudo cp -p "$file" "$file.bak.$(date +%s)"
  while IFS= read -r stale; do
    sudo rm -f -- "$stale"
  done < <(sudo find "$(dirname "$file")" -maxdepth 1 -name "$(basename "$file").bak.*" -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
}

PROXY_CPUS=$(nproc 2>/dev/null || echo 1)
PROXY_RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)
[[ "$PROXY_CPUS" =~ ^[1-9][0-9]*$ ]] || PROXY_CPUS=1
[[ "$PROXY_RAM_MB" =~ ^[1-9][0-9]*$ ]] || PROXY_RAM_MB=2048
AUTO_INSTANCES=$((PROXY_CPUS / 2))
RAM_INSTANCES=$((PROXY_RAM_MB / 2048))
[ "$AUTO_INSTANCES" -le "$RAM_INSTANCES" ] || AUTO_INSTANCES=$RAM_INSTANCES
[ "$AUTO_INSTANCES" -ge 1 ] || AUTO_INSTANCES=1
[ "$AUTO_INSTANCES" -le 32 ] || AUTO_INSTANCES=32
MOCHI_AUTO=0
[ "${MOCHI_INSTANCES+x}" ] || MOCHI_AUTO=1
MOCHI_INSTANCES="${MOCHI_INSTANCES-$AUTO_INSTANCES}"
NURU_AUTO_INSTANCES=$AUTO_INSTANCES
[ "$NURU_AUTO_INSTANCES" -le 18 ] || NURU_AUTO_INSTANCES=18
NURU_INSTANCES="${NURU_INSTANCES-$NURU_AUTO_INSTANCES}"
for count in "$MOCHI_INSTANCES" "$NURU_INSTANCES"; do
  if ! [[ "$count" =~ ^([1-9]|[12][0-9]|3[0-2])$ ]]; then
    fail "proxy instance counts must be integers from 1 to 32"
    exit 1
  fi
done
configure_mochi_instances() {
  MOCHI_UPSTREAMS=""
  MOCHI_SERVICES=()
  local i
  for ((i = 0; i < MOCHI_INSTANCES; i++)); do
    MOCHI_UPSTREAMS+=" 127.0.0.1:$((4100 + i))"
    MOCHI_SERVICES+=("mochi@$i")
  done
}
configure_mochi_instances
NURU_UPSTREAMS=""
NURU_SERVICES=()
for ((i = 0; i < NURU_INSTANCES; i++)); do
  NURU_UPSTREAMS+=" 127.0.0.1:$((4200 + i))"
  NURU_SERVICES+=("nuru@$i")
done

configure_proxy_limits() {
  MOCHI_MEMORY_MB=$((PROXY_RAM_MB * 30 / 100 / MOCHI_INSTANCES))
  NURU_MEMORY_MB=$((PROXY_RAM_MB * 20 / 100 / NURU_INSTANCES))
  MOCHI_REQUESTS=$((MOCHI_MEMORY_MB / 8))
  NURU_REQUESTS=$((NURU_MEMORY_MB / 16))
  [ "$MOCHI_REQUESTS" -ge 1 ] || MOCHI_REQUESTS=1
  [ "$NURU_REQUESTS" -ge 1 ] || NURU_REQUESTS=1
  [ "$MOCHI_REQUESTS" -le 256 ] || MOCHI_REQUESTS=256
  [ "$NURU_REQUESTS" -le 128 ] || NURU_REQUESTS=128
  MOCHI_CLIENT_CONCURRENCY=$((MOCHI_REQUESTS * 3 / 4))
  [ "$MOCHI_CLIENT_CONCURRENCY" -ge 64 ] || MOCHI_CLIENT_CONCURRENCY=64
  [ "$MOCHI_CLIENT_CONCURRENCY" -le 256 ] || MOCHI_CLIENT_CONCURRENCY=256
}
configure_proxy_limits

proxy_limits_active() {
  local limit value
  read -r value < "$1/memory.high" || return 1
  [ "$value" = max ] || return 1
  for limit in cpu.max memory.max memory.swap.max pids.max; do
    read -r value _ < "$1/$limit" || return 1
    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    if [ "$limit" = memory.swap.max ]; then
      [ "$value" -eq 0 ] || return 1
    else
      [ "$value" -gt 0 ] || return 1
    fi
  done
}

case "$(uname -s)" in
Linux) ;;
*)
  fail "this setup needs apt + systemd"
  log "detected os: $(uname -s)"
  exit 1
  ;;
esac

if [ ! -f /etc/os-release ]; then
  fail "can't detect distro (/etc/os-release missing)"
  exit 1
fi

. /etc/os-release
if [ "${ID:-}" != "debian" ] && [ "${ID:-}" != "ubuntu" ] && [[ "${ID_LIKE:-}" != *debian* ]]; then
  fail "unsupported distro for this setup: ${PRETTY_NAME:-unknown}"
  exit 1
fi

require_cmd apt-get
require_cmd systemctl
require_cmd runuser

for controller in cpu memory pids; do
  if ! grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
    fail "proxy resource limits require cgroup v2 with cpu, memory, and process controllers"
    exit 1
  fi
done
if [ "$MOCHI_MEMORY_MB" -lt 384 ] || [ "$NURU_MEMORY_MB" -lt 256 ]; then
  fail "insufficient memory for the proxy worker counts"
  exit 1
fi

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  sudo() { "$@"; }
elif ! command -v sudo >/dev/null 2>&1; then
  fail "sudo is required when not root"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SETUP_TEMP="$(mktemp -d)"
CHAT_SETUP_PID=""
cleanup() {
  if [ -n "$CHAT_SETUP_PID" ]; then
    pkill -TERM -P "$CHAT_SETUP_PID" 2>/dev/null || true
    kill "$CHAT_SETUP_PID" 2>/dev/null || true
  fi
  rm -rf -- "$SETUP_TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BLOCK_PATH="/etc/lyra/block"
BLOCK_CADDY_PATH="/etc/caddy/block.caddy"

block_rules() {
  local source="$1"
  if [ ! -f "$source" ]; then
    return 0
  fi
  sed -e 's/#.*//' -e 's/[[:space:]]//g' "$source" | awk 'NF && !seen[$0]++'
}

render_block_caddy() {
  local list="$1"
  local rules=()
  local rule
  local match="255.255.255.255/32"
  while IFS= read -r rule; do
    rules+=("$rule")
  done < <(block_rules "$list")
  if [ "${#rules[@]}" -gt 0 ]; then
    match="${rules[*]}"
  fi
  printf '(block) {\n'
  printf '    @block remote_ip %s\n' "$match"
  printf '    respond @block "no... /ᐠ - ˕ -マ" 403\n'
  printf '}\n'
}

normalize_block() {
  BLOCK_INPUT="$1" "$BUN_BIN" -e '
import { normalizeBlockList } from "./server/block.mjs";
const result = normalizeBlockList(process.env.BLOCK_INPUT || "");
for (const rule of result.rules) console.log(rule);
if (result.invalid.length > 0) process.exit(1);
'
}

configure_block() {
  BLOCK_ADDED=""
  local input="${LYRA_BLOCK:-}"
  if [ -z "$input" ] && [ ! -t 0 ]; then
    return 0
  fi
  if [ -s "$BLOCK_PATH" ]; then
    log "block: $(block_rules "$BLOCK_PATH" | paste -sd ', ' -)"
  fi
  if [ -z "$input" ]; then
    log "enter ipv4 addresses, * wildcards, or cidrs, separated by commas or spaces"
  fi
  while true; do
    if [ -z "$input" ]; then
      read -r -p "ips to block> " input
    fi
    if BLOCK_ADDED="$(normalize_block "$input")"; then
      return 0
    fi
    fail "please enter valid ipv4 addresses, wildcards, or cidrs"
    [ -t 0 ] || return 1
    input=""
  done
}

apply_block() {
  local added="$1"
  local pending="$SETUP_TEMP/block"
  {
    block_rules "$BLOCK_PATH"
    if [ -n "$added" ]; then
      printf '%s\n' "$added"
    fi
  } | awk 'NF && !seen[$0]++' > "$pending"
  sudo install -d -m 755 /etc/lyra
  sudo install -m 644 "$pending" "$BLOCK_PATH"
}

install_block_caddy() {
  local pending="$SETUP_TEMP/block.caddy"
  render_block_caddy "$BLOCK_PATH" > "$pending"
  sudo install -d -m 755 /etc/caddy
  sudo install -m 644 "$pending" "$BLOCK_CADDY_PATH"
}

install_block_firewall() {
  sudo tee /usr/local/bin/lyra-block.sh >/dev/null <<'BLOCKFIREWALL'
#!/bin/bash
set -euo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LIST=/etc/lyra/block

fail() { printf '[lyra-block] %s... /ᐠ - ˕ -マ\n' "$*" >&2; }
success() { printf '[lyra-block] %s!! (˵◝ ⩊  ◜˵マ\n' "$*"; }

IPTABLES="$(command -v iptables || true)"
if [ -z "$IPTABLES" ]; then
  fail "iptables is unavailable"
  exit 0
fi

"$IPTABLES" -w 5 -N LYRA_BLOCK 2>/dev/null || true
if ! "$IPTABLES" -w 5 -C INPUT -j LYRA_BLOCK 2>/dev/null; then
  "$IPTABLES" -w 5 -I INPUT 1 -j LYRA_BLOCK
fi
"$IPTABLES" -w 5 -F LYRA_BLOCK
"$IPTABLES" -w 5 -A LYRA_BLOCK -i lo -j RETURN
if [ -f "$LIST" ]; then
  while IFS= read -r rule; do
    rule="${rule%%#*}"
    rule="${rule//[[:space:]]/}"
    [ -n "$rule" ] || continue
    "$IPTABLES" -w 5 -A LYRA_BLOCK -s "$rule" -j DROP
  done < "$LIST"
fi
success "firewall rules applied"
BLOCKFIREWALL
  sudo chmod 755 /usr/local/bin/lyra-block.sh
  sudo tee /etc/systemd/system/lyra-block.service >/dev/null <<'BLOCKUNIT'
[Unit]
Description=lyra block firewall rules
After=network-pre.target docker.service ufw.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/lyra-block.sh

[Install]
WantedBy=multi-user.target
BLOCKUNIT
  sudo systemctl daemon-reload
  sudo systemctl enable lyra-block.service >/dev/null 2>&1 || true
  sudo systemctl restart lyra-block.service
}

run_block_mode() {
  export PATH="$HOME/.bun/bin:$PATH"
  if [ -z "${BUN_BIN:-}" ]; then
    BUN_BIN="$(command -v bun || true)"
  fi
  if [ -z "${BUN_BIN:-}" ]; then
    fail "bun is required to block ips; run the setup first"
    exit 1
  fi
  configure_block
  apply_block "$BLOCK_ADDED"
  install_block_caddy
  if ! command -v iptables >/dev/null 2>&1; then
    fail "iptables is unavailable; firewall blocking is skipped"
  fi
  if ! install_block_firewall; then
    fail "firewall blocking could not be applied"
  fi
  if command -v caddy >/dev/null 2>&1 && sudo test -f /etc/caddy/Caddyfile; then
    if ! sudo grep -Fq "import block" /etc/caddy/Caddyfile; then
      fail "caddy config is outdated; run setup once to enable edge blocking"
    elif ! sudo runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile; then
      fail "caddy config validation failed"
      exit 1
    elif ! sudo systemctl reload-or-restart caddy 2>/dev/null; then
      fail "caddy did not reload"
    fi
  else
    log "caddy is not installed; edge blocking applies after setup"
  fi
  success "block saved"
}

if [ "$BLOCK_MODE" -eq 1 ]; then
  run_block_mode
  exit 0
fi

edit_config() {
  local editor=()
  read -r -a editor <<< "${VISUAL:-${EDITOR:-nano}}"
  require_cmd "${editor[0]}"
  "${editor[@]}" "$1" </dev/tty >/dev/tty 2>&1
}

configure_adcash() {
  ADCASH_TAG_PATH="$ROOT/.adcash-zone.tag"
  ADCASH_ACTION=keep
  ADCASH_SOURCE="${LYRA_ADCASH_TAG_FILE:-}"
  local choice="${LYRA_ADCASH:-}"
  local current=n
  if [ -z "$choice" ]; then
    [ -t 0 ] || return 0
    [ -s "$ADCASH_TAG_PATH" ] && current=y
    if ask_yes_no "show adcash ads on the site?" "$current"; then choice=y; else choice=n; fi
  fi
  case "$choice" in
    y | yes | Y | YES | true | 1) ADCASH_ACTION=enable ;;
    n | no | N | NO | false | 0) ADCASH_ACTION=disable; return 0 ;;
    *)
      fail "LYRA_ADCASH must be y or n"
      return 1
      ;;
  esac
  if [ -z "$ADCASH_SOURCE" ] && [ -s "$ADCASH_TAG_PATH" ]; then
    if [ ! -t 0 ] || ask_yes_no "keep the saved adcash zone script?" y; then
      ADCASH_SOURCE="$ADCASH_TAG_PATH"
    fi
  fi
  if [ -z "$ADCASH_SOURCE" ] && [ -t 0 ]; then
    ADCASH_SOURCE="$SETUP_TEMP/adcash-zone.tag"
    log "paste your inline adcash zone script in the editor, then save and exit"
    : > "$ADCASH_SOURCE"
    edit_config "$ADCASH_SOURCE"
  fi
  if [ -z "$ADCASH_SOURCE" ] || [ ! -s "$ADCASH_SOURCE" ]; then
    fail "adcash needs an inline zone script; set LYRA_ADCASH_TAG_FILE"
    return 1
  fi
  cp "$ADCASH_SOURCE" "$SETUP_TEMP/adcash-pending.tag"
  ADCASH_SOURCE="$SETUP_TEMP/adcash-pending.tag"
}

validate_adcash() {
  [ "$ADCASH_ACTION" = enable ] || return 0
  "$1" --eval '
    import { readFileSync } from "node:fs";
    import { normalizeAdcashZoneTag } from "./server/adcash.mjs";
    try {
      normalizeAdcashZoneTag(readFileSync(process.argv[1], "utf8"));
    } catch {
      console.error("[setup] invalid adcash zone script; saved config unchanged... /ᐠ - ˕ -マ");
      process.exit(1);
    }
  ' "$ADCASH_SOURCE"
}

configure_tutorials() {
  TUTORIAL_RESET=0
  local choice="${LYRA_RESET_TUTORIALS:-}"
  if [ -z "$choice" ]; then
    [ -t 0 ] || return 0
    if ask_yes_no "make everyone redo the home and chat tutorials?" n; then TUTORIAL_RESET=1; fi
    return 0
  fi
  case "$choice" in
    y | yes | Y | YES | true | 1) TUTORIAL_RESET=1 ;;
    n | no | N | NO | false | 0) ;;
    *)
      fail "LYRA_RESET_TUTORIALS must be y or n"
      return 1
      ;;
  esac
}

save_tutorial_revision() {
  [ "$TUTORIAL_RESET" -eq 1 ] || return 0
  cat /proc/sys/kernel/random/uuid > "$ROOT/.tutorial-revision.pending"
  mv -f "$ROOT/.tutorial-revision.pending" "$ROOT/.tutorial-revision"
}

WG_ENABLED=0
WG_REUSE=0
WG_CONFIG_EXISTS=0

if sudo [ -f /etc/wireguard/wg0.conf ]; then
  WG_CONFIG_EXISTS=1
  log "detected existing wireguard config"
fi

if [ -t 0 ]; then
  WG_DEFAULT=n
  if [ "$WG_CONFIG_EXISTS" -eq 1 ] && systemctl is-enabled --quiet wg-quick@wg0 2>/dev/null; then
    WG_DEFAULT=y
  fi
  log "wireguard sends all outbound mochi and nuru traffic through a vpn, which can be slower"
  if ask_yes_no "route mochi and nuru through wireguard?" "$WG_DEFAULT"; then
    WG_ENABLED=1
    if [ "$WG_CONFIG_EXISTS" -eq 1 ] && ask_yes_no "keep the existing wireguard config?" y; then
      WG_REUSE=1
    fi
  fi

  if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_REUSE" -eq 0 ]; then
    WG_CONFIG_FILE="$SETUP_TEMP/wg0.conf"
    cat >"$WG_CONFIG_FILE" <<'WGEOF'
# paste your wireguard config below then save and exit!
#
# example:
# [Interface]
# PrivateKey = ...
# Address = ...
# DNS = ...
#
# [Peer]
# PublicKey = ...
# AllowedIPs = ...
# Endpoint = ...
# PresharedKey = ...
WGEOF
    while true; do
      edit_config "$WG_CONFIG_FILE"
      if ! grep -Eq '^[[:space:]]*[^#[:space:]]' "$WG_CONFIG_FILE" 2>/dev/null; then
        fail "the wireguard config is empty"
      elif ! grep -Eq '^[[:space:]]*\[Interface\][[:space:]]*$' "$WG_CONFIG_FILE" 2>/dev/null; then
        fail "the wireguard config has no [Interface] section"
      else
        success "wireguard config is valid"
        break
      fi
      if ! ask_yes_no "edit the wireguard config again?" y; then
        WG_ENABLED=0
        log "wireguard skipped, mochi and nuru will use the direct connection"
        break
      fi
    done
  fi
else
  case "${LYRA_WIREGUARD:-no}" in
  1 | true | yes | y)
    if [ "$WG_CONFIG_EXISTS" -eq 1 ]; then
      WG_ENABLED=1
      WG_REUSE=1
      success "wireguard routing enabled by LYRA_WIREGUARD using the existing config"
    else
      fail "LYRA_WIREGUARD requested, but /etc/wireguard/wg0.conf is missing; using the direct connection"
    fi
    ;;
  *)
    log "wireguard routing mode: direct connection"
    ;;
  esac
fi

configure_adcash
configure_tutorials

show_plan() {
  local wireguard="off, direct connection"
  local adcash="unchanged"
  local tutorials="kept"
  if [ "$WG_ENABLED" -eq 1 ]; then
    wireguard="on, new config"
    [ "$WG_REUSE" -eq 0 ] || wireguard="on, existing config"
  fi
  case "$ADCASH_ACTION" in
    enable) adcash="on" ;;
    disable) adcash="off" ;;
  esac
  [ "$TUTORIAL_RESET" -eq 0 ] || tutorials="reset for everyone"
  printf '\n'
  log "server      ${PRETTY_NAME:-linux}, $PROXY_CPUS cpus, $((PROXY_RAM_MB / 1024)) gb ram"
  log "workers     up to $MOCHI_INSTANCES mochi, $NURU_INSTANCES nuru"
  log "wireguard   $wireguard"
  log "adcash      $adcash"
  log "tutorials   $tutorials"
  log "the site goes down while services are stopped, rebuilt, and restarted"
}
show_plan
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && ! ask_yes_no "start the setup?" y; then
  log "setup cancelled, nothing was changed"
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive

step "installing system packages"
retry 3 sudo apt-get update -qq
retry 3 sudo apt-get install -y -qq --no-install-recommends unzip libcap2-bin jq dnsutils binaryen build-essential cmake libclang-dev pkg-config libssl-dev git debian-keyring debian-archive-keyring apt-transport-https docker.io docker-cli libjemalloc2 ca-certificates curl gnupg lsb-release openssl psmisc ffmpeg

step "checking bun and site config"
BUN_VERSION="1.4.4"
export PATH="$HOME/.bun/bin:$PATH"
BUN_CURRENT_VERSION="$(bun --version 2>/dev/null || true)"
if [ "$BUN_CURRENT_VERSION" != "$BUN_VERSION" ]; then
  log "installing bun $BUN_VERSION"
  curl -fsSL https://bun.com/install | bash -s -- "bun-v$BUN_VERSION"
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  fail "bun installation failed"
  exit 1
fi
require_cmd bun

BUN_BIN="$(command -v bun)"
validate_adcash "$BUN_BIN"

if [ "$("$BUN_BIN" --version)" != "$BUN_VERSION" ]; then
  fail "bun $BUN_VERSION is required"
  exit 1
fi

"$BUN_BIN" -e '
import { productionStaticGateway } from "./server/static-backend.mjs";
try {
  productionStaticGateway(() => ({}));
  console.log("[setup] static gateway configuration validated!! (˵◝ ⩊  ◜˵マ");
} catch {
  console.error("[setup] invalid static gateway configuration... /ᐠ - ˕ -マ");
  process.exit(1);
}
'

log "support is available at discord.gg/4GeWaGPh6c"
success "setup started"

stop_pm2() {
  local candidate
  local pm2_bin=""
  local candidates=()

  if command -v pm2 >/dev/null 2>&1; then
    candidates+=("$(command -v pm2)")
  fi
  candidates+=("$HOME/.bun/bin/pm2" "$ROOT/node_modules/.bin/pm2")

  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      pm2_bin="$candidate"
      break
    fi
  done

  if [ -n "$pm2_bin" ]; then
    local runner=("$pm2_bin")
    local bun_bin
    bun_bin="$(PATH="$HOME/.bun/bin:$PATH" command -v bun || true)"
    [ -z "$bun_bin" ] || runner=("$bun_bin" "$pm2_bin")
    "${runner[@]}" stop all >/dev/null 2>&1 || true
    "${runner[@]}" delete all >/dev/null 2>&1 || true
    "${runner[@]}" kill >/dev/null 2>&1 || true
  fi
}

kill_service_processes() {
  local name
  local pattern
  local signal
  local used=0
  local names=(tls-approval lyra nuru mochi cloudsync isao caddy eturnal coturn turnserver)
  local patterns=(
    '[s]ervices/tls-approval/server\.js'
    '[s]erver/prod\.mjs'
    '[s]erver/dev\.mjs'
    '[n]uru-route\.sh'
  )

  if ! command -v pkill >/dev/null 2>&1; then
    return
  fi
  for signal in TERM KILL; do
    for name in "${names[@]}"; do
      sudo pkill -"$signal" -x "$name" 2>/dev/null || true
    done
    for pattern in "${patterns[@]}"; do
      sudo pkill -"$signal" -f "$pattern" 2>/dev/null || true
    done
    if [ "$signal" = TERM ]; then
      sleep 1
    fi
  done

  for name in "${names[@]}"; do
    if sudo pgrep -x "$name" >/dev/null 2>&1; then
      fail "service process $name is still running"
      used=1
    fi
  done
  for pattern in "${patterns[@]}"; do
    if sudo pgrep -f "$pattern" >/dev/null 2>&1; then
      fail "a managed service process is still running"
      used=1
    fi
  done

  [ "$used" -eq 0 ]
}

release_service_ports() {
  local port
  local protocol
  local used=0
  local ports=(3001 4000 4001 4002 4003 4005 4444 6001 8923 3478 "${TURN_PORT:-3478}")

  if ! command -v fuser >/dev/null 2>&1; then
    return
  fi

  for port in "${ports[@]}"; do
    for protocol in tcp udp; do
      sudo fuser -k "$port/$protocol" >/dev/null 2>&1 || true
    done
  done

  sleep 1
  for port in "${ports[@]}"; do
    if sudo fuser "$port/tcp" >/dev/null 2>&1 || sudo fuser "$port/udp" >/dev/null 2>&1; then
      fail "service port $port is still in use"
      used=1
    fi
  done

  [ "$used" -eq 0 ]
}

step "stopping running services"
log "stopping all running services"
while read -r unit _; do
  if [[ "$unit" =~ ^(mochi|nuru)@[0-9]+\.service$ ]]; then
    sudo systemctl stop "$unit"
    sudo systemctl disable "$unit"
  fi
done < <(
  {
    systemctl list-unit-files --type=service --no-legend
    systemctl list-units --all --plain --type=service --no-legend
  } | awk '{print $1}' | sort -u
)
sudo systemctl stop "pm2-$USER.service" 2>/dev/null || true
stop_pm2
for svc in tls-approval lyra waves ask cloudsync isao mochi nuru nuru-route.timer nuru-route lyra-cosmetics.timer lyra-cosmetics wg-quick@wg0 caddy eturnal coturn; do
  sudo systemctl stop "$svc" 2>/dev/null || true
  sudo systemctl disable "$svc" 2>/dev/null || true
done
if command -v docker >/dev/null 2>&1; then
  if sudo docker compose version >/dev/null 2>&1 && [ -f "$ROOT/services/turn/compose.yml" ]; then
    sudo docker compose -f "$ROOT/services/turn/compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  fi
fi
if command -v wg-quick >/dev/null 2>&1; then
  sudo wg-quick down wg0 2>/dev/null || true
fi
if command -v ip >/dev/null 2>&1; then
  sudo ip link delete veth0-global 2>/dev/null || true
  sudo ip link delete wg0 2>/dev/null || true
fi
kill_service_processes
release_service_ports
sudo rm -f /etc/systemd/system/lyra-cosmetics.service /etc/systemd/system/lyra-cosmetics.timer
if [ "$WG_ENABLED" -eq 0 ]; then
  sudo rm -f /etc/systemd/system/nuru-route.service /etc/systemd/system/nuru-route.timer /usr/local/bin/nuru-route.sh
fi
sudo systemctl daemon-reload
success "all services stopped"

step "preparing the network"
if command -v modprobe >/dev/null 2>&1; then
  sudo modprobe nf_conntrack || true
fi

if [ "$WG_ENABLED" -eq 1 ]; then
  RESOLV_CONF_BACKUP=""
  if ! command -v wg-quick >/dev/null 2>&1; then
    log "installing wireguard-tools..."
    if ! retry 3 sudo apt-get install -y --no-install-recommends wireguard-tools; then
      fail "wireguard-tools installation failed"
      exit 1
    fi
  fi
  if ! command -v resolvconf >/dev/null 2>&1; then
    if ! retry 3 getent ahosts registry.npmjs.org >/dev/null 2>&1; then
      fail "dns resolution is unavailable before resolver setup"
      exit 1
    fi
    RESOLV_CONF_BACKUP="$(mktemp)"
    cp -L /etc/resolv.conf "$RESOLV_CONF_BACKUP"
    RESOLVER_PACKAGE="openresolv"
    if ! apt-cache show "$RESOLVER_PACKAGE" >/dev/null 2>&1; then
      RESOLVER_PACKAGE="systemd-resolved"
    fi
    log "installing $RESOLVER_PACKAGE..."
    if ! retry 3 sudo apt-get install -y --no-install-recommends "$RESOLVER_PACKAGE"; then
      fail "dns resolver installation failed"
      exit 1
    fi
  fi
  require_cmd wg
  require_cmd wg-quick
  require_cmd resolvconf
  if ! retry 3 getent ahosts registry.npmjs.org >/dev/null 2>&1; then
    if [ -n "$RESOLV_CONF_BACKUP" ] && [ -s "$RESOLV_CONF_BACKUP" ]; then
      if ! sudo cp --remove-destination "$RESOLV_CONF_BACKUP" /etc/resolv.conf || ! sudo chmod 644 /etc/resolv.conf; then
        fail "dns resolver setup failed and the previous configuration could not be restored"
        exit 1
      fi
      rm -f "$RESOLV_CONF_BACKUP"
      fail "dns resolver setup failed; the previous configuration was restored"
      exit 1
    fi
    fail "dns resolution is unavailable"
    exit 1
  fi
  [ -z "$RESOLV_CONF_BACKUP" ] || rm -f "$RESOLV_CONF_BACKUP"
  if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_REUSE" -eq 0 ]; then
    log "installing wireguard config..."
    sed -i '/^[[:space:]]*#/d' "$WG_CONFIG_FILE"
    sed -i -E 's/[0-9a-f]*:[0-9a-f:.]+\/[0-9]+//g' "$WG_CONFIG_FILE"
    sed -i -E 's/,\s*,/, /g' "$WG_CONFIG_FILE"
    sed -i -E 's/=\s*,/ = /g' "$WG_CONFIG_FILE"
    sed -i -E 's/,\s*$//' "$WG_CONFIG_FILE"
    PHYS_DEV=$(ip -4 route show default 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' | head -1)
    if [ -n "$PHYS_DEV" ]; then
      PHYS_MTU=$(ip link show "$PHYS_DEV" 2>/dev/null | sed -n 's/.*mtu \([0-9]*\).*/\1/p')
    fi
    WG_MTU=$((${PHYS_MTU:-1500} - 80))
    [ "$WG_MTU" -lt 1280 ] && WG_MTU=1280
    sed -i "/^\[Interface\]/a MTU = $WG_MTU" "$WG_CONFIG_FILE"
    sudo mkdir -p /etc/wireguard
    sudo cp "$WG_CONFIG_FILE" /etc/wireguard/wg0.conf
    sudo chmod 600 /etc/wireguard/wg0.conf
    rm -f "$WG_CONFIG_FILE"
    success "wireguard config installed at /etc/wireguard/wg0.conf (mtu: $WG_MTU)"
  fi
  if [ "$WG_ENABLED" -eq 1 ]; then
    WG_FWMARK=$(sudo sed -n -E \
      's/^[[:space:]]*FwMark[[:space:]]*=[[:space:]]*([^[:space:]#]+).*$/\1/p' \
      /etc/wireguard/wg0.conf | head -1)
    if ! [[ "$WG_FWMARK" =~ ^(0[xX][[:xdigit:]]+|[[:digit:]]+)$ ]]; then
      WG_FWMARK=0xca6c
    fi
    sudo sed -i -E \
      -e '/^[[:space:]]*Table[[:space:]]*=/Id' \
      -e '/^[[:space:]]*FwMark[[:space:]]*=/Id' \
      -e '/^[[:space:]]*PostUp[[:space:]]*=[[:space:]]*wg[[:space:]]+set[[:space:]]+%i[[:space:]]+fwmark[[:space:]]+0xca6c[[:space:]]*$/Id' \
      /etc/wireguard/wg0.conf
    sudo sed -i \
      "/^[[:space:]]*\[Interface\][[:space:]]*$/a\\
FwMark = $WG_FWMARK\\
Table = off
" \
      /etc/wireguard/wg0.conf
    sudo chmod 600 /etc/wireguard/wg0.conf
    success "wireguard policy routing normalized"
    if sudo grep -Eq '^[[:space:]]*DNS[[:space:]]*=' /etc/wireguard/wg0.conf; then
      sudo sed -i -E \
        's|^[[:space:]]*DNS[[:space:]]*=[[:space:]]*(.*)$|# LyraVPNDNS = \1|' \
        /etc/wireguard/wg0.conf
      success "wireguard dns reserved for routed services; host dns left unchanged"
    fi
    sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
    [ "$WG_REUSE" -eq 1 ] && log "reusing existing wireguard config at /etc/wireguard/wg0.conf"
  fi
fi

step "installing toolchains"
if ! command -v eturnalctl >/dev/null 2>&1 && [ ! -x /opt/eturnal/bin/eturnalctl ]; then
  log "installing eturnal"
  curl -fsS -o "$SETUP_TEMP/eturnal-install.sh" https://eturnal.net/install
  sudo sh "$SETUP_TEMP/eturnal-install.sh"
fi
if ! command -v eturnalctl >/dev/null 2>&1 && [ ! -x /opt/eturnal/bin/eturnalctl ]; then
  fail "eturnal installation failed"
  exit 1
fi
export PATH="/opt/eturnal/bin:$PATH"

save_tutorial_revision

case "$ADCASH_ACTION" in
  enable)
    install -m 600 "$ADCASH_SOURCE" "$ADCASH_TAG_PATH.pending"
    mv -f "$ADCASH_TAG_PATH.pending" "$ADCASH_TAG_PATH"
    success "adcash config saved"
    ;;
  disable)
    rm -f "$ADCASH_TAG_PATH"
    log "adcash disabled"
    ;;
esac

if ! "$BUN_BIN" pm -g ls | grep -q "pm2@"; then
  if ! retry 3 "$BUN_BIN" add -g pm2; then
    fail "pm2 installation failed"
    exit 1
  fi
else
  if ! retry 3 "$BUN_BIN" update -g pm2; then
    fail "pm2 update failed"
    exit 1
  fi
fi

PM2_BIN="$("$BUN_BIN" pm bin -g)/pm2"
if [ ! -x "$PM2_BIN" ]; then
  fail "pm2 installation failed"
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
fi

require_cmd rustup

if ! command -v cargo >/dev/null 2>&1; then
  fail "cargo installation failed"
  exit 1
fi
require_cmd cargo

CARGO_BIN="$(command -v cargo)"

RUST_NIGHTLY="nightly-2026-06-30"
if ! rustup run "$RUST_NIGHTLY" rustc --version >/dev/null 2>&1; then
  rustup toolchain install "$RUST_NIGHTLY" --profile minimal --component rust-src
else
  rustup component add rust-src --toolchain "$RUST_NIGHTLY"
fi

if ! command -v wasm-bindgen >/dev/null 2>&1 || [ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.105" ]; then
  "$CARGO_BIN" install wasm-bindgen-cli --version 0.2.105 --locked
fi

if ! command -v wasm-snip >/dev/null 2>&1; then
  "$CARGO_BIN" install wasm-snip --version 0.4.0 --locked
fi

if ! dpkg-query -W -f='${Status}' caddy 2>/dev/null | grep -q "install ok installed"; then
  sudo mkdir -p /usr/share/keyrings /etc/apt/sources.list.d
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  retry 3 sudo apt-get update -qq
  retry 3 sudo apt-get install -y -qq --no-install-recommends caddy
fi

step "tuning the kernel"
backup_file /etc/sysctl.d/99-lyra-optimizations.conf

LYRA_RESERVED_PORTS="$(sudo sysctl -n net.ipv4.ip_local_reserved_ports)"
LYRA_RESERVED_PORTS="${LYRA_RESERVED_PORTS:+$LYRA_RESERVED_PORTS,}2019,3001,${TURN_PORT:-3478},4000-4444,6001,8923"
sudo sysctl -w "net.ipv4.ip_local_reserved_ports=$LYRA_RESERVED_PORTS" >/dev/null

cat <<EOF | sudo tee /etc/sysctl.d/99-lyra-optimizations.conf >/dev/null
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 10
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 10
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.ip_local_reserved_ports = $LYRA_RESERVED_PORTS
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 0
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192
fs.file-max = 2097152
fs.nr_open = 2097152
vm.swappiness = 10
vm.vfs_cache_pressure = 50
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_fin_timeout = 10
net.core.optmem_max = 25165824
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.send_redirects = 0
EOF
sudo sysctl -p /etc/sysctl.d/99-lyra-optimizations.conf >/dev/null || true

if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
  echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf >/dev/null
fi
if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
  echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf >/dev/null
fi

step "building services"
log "installing javascript dependencies"
if [ -f bun.lock ]; then
  "$BUN_BIN" install --frozen-lockfile --prefer-offline || "$BUN_BIN" install
else
  "$BUN_BIN" install
fi

CHAT_SETUP_LOG="$SETUP_TEMP/chat-setup.log"
CHAT_SETUP_PID=""
if [ "$PROXY_RAM_MB" -ge 8192 ]; then
  log "preparing chat models in the background while rust builds"
  retry 3 "$BUN_BIN" run setup:chat >"$CHAT_SETUP_LOG" 2>&1 &
  CHAT_SETUP_PID=$!
fi

for service in nuru mochi cloudsync; do
  if [ ! -d "$ROOT/services/$service" ]; then
    fail "$service service directory not found"
    exit 1
  fi
  log "building $service"
  (
    cd "$ROOT/services/$service"
    RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release --locked
  )
done
sudo cp "$ROOT/target/release/nuru" /usr/local/bin/nuru
sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru || true

step "configuring vpn routing and turn"
id -u mochi >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin mochi
id -u nuru >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin nuru

if [ "$WG_ENABLED" -eq 0 ]; then
  MOCHI_UID=$(id -u mochi 2>/dev/null || echo "")
  NURU_UID=$(id -u nuru 2>/dev/null || echo "")
  [ -n "$MOCHI_UID" ] && sudo ip rule del uidrange "$MOCHI_UID"-"$MOCHI_UID" lookup 200 2>/dev/null || true
  [ -n "$NURU_UID" ] && sudo ip rule del uidrange "$NURU_UID"-"$NURU_UID" lookup 200 2>/dev/null || true
fi

JEMALLOC_PATH=""
for jemalloc_candidate in /usr/lib/*-linux-gnu/libjemalloc.so.2; do
  if [ -f "$jemalloc_candidate" ]; then
    JEMALLOC_PATH="$jemalloc_candidate"
    break
  fi
done

if [ "$WG_ENABLED" -eq 1 ]; then
  sudo chown nuru:nuru /usr/local/bin/nuru
  sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru || true

  cat <<'NRSCRIPT' | sudo tee /usr/local/bin/nuru-route.sh >/dev/null
#!/bin/bash
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "[nuru-route] must run as root... /ᐠ - ˕ -マ" >&2
    exit 0
fi

log() { echo "[nuru-route] $(date '+%H:%M:%S') $*"; }
fail() { log "$*... /ᐠ - ˕ -マ"; }
success() { log "$*!! (˵◝ ⩊  ◜˵マ"; }

NURU_UID=$(id -u nuru 2>/dev/null || echo "")
[ -z "$NURU_UID" ] && { fail "nuru user not found"; exit 0; }
MOCHI_UID=$(id -u mochi 2>/dev/null || echo "")
[ -z "$MOCHI_UID" ] && { fail "mochi user not found"; exit 0; }

WG_IFACES=()
if command -v wg >/dev/null 2>&1; then
    IFS=' ' read -r -a WG_IFACES < <(wg show interfaces 2>/dev/null || true) || true
fi

if [ ${#WG_IFACES[@]} -eq 0 ]; then
    for iface in utun420 tun0 tun1 wg0; do
        if ip link show "$iface" &>/dev/null 2>&1; then
            if ! command -v wg >/dev/null 2>&1 || wg show "$iface" >/dev/null 2>&1; then
                WG_IFACES+=("$iface")
            fi
        fi
    done
fi

log "detected wireguard interfaces: ${WG_IFACES[*]:-none}"

VPN_IF=""
for iface in "${WG_IFACES[@]}"; do
    if [ "$iface" = "wg0" ]; then
        VPN_IF="$iface"
        break
    fi
    [ -n "$VPN_IF" ] || VPN_IF="$iface"
done

MAIN_DEF=""
while read -r route; do
    if ! echo "$route" | grep -qE 'dev (utun|tun|wg)'; then
        MAIN_DEF="$route"
        break
    fi
done < <(ip route show default 2>/dev/null || true)

if [ -z "$MAIN_DEF" ]; then
    PHYS_IF=$(ip -br link show 2>/dev/null | grep -vE '^(lo|utun|tun|wg|veth|docker|br-)' | awk 'NR==1 {print $1}')
    if [ -n "$PHYS_IF" ]; then
        PHYS_GW=$(ip route show 0/0 dev "$PHYS_IF" 2>/dev/null | awk '{print $3}' || true)
        if [ -z "$PHYS_GW" ]; then
            PHYS_IP=$(ip -4 addr show "$PHYS_IF" 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
            if [ -n "$PHYS_IP" ]; then
                PHYS_GW=$(echo "$PHYS_IP" | awk -F. '{print $1"."$2"."$3".1"}')
            fi
        fi
        [ -n "$PHYS_GW" ] && MAIN_DEF="default via $PHYS_GW dev $PHYS_IF"
    fi
fi
[ -z "$MAIN_DEF" ] && { fail "cannot determine physical default route"; exit 0; }

WG_MARK=0xca6c
if [ -n "$VPN_IF" ]; then
    CURRENT_WG_MARK=$(wg show "$VPN_IF" fwmark 2>/dev/null || true)
    if [[ "$CURRENT_WG_MARK" =~ ^(0[xX][[:xdigit:]]+|[[:digit:]]+)$ ]]; then
        WG_MARK="$CURRENT_WG_MARK"
    else
        wg set "$VPN_IF" fwmark "$WG_MARK"
    fi
    RULES=$(ip rule list 2>/dev/null || true)
    TABLE_DEFAULT=$(ip route show table 200 default 2>/dev/null || true)
    if echo "$RULES" | grep -Eq "^[[:space:]]*500:.*fwmark ${WG_MARK}(/[^[:space:]]+)?[[:space:]].*lookup main" \
        && echo "$RULES" | grep -Eq "^[[:space:]]*1000:.*uidrange ${NURU_UID}-${NURU_UID}.*lookup 200" \
        && echo "$RULES" | grep -Eq "^[[:space:]]*1001:.*uidrange ${MOCHI_UID}-${MOCHI_UID}.*lookup 200" \
        && echo "$TABLE_DEFAULT" | grep -Fq " dev $VPN_IF" \
        && ! ip route show default 2>/dev/null | grep -qE 'dev (utun|tun|wg)'; then
        success "vpn policy routing already configured"
        exit 0
    fi
fi

ip rule del fwmark 0xca6c/0xca6c lookup main priority 500 2>/dev/null || true
ip rule del fwmark "$WG_MARK" lookup main priority 500 2>/dev/null || true
ip rule del uidrange "$NURU_UID"-"$NURU_UID" lookup 200 2>/dev/null || true
ip rule del uidrange "$MOCHI_UID"-"$MOCHI_UID" lookup 200 2>/dev/null || true
ip route flush table 200 2>/dev/null || true
while read -r route; do
    ip route del $route 2>/dev/null || true
done < <(ip route show default 2>/dev/null | grep -E "dev (utun|tun|wg)" || true)
ip route replace $MAIN_DEF 2>/dev/null || true

log "main table default: $MAIN_DEF"

ip rule add fwmark "$WG_MARK" lookup main priority 500 2>/dev/null || true
ip rule add uidrange "$NURU_UID"-"$NURU_UID" lookup 200 priority 1000 2>/dev/null || true
ip rule add uidrange "$MOCHI_UID"-"$MOCHI_UID" lookup 200 priority 1001 2>/dev/null || true

if [ -n "$VPN_IF" ]; then
    log "routing nuru and mochi through $VPN_IF"

    VPN_DEF=$(ip route show default dev "$VPN_IF" 2>/dev/null | head -1 || true)
    if [ -n "$VPN_DEF" ]; then
        ip route replace $VPN_DEF table 200 2>/dev/null || true
    else
        ip route replace default dev "$VPN_IF" table 200 2>/dev/null || true
    fi

    ip route show dev "$VPN_IF" 2>/dev/null | while read -r route; do
        [ -n "$route" ] && ip route replace $route table 200 2>/dev/null || true
    done

    success "table 200 configured via $VPN_IF"
else
    log "no vpn: routed services using physical ip"
    ip route replace $MAIN_DEF table 200 2>/dev/null || true
fi

log "--- policy routing rules ---"
ip rule list 2>/dev/null | head -10 || true
exit 0
NRSCRIPT
  sudo chmod 755 /usr/local/bin/nuru-route.sh

  if [ -f /etc/wireguard/wg0.conf ]; then
    log "bringing up wg0..."
    if ! sudo systemctl restart wg-quick@wg0; then
      fail "wireguard interface failed to start"
      exit 1
    fi
    if ! sudo wg show wg0 >/dev/null 2>&1; then
      fail "wireguard interface is unavailable after startup"
      exit 1
    fi
    sudo /usr/local/bin/nuru-route.sh
  fi

  cat <<NRROUTE | sudo tee /etc/systemd/system/nuru-route.service >/dev/null
[Unit]
Description=setup nuru vpn routing
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/flock /run/lyra-vpn-route.lock /usr/local/bin/nuru-route.sh
NRROUTE

  cat <<NRTIMER | sudo tee /etc/systemd/system/nuru-route.timer >/dev/null
[Unit]
Description=nuru vpn routing check

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=timers.target
NRTIMER

  sudo systemctl daemon-reload
  sudo systemctl enable nuru-route.timer >/dev/null 2>&1 || true
  sudo systemctl start nuru-route.timer 2>/dev/null || true
  sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
fi

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local octet
  for octet in "${BASH_REMATCH[@]:1}"; do
    [ "$octet" -le 255 ] || return 1
  done
}

PUBLIC_IP="${LYRA_PUBLIC_IP:-}"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP="$(curl -fs4 --max-time 8 https://ifconfig.me 2>/dev/null || true)"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP="$(dig +short txt ch whoami.cloudflare @1.0.0.1 2>/dev/null | tr -d '"' || true)"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1 || true)"

if ! is_ipv4 "$PUBLIC_IP"; then
  fail "couldn't detect the public ip, set LYRA_PUBLIC_IP"
  exit 1
fi
log "public ip: $PUBLIC_IP"

TURN_HOST="${TURN_HOST:-$PUBLIC_IP}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_USERNAME="${TURN_USERNAME:-lyly}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-$(openssl rand -hex 24)}"

backup_file /etc/eturnal.yml

sudo tee /etc/eturnal.yml >/dev/null <<EOF
eturnal:
  credentials:
    "$TURN_USERNAME": "$TURN_CREDENTIAL"
  realm: "$TURN_HOST"
  relay_ipv4_addr: "$PUBLIC_IP"
  listen:
    - ip: "0.0.0.0"
      port: $TURN_PORT
      transport: udp
    - ip: "0.0.0.0"
      port: $TURN_PORT
      transport: tcp
  relay_min_port: 49152
  relay_max_port: 65535
  log_dir: stdout
  log_level: warning
  modules:
    mod_log_stun: {}
    mod_stats_prometheus:
      ip: "127.0.0.1"
      port: 8081
EOF
if [ -f /etc/eturnal.yml ]; then
  success "/etc/eturnal.yml applied"
else
  fail "/etc/eturnal.yml was not created"
  exit 1
fi

sudo chown eturnal:eturnal /etc/eturnal.yml
sudo chmod 640 /etc/eturnal.yml
sudo systemctl stop coturn 2>/dev/null || true
sudo systemctl disable coturn 2>/dev/null || true
sudo fuser -k "$TURN_PORT"/tcp 2>/dev/null || true
sudo fuser -k "$TURN_PORT"/udp 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable eturnal
sudo systemctl restart eturnal

if ! systemctl is-active --quiet eturnal; then
  fail "eturnal failed to start"
  sudo journalctl -u eturnal --no-pager -n 20 >&2
  exit 1
fi

sudo systemctl enable docker >/dev/null 2>&1 || true
sudo systemctl start docker >/dev/null 2>&1 || true
if ! sudo docker info >/dev/null 2>&1; then
  fail "docker daemon is not ready"
  exit 1
fi
require_cmd docker
require_cmd caddy

export PATH="$HOME/.bun/bin:$PATH"
export IP="$PUBLIC_IP"

step "preparing chat and service config"
if [ -n "$CHAT_SETUP_PID" ]; then
  log "waiting for chat models and database"
  if ! wait "$CHAT_SETUP_PID"; then
    CHAT_SETUP_PID=""
    tail -n 40 "$CHAT_SETUP_LOG" >&2 || true
    fail "chat setup failed"
    exit 1
  fi
  CHAT_SETUP_PID=""
  success "chat models and database are ready"
else
  log "preparing chat models and database"
  if ! retry 3 "$BUN_BIN" run setup:chat; then
    fail "chat setup failed"
    exit 1
  fi
fi

sudo cp "$ROOT/target/release/mochi" /usr/local/bin/mochi
sudo chmod 755 /usr/local/bin/mochi
sudo mkdir -p /var/cache/lyra-mochi
COSMETICS_DIR=/var/cache/lyra-mochi/cosmetics
sudo mkdir -p "$COSMETICS_DIR"
if [ ! -s "$ROOT/services/mochi/cosmetics/shop_skus.json" ]; then
  fail "services/mochi/cosmetics/shop_skus.json is missing, profile cosmetics will stay empty"
fi
sudo find /var/cache/lyra-mochi \( ! -user mochi -o ! -group mochi \) -exec chown mochi:mochi {} +
CACHE_AVAILABLE_KB=$(df -Pk /var/cache/lyra-mochi | awk 'NR == 2 { print $4 }')
if [[ ! "$CACHE_AVAILABLE_KB" =~ ^[1-9][0-9]*$ ]]; then
  fail "available cache disk space could not be determined"
  exit 1
fi
sudo install -d -m 755 /etc/lyra
if ! sudo test -f "$BLOCK_PATH"; then
  sudo install -m 644 /dev/null "$BLOCK_PATH"
fi
if ! sudo test -s /etc/lyra/metrics.token; then
  openssl rand -hex 32 | sudo sh -c 'umask 077; cat > /etc/lyra/metrics.token'
fi
METRICS_TOKEN=$(sudo cat /etc/lyra/metrics.token)
if [[ ! "$METRICS_TOKEN" =~ ^[a-f0-9]{64}$ ]]; then
  fail "metrics credential is invalid"
  exit 1
fi
printf 'MOCHI_METRICS_TOKEN=%s\nNURU_METRICS_TOKEN=%s\n' "$METRICS_TOKEN" "$METRICS_TOKEN" \
  | sudo sh -c 'umask 077; cat > /etc/lyra/metrics.env'
sudo chmod 600 /etc/lyra/metrics.token /etc/lyra/metrics.env
for secret in nuru-ticket edge; do
  if ! sudo test -s "/etc/lyra/$secret.token"; then
    openssl rand -hex 32 | sudo sh -c "umask 077; cat > /etc/lyra/$secret.token"
  fi
done
NURU_TICKET_SECRET=$(sudo cat /etc/lyra/nuru-ticket.token)
EDGE_TOKEN=$(sudo cat /etc/lyra/edge.token)
if [[ ! "$NURU_TICKET_SECRET" =~ ^[a-f0-9]{64}$ || ! "$EDGE_TOKEN" =~ ^[a-f0-9]{64}$ ]]; then
  fail "connection credential is invalid"
  exit 1
fi
printf 'NURU_TICKET_SECRET=%s\n' "$NURU_TICKET_SECRET" \
  | sudo sh -c 'umask 077; cat > /etc/lyra/nuru-ticket.env'
sudo chmod 600 /etc/lyra/nuru-ticket.token /etc/lyra/edge.token /etc/lyra/nuru-ticket.env

ANIME_CACHE_GB=$((CACHE_AVAILABLE_KB / 1048576 / 5))
if [ "$ANIME_CACHE_GB" -lt 1 ]; then
  ANIME_CACHE_GB=1
elif [ "$ANIME_CACHE_GB" -gt 100 ]; then
  ANIME_CACHE_GB=100
fi
if [ "$MOCHI_AUTO" -eq 1 ] && [ "$MOCHI_INSTANCES" -gt "$ANIME_CACHE_GB" ]; then
  MOCHI_INSTANCES=$ANIME_CACHE_GB
  configure_mochi_instances
fi
ANIME_CACHE_GB=$((ANIME_CACHE_GB / MOCHI_INSTANCES))
if [ "$ANIME_CACHE_GB" -lt 1 ]; then
  fail "insufficient cache space for the requested mochi instance count"
  exit 1
fi
if [ "$ANIME_CACHE_GB" -lt 20 ]; then
  ANIME_CACHE_TTL_DAYS=3
elif [ "$ANIME_CACHE_GB" -lt 50 ]; then
  ANIME_CACHE_TTL_DAYS=5
else
  ANIME_CACHE_TTL_DAYS=7
fi
log "proxy instances: mochi=$MOCHI_INSTANCES, nuru=$NURU_INSTANCES"
log "anime cache per instance: ${ANIME_CACHE_GB} gb with ${ANIME_CACHE_TTL_DAYS} day retention"
configure_proxy_limits
sudo tee /etc/systemd/system/lyra-proxy.slice >/dev/null <<EOF
[Unit]
Description=lyra proxy resource budget

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
CPUQuota=$((PROXY_CPUS * 70))%
MemoryHigh=infinity
MemoryMax=50%
MemorySwapMax=0
TasksMax=4096
EOF

MOCHI_VPN_AFTER=""
MOCHI_VPN_PRESTART=""
if [ "$WG_ENABLED" -eq 1 ]; then
  MOCHI_VPN_AFTER=" wg-quick@wg0.service"
  MOCHI_VPN_PRESTART="ExecStartPre=!/usr/bin/flock /run/lyra-vpn-route.lock /usr/local/bin/nuru-route.sh"
fi
sudo tee /etc/systemd/system/nuru@.service >/dev/null <<EOF
[Unit]
Description=nuru proxy
After=network-online.target nss-lookup.target$MOCHI_VPN_AFTER
Wants=network-online.target$MOCHI_VPN_AFTER
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=nuru
Type=simple
Slice=lyra-proxy.slice
MemoryHigh=$((NURU_MEMORY_MB * 80 / 100))M
MemoryMax=${NURU_MEMORY_MB}M
OOMPolicy=kill
$MOCHI_VPN_PRESTART
ExecStart=/usr/local/bin/nuru /etc/nuru/config-%i.toml
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=10
Environment=RUST_LOG=warn
EnvironmentFile=/etc/lyra/metrics.env
EnvironmentFile=/etc/lyra/nuru-ticket.env
Environment=NURU_INSTANCES=$NURU_INSTANCES
Environment=LD_PRELOAD=$JEMALLOC_PATH
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

for ((i = 0; i < MOCHI_INSTANCES; i++)); do
  sudo mkdir -p "/var/cache/lyra-mochi/instance-$i/cache/stream"
  sudo chown -R mochi:mochi "/var/cache/lyra-mochi/instance-$i"
done
sudo tee /etc/systemd/system/mochi@.service >/dev/null <<EOF
[Unit]
Description=mochi reverse proxy and anime stream cache
After=network-online.target$MOCHI_VPN_AFTER
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=mochi
Group=mochi
Type=simple
Slice=lyra-proxy.slice
MemoryHigh=infinity
MemoryMax=infinity
OOMPolicy=kill
WorkingDirectory=/var/cache/lyra-mochi/instance-%i
EnvironmentFile=/etc/mochi/instance-%i.env
EnvironmentFile=/etc/lyra/metrics.env
$MOCHI_VPN_PRESTART
ExecStartPre=-+/usr/bin/flock /run/lyra-cosmetics.lock /usr/bin/install -C -p -o mochi -g mochi -m 644 "$ROOT/services/mochi/cosmetics/shop_skus.json" "$COSMETICS_DIR/source.json"
ExecStart=/usr/local/bin/mochi
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=15
Environment=RUST_LOG=warn
Environment=MOCHI_HOST=127.0.0.1
Environment=MOCHI_TRUSTED_PROXIES=127.0.0.1,::1
Environment=MOCHI_CLIENT_REQUESTS_PER_SECOND=400
Environment=MOCHI_CLIENT_BURST=1600
Environment=MOCHI_CLIENT_CONCURRENCY=$MOCHI_CLIENT_CONCURRENCY
Environment=MOCHI_CLIENT_WEBSOCKETS=64
Environment=MIMALLOC_ALLOW_THP=0
Environment=MOCHI_INSTANCES=$MOCHI_INSTANCES
Environment=MOCHI_STREAM_CACHE_GB=$ANIME_CACHE_GB
Environment=MOCHI_STREAM_CACHE_TTL_DAYS=$ANIME_CACHE_TTL_DAYS
Environment=MOCHI_COSMETICS_DIR=$COSMETICS_DIR
Environment=MOCHI_COSMETICS_SOURCE=$COSMETICS_DIR/source.json
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo mkdir -p /etc/mochi
for ((i = 0; i < MOCHI_INSTANCES; i++)); do
  printf 'MOCHI_PORT=%s\n' "$((4100 + i))" | sudo tee "/etc/mochi/instance-$i.env" >/dev/null
done
printf 'MOCHI_COSMETICS_REFRESH_HOURS=6\n' | sudo tee -a /etc/mochi/instance-0.env >/dev/null

step "building the site"
LYRA_WISP_PATH="/$("$BUN_BIN" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')/"
LYRA_WISP_PATH="$LYRA_WISP_PATH" "$BUN_BIN" --bun run build

sudo mkdir -p /etc/nuru /etc/systemd/system/caddy.service.d

backup_file /etc/systemd/system/caddy.service.d/override.conf
sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<EOF
[Service]
Environment="NO_PROXY=127.0.0.1"
LimitNOFILE=1048576
Restart=on-failure
RestartSec=5
EOF
sudo systemctl daemon-reload

backup_file /etc/caddy/Caddyfile

install_block_caddy
sudo install -d -m 750 -o caddy -g caddy /var/log/caddy
sudo touch /var/log/caddy/access.json
sudo chown caddy:caddy /var/log/caddy/access.json
sudo chmod 640 /var/log/caddy/access.json
sudo install -m 640 -o root -g caddy /dev/null /etc/caddy/Caddyfile
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
{
    email sefiicc@gmail.com

    servers {
        protocols h1 h2 h3
    }

    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
}

import /etc/caddy/block.caddy

(mochi_stream) {
    @mochi_stream {
        path /stream/*
        not path /stream/anime* /stream/watch
    }
    reverse_proxy @mochi_stream $MOCHI_UPSTREAMS {
        lb_policy query anilist_id {
            fallback query session {
                fallback least_conn
            }
        }
        health_uri /health
        health_interval 10s
        header_up Host {upstream_hostport}
        header_up X-Real-IP {args[0]}
        header_up X-Forwarded-For {args[0]}
        flush_interval 10ms
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            response_header_timeout 30s
        }
    }
}

http://127.0.0.1:4000 {
    bind 127.0.0.1
    import mochi_stream {http.request.header.X-Real-IP}
    reverse_proxy $MOCHI_UPSTREAMS {
        lb_policy uri_hash
        unhealthy_request_count $MOCHI_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        header_up X-Forwarded-For {http.request.header.X-Real-IP}
        flush_interval 10ms
    }
}

http://127.0.0.1:4001 {
    bind 127.0.0.1
    reverse_proxy $NURU_UPSTREAMS {
        lb_policy least_conn
        unhealthy_request_count $NURU_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        flush_interval -1
    }
}

:443 {
    tls {
        on_demand
    }

    import block

    log lyra_access {
        output file /var/log/caddy/access.json {
            mode 0640
            roll_size 64MiB
            roll_keep 14
            roll_keep_for 336h
        }
        format filter {
            wrap json
            fields {
                request>headers delete
                request>uri delete
                request>host delete
                request>tls delete
                request>remote_port delete
                request>remote_ip ip_mask 24 48
                request>client_ip ip_mask 24 48
                resp_headers delete
            }
        }
    }
    map {path} {lyra_route} {
        ~^/api/auth/ auth
        ~^/api/sync/ sync
        ~^/api/anime/ anime
        ~^/api/watch/ watch
        ~^/api/chat/ chat
        ~^/api/static/ static_gateway
        /api/presence presence
        /api/search/suggestions suggestions
        ~^/stream/anime player
        /stream/watch player
        ~^/stream/ stream
        ~^/!!folio/ folio
        ~^/!!raw/ raw
        ~^/!!/ proxy
        ~^/!cover!/ cover
        ~^$LYRA_WISP_PATH wisp
        default frontend
    }
    log_append route {lyra_route}
    log_append request_id {http.request.uuid}

    map "{http.request.header.X-Lyra-Edge} {http.request.header.CloudFront-Viewer-Address}" {lyra_client_ip} {
        "~^$EDGE_TOKEN ([0-9A-Fa-f:.]+):[0-9]+\$" "\${1}"
        default {http.request.remote.host}
    }

    @internal_metrics path /metrics /stream/metrics /!!folio/metrics /api/auth/metrics /api/anime/metrics
    header @internal_metrics Cache-Control no-store
    respond @internal_metrics "metrics access denied... /ᐠ - ˕ -マ" 403

    @compressible {
        not path /stream/* /api/static/v1/* /api/chat/stream
    }
    encode @compressible zstd gzip

    handle /lyra/health {
        rewrite * /health
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /tls-approval/health {
        rewrite * /health
        reverse_proxy 127.0.0.1:3001 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /cloudsync/health {
        rewrite * /health
        reverse_proxy 127.0.0.1:4005 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /isao/health {
        rewrite * /health
        reverse_proxy 127.0.0.1:6001 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /mochi/health {
        rewrite * /health
        reverse_proxy $MOCHI_UPSTREAMS {
            lb_policy least_conn
            unhealthy_request_count $MOCHI_REQUESTS
            fail_duration 10s
            health_uri /health
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /nuru/health {
        rewrite * /health
        reverse_proxy $NURU_UPSTREAMS {
            lb_policy least_conn
            unhealthy_request_count $NURU_REQUESTS
            fail_duration 10s
            health_uri /health
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /eturnal/health {
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /health {
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    @nuru_routes {
        path $LYRA_WISP_PATH*
    }
    reverse_proxy @nuru_routes $NURU_UPSTREAMS {
        lb_policy least_conn
        unhealthy_request_count $NURU_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        max_fails 4
        header_up Host {http.request.hostport}
        header_up X-Real-IP {lyra_client_ip}
        flush_interval -1
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            read_buffer 65536
            write_buffer 65536
        }
    }

    import mochi_stream {lyra_client_ip}

    handle /api/static/v1/* {
        reverse_proxy 127.0.0.1:4444 {
            header_up X-Real-IP {lyra_client_ip}
            flush_interval 10ms
            transport http {
                keepalive 120s
                dial_timeout 5s
                response_header_timeout 75s
            }
        }
    }

    @mochi_routes {
        path /!!raw/* /!!/* /!!folio/* /!!cosmetics/* /!cover!/*
    }
    reverse_proxy @mochi_routes $MOCHI_UPSTREAMS {
        lb_policy uri_hash
        unhealthy_request_count $MOCHI_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        max_fails 4
        header_up Host {upstream_hostport}
        header_up X-Real-IP {lyra_client_ip}
        header_up X-Forwarded-For {lyra_client_ip}
        flush_interval -1
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            response_header_timeout 30s
        }
    }

    @static_assets {
        path /assets/* /b/* /bmux/* /epoxy/* /libcurl/*
    }
    reverse_proxy @static_assets h2c://127.0.0.1:4444 {
        header_up X-Real-IP {lyra_client_ip}
    }

    handle /api/chat/* {
        header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        reverse_proxy 127.0.0.1:4444 {
            header_up X-Real-IP {lyra_client_ip}
            flush_interval -1
            transport http {
                keepalive 120s
                dial_timeout 5s
                response_header_timeout 120s
            }
        }
    }

    handle /api/auth/* {
        reverse_proxy 127.0.0.1:4005 {
            header_up X-Real-IP {lyra_client_ip}
            header_up X-Forwarded-For {lyra_client_ip}
        }
    }

    handle /api/sync/* {
        reverse_proxy 127.0.0.1:4005 {
            header_up X-Real-IP {lyra_client_ip}
            header_up X-Forwarded-For {lyra_client_ip}
        }
    }

    handle /api/anime/* {
        reverse_proxy 127.0.0.1:6001 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    handle /api/watch/* {
        reverse_proxy 127.0.0.1:6001 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    @lyra_player {
        path /stream/anime* /stream/watch
    }
    reverse_proxy @lyra_player h2c://127.0.0.1:4444 {
        header_up X-Real-IP {lyra_client_ip}
    }

    handle /s {
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {lyra_client_ip}
        }
    }

    reverse_proxy 127.0.0.1:4444 {
        header_up X-Real-IP {lyra_client_ip}
        transport http {
            keepalive 120s
            keepalive_idle_conns 512
            keepalive_idle_conns_per_host 64
            dial_timeout 5s
        }
    }
}

:80 {
    import block
    redir https://{host}{uri} permanent
}
EOF
if [ -f /etc/caddy/Caddyfile ]; then
  success "/etc/caddy/Caddyfile applied"
else
  fail "/etc/caddy/Caddyfile was not created"
  exit 1
fi

if [ ! -f "$ROOT/services/nuru/config.toml" ]; then
  fail "nuru config was not found at $ROOT/services/nuru/config.toml"
  exit 1
fi
if [ "$WG_ENABLED" -eq 1 ] && [ -f /etc/wireguard/wg0.conf ]; then
  VPN_DNS_LIST=$(sed -n -E 's/^[[:space:]]*(DNS|#[[:space:]]*LyraVPNDNS)[[:space:]]*=[[:space:]]*(.*)$/\2/ip' /etc/wireguard/wg0.conf 2>/dev/null | tr -d ' ' | tr ',' '\n' | grep -v '^$' || true)
  if [ -n "$VPN_DNS_LIST" ]; then
    DNS_TOML="["
    first=true
    while IFS= read -r dns; do
      if [ -n "$dns" ]; then
        [ "$first" = false ] && DNS_TOML+=", "
        DNS_TOML+="\"$dns\""
        first=false
      fi
    done <<<"$VPN_DNS_LIST"
    DNS_TOML+="]"
    sed -i "s|^dns_servers = \[.*\]|dns_servers = $DNS_TOML|" "$ROOT/services/nuru/config.toml"
    success "nuru dns updated to use vpn dns: $DNS_TOML"
  fi
fi
sed -e '/^[[:space:]]*websocket_origin_scheme[[:space:]]*=/d' \
    -e '/^\[server\]$/a\
websocket_origin_scheme = "https"' \
    -e "s|^prefix = .*|prefix = \"${LYRA_WISP_PATH%/}\"|" \
    "$ROOT/services/nuru/config.toml" | sudo tee /etc/nuru/config.toml >/dev/null
for ((i = 0; i < NURU_INSTANCES; i++)); do
  sed -e "s|^bind = .*|bind = [\"tcp\", \"127.0.0.1:$((4200 + i))\"]|" \
    -e '/^[[:space:]]*stats_endpoint[[:space:]]*=/d' \
    -e '/^\[server\]$/a\
stats_endpoint = ["tcp", "127.0.0.1:'"$((4300 + i))"'"]' \
    /etc/nuru/config.toml | sudo tee "/etc/nuru/config-$i.toml" >/dev/null
done
if [ -f /etc/nuru/config.toml ]; then
  success "/etc/nuru/config.toml applied"
  sudo chown -R nuru:nuru /etc/nuru
else
  fail "/etc/nuru/config.toml was not created"
  exit 1
fi

calc_mem() {
  local pct=$1 min=$2 max=$3
  local val=$((PROXY_RAM_MB * pct / 100))
  [ "$val" -lt "$min" ] && val=$min
  [ "$val" -gt "$max" ] && val=$max
  echo "$val"
}

LYRA_MEM="$(calc_mem 16 256 2560)M"
CLOUDSYNC_MEM="$(calc_mem 6 128 768)M"
ISAO_MEM="$(calc_mem 8 256 768)M"
log "memory restart thresholds — lyra: $LYRA_MEM, cloudsync: $CLOUDSYNC_MEM, isao: $ISAO_MEM"

"$BUN_BIN" "$PM2_BIN" stop all >/dev/null 2>&1 || true
"$BUN_BIN" "$PM2_BIN" delete all >/dev/null 2>&1 || true

SETUP_UMASK=$(umask)
umask 077
tee ecosystem.config.cjs >/dev/null <<EOF
module.exports = {
  apps: [
    {
      name: "tls-approval",
      script: "$BUN_BIN",
      args: "run services/tls-approval/server.js",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",
      max_restarts: 10,
      min_uptime: 10000,
      max_memory_restart: "256M",
      env: {
        TZ: "UTC",
        TLS_METRICS_TOKEN: "$METRICS_TOKEN"
      }
    },
    {
      name: "lyra",
      cwd: "$ROOT",
      script: "$BUN_BIN",
      args: "server/prod.mjs",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",
      max_restarts: 5,
      min_uptime: 15000,
      kill_timeout: 10000,
      max_memory_restart: "$LYRA_MEM",
      env: {
        NODE_ENV: "production",
        PORT: "4444",
        HOST: "127.0.0.1",
        LYRA_METRICS_TOKEN: "$METRICS_TOKEN",
        MOCHI_ORIGIN: "http://127.0.0.1:4000",
        LYRA_WISP_PATH: "$LYRA_WISP_PATH",
        NURU_TICKET_SECRET: "$NURU_TICKET_SECRET",
        LYRA_MEMORY_MB: "${LYRA_MEM%M}",
        LYRA_API_LIMIT_MAX: "$((PROXY_CPUS * 1000))",
        WEBRTC_TURN_ENABLED: "1",
        WEBRTC_FORCE_RELAY: "1",
        TURN_HOST: "$TURN_HOST",
        TURN_PORT: "$TURN_PORT",
        TURN_USERNAME: "$TURN_USERNAME",
        TURN_CREDENTIAL: "$TURN_CREDENTIAL"
      }
    },
    {
      name: "cloudsync",
      script: "$ROOT/target/release/cloudsync",
      cwd: "$ROOT/services/cloudsync",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",
      max_memory_restart: "$CLOUDSYNC_MEM",
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
       env: {
         RUST_LOG: "warn",
         CLOUDSYNC_DB_PATH: "$ROOT/services/cloudsync/.db",
         CLOUDSYNC_MEMORY_MB: "${CLOUDSYNC_MEM%M}"
       }
    },
EOF
tee -a ecosystem.config.cjs >/dev/null <<EOF
    {
      name: "isao",
      script: "$BUN_BIN",
      args: "services/isao/index.ts",
      cwd: "$ROOT",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",
      max_memory_restart: "$ISAO_MEM",
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
        ISAO_PORT: "6001",
        ISAO_HOST: "127.0.0.1"
      }
    },
EOF
tee -a ecosystem.config.cjs >/dev/null <<'EOF'
  ]
};
EOF
chmod 600 ecosystem.config.cjs
umask "$SETUP_UMASK"

if ! install_block_firewall; then
  fail "firewall blocking could not be applied"
fi

if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS=$(sudo ufw status)
  if grep -q "Status: active" <<<"$UFW_STATUS"; then
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow 443/udp
    sudo ufw allow "$TURN_PORT"/tcp
    sudo ufw allow "$TURN_PORT"/udp
    sudo ufw allow 49152:65535/udp
  fi
fi

read_opaque_server_setup() {
  OPAQUE_SERVER_SETUP=""
  if [ -f "$1" ]; then
    OPAQUE_SERVER_SETUP=$(grep -m 1 "^OPAQUE_SERVER_SETUP=." "$1" | cut -d '=' -f2-) || OPAQUE_SERVER_SETUP=""
  fi
}

new_opaque_server_setup() {
  OPAQUE_SERVER_SETUP=$(cd "$ROOT" && "$BUN_BIN" -e 'const opaque = await import("@serenity-kit/opaque"); await opaque.ready; console.log(opaque.server.createSetup());') || OPAQUE_SERVER_SETUP=""
  if [ -z "$OPAQUE_SERVER_SETUP" ]; then
    fail "opaque server setup could not be generated"
    exit 1
  fi
}

recover_opaque_server_setup() {
  read_opaque_server_setup "$ROOT/services/cloudsync/.env"
  if [ -z "$OPAQUE_SERVER_SETUP" ]; then
    new_opaque_server_setup
  fi
}

if [ ! -f .env ]; then
  JWT_SECRET=$(openssl rand -hex 64)
  SYNC_SECRET=$(openssl rand -hex 32)
  recover_opaque_server_setup
  echo "JWT_SECRET=$JWT_SECRET" >.env
  echo "SYNC_SECRET=$SYNC_SECRET" >>.env
  echo "OPAQUE_SERVER_SETUP=$OPAQUE_SERVER_SETUP" >>.env
  chmod 600 .env
else
  if ! grep -q "JWT_SECRET" .env; then
    JWT_SECRET=$(openssl rand -hex 64)
    echo "" >>.env
    echo "JWT_SECRET=$JWT_SECRET" >>.env
  else
    JWT_SECRET=$(grep "^JWT_SECRET=" .env | cut -d '=' -f2)
  fi

  if ! grep -q "SYNC_SECRET" .env; then
    SYNC_SECRET=$(openssl rand -hex 32)
    echo "SYNC_SECRET=$SYNC_SECRET" >>.env
  else
    SYNC_SECRET=$(grep "^SYNC_SECRET=" .env | cut -d '=' -f2)
  fi

  read_opaque_server_setup .env
  if [ -z "$OPAQUE_SERVER_SETUP" ]; then
    recover_opaque_server_setup
    echo "OPAQUE_SERVER_SETUP=$OPAQUE_SERVER_SETUP" >>.env
  fi
fi

chmod 600 .env

if [ -d "$ROOT/services/cloudsync" ]; then
  ROOT_OPAQUE_SERVER_SETUP=$OPAQUE_SERVER_SETUP
  read_opaque_server_setup "$ROOT/services/cloudsync/.env"
  CLOUDSYNC_OPAQUE_SERVER_SETUP=$OPAQUE_SERVER_SETUP
  OPAQUE_SERVER_SETUP=$ROOT_OPAQUE_SERVER_SETUP
  if [ -n "$ROOT_OPAQUE_SERVER_SETUP" ] && [ -n "$CLOUDSYNC_OPAQUE_SERVER_SETUP" ] && [ "$ROOT_OPAQUE_SERVER_SETUP" != "$CLOUDSYNC_OPAQUE_SERVER_SETUP" ]; then
    fail "opaque server setup differs between .env files; resolve it before continuing"
    exit 1
  fi
  echo "JWT_SECRET=$JWT_SECRET" >"$ROOT/services/cloudsync/.env"
  echo "SYNC_SECRET=$SYNC_SECRET" >>"$ROOT/services/cloudsync/.env"
  echo "OPAQUE_SERVER_SETUP=$OPAQUE_SERVER_SETUP" >>"$ROOT/services/cloudsync/.env"
  echo "COOKIE_SECURE=true" >>"$ROOT/services/cloudsync/.env"
  chmod 600 "$ROOT/services/cloudsync/.env"
  if [ -f "$ROOT/services/cloudsync/.env" ]; then
    success "cloudsync environment applied"
  else
    fail "cloudsync environment was not created"
    exit 1
  fi
fi

if [ ! -f "$ROOT/services/cloudsync/.db" ]; then
  touch "$ROOT/services/cloudsync/.db"
fi

if [ -f "$ROOT/services/cloudsync/.db" ]; then
  chmod 600 "$ROOT/services/cloudsync/.db"
  chmod 600 "$ROOT/services/cloudsync/.db-shm" 2>/dev/null || true
  chmod 600 "$ROOT/services/cloudsync/.db-wal" 2>/dev/null || true
fi

step "starting services"
sudo systemctl daemon-reload
sudo systemctl start lyra-proxy.slice
PROXY_CGROUP=$(systemctl show --property=ControlGroup --value lyra-proxy.slice)
if [ -z "$PROXY_CGROUP" ] || ! retry 5 proxy_limits_active "/sys/fs/cgroup$PROXY_CGROUP"; then
    fail "proxy resource limits could not be activated"
    exit 1
fi
log "starting $MOCHI_INSTANCES mochi instances"
sudo systemctl enable "${MOCHI_SERVICES[@]}" >/dev/null 2>&1
sudo systemctl restart "${MOCHI_SERVICES[@]}"
for svc in "${MOCHI_SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    fail "mochi instance failed to start"
    sudo journalctl -u "$svc" --no-pager -n 30 >&2
    exit 1
  fi
done

"$BUN_BIN" "$PM2_BIN" start ecosystem.config.cjs --update-env
"$BUN_BIN" "$PM2_BIN" save
sudo env PATH="$PATH:$HOME/.bun/bin" "$BUN_BIN" "$PM2_BIN" startup systemd -u "$USER" --hp "$HOME"
PM2_SYSTEMD_SERVICE="pm2-$USER.service"
if systemctl cat "$PM2_SYSTEMD_SERVICE" >/dev/null 2>&1; then
  sudo mkdir -p "/etc/systemd/system/$PM2_SYSTEMD_SERVICE.d"
  cat <<EOF | sudo tee "/etc/systemd/system/$PM2_SYSTEMD_SERVICE.d/limits.conf" >/dev/null
[Service]
LimitNOFILE=1048576
ExecStart=
ExecStart="$BUN_BIN" "$PM2_BIN" resurrect
ExecReload=
ExecReload="$BUN_BIN" "$PM2_BIN" reload all
ExecStop=
ExecStop="$BUN_BIN" "$PM2_BIN" kill
EOF
  sudo systemctl daemon-reload
  "$BUN_BIN" "$PM2_BIN" kill >/dev/null 2>&1 || true
  sudo systemctl restart "$PM2_SYSTEMD_SERVICE"
fi

log "starting nuru systemd service..."
sudo systemctl enable "${NURU_SERVICES[@]}" >/dev/null 2>&1
sudo systemctl restart "${NURU_SERVICES[@]}"
sleep 2
for svc in "${NURU_SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    fail "nuru instance failed to start"
    sudo journalctl -u "$svc" --no-pager -n 10 >&2
    exit 1
  fi
done
success "nuru instances are running"

PM2_SVCS=(tls-approval lyra cloudsync isao)
for svc in "${PM2_SVCS[@]}"; do
  if ! "$BUN_BIN" "$PM2_BIN" jlist | jq -e --arg name "$svc" \
    '.[] | select(.name == $name and .pm2_env.status == "online")' >/dev/null; then
    fail "pm2 service failed to start: $svc"
    exit 1
  fi
done

health_ok() {
  local response
  if [[ "$1" = */api/chat/me ]]; then
    response="$(curl --silent --max-time 3 "$1")" || return 1
    jq -e '.code == "CHAT_LOGIN_REQUIRED"' <<< "$response" >/dev/null 2>&1
    return
  fi
  response="$(curl --fail --silent --max-time 3 "$1")" || return 1
  if [[ "$1" = */api/static/v1/status ]]; then
    jq -e '.protocol == 2 and .enabled == true' <<< "$response" >/dev/null 2>&1
  else
    [ "$response" = "oki" ]
  fi
}

for upstream in $MOCHI_UPSTREAMS $NURU_UPSTREAMS; do
  if ! retry 10 health_ok "http://$upstream/health"; then
    fail "proxy worker health check failed"
    exit 1
  fi
done
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl restart caddy

step "checking health"
SERVICE_HEALTH_CHECKS=(
  "tls-approval|http://127.0.0.1:3001/health"
  "lyra|http://127.0.0.1:4444/health"
  "static gateway|http://127.0.0.1:4444/api/static/v1/status"
  "cloudsync|http://127.0.0.1:4005/health"
  "isao|http://127.0.0.1:6001/health"
  "mochi|http://127.0.0.1:4000/health"
  "nuru|http://127.0.0.1:4001/health"
  "eturnal|http://127.0.0.1:4444/eturnal/health"
  "chat|http://127.0.0.1:4444/api/chat/me"
)
for ((i = 0; i < MOCHI_INSTANCES; i++)); do
  SERVICE_HEALTH_CHECKS+=("mochi@$i|http://127.0.0.1:$((4100 + i))/health")
done
for ((i = 0; i < NURU_INSTANCES; i++)); do
  SERVICE_HEALTH_CHECKS+=("nuru@$i|http://127.0.0.1:$((4200 + i))/health")
done
for health_check in "${SERVICE_HEALTH_CHECKS[@]}"; do
  service_name="${health_check%%|*}"
  service_url="${health_check#*|}"
  if ! retry 10 health_ok "$service_url"; then
    fail "$service_name health check failed"
    exit 1
  fi
done
printf '%s    took %s%s\n' "$DIM" "$(elapsed SECONDS-STEP_STARTED_AT)" "$RESET"

printf '\n'
success "lyra is running on $PUBLIC_IP after $(elapsed SECONDS-SETUP_STARTED_AT)"
log "workers     $MOCHI_INSTANCES mochi, $NURU_INSTANCES nuru"
log "logs        $BUN_BIN $PM2_BIN logs, journalctl -u mochi@0 -u nuru@0 -f"
log "block ips   bash setup.sh --block"
log "chat owner  open chat once while logged in, then run: bun run chat role <username> owner"
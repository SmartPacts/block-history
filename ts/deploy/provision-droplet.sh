#!/usr/bin/env bash
# provision-droplet.sh — prepare a fresh Ubuntu 24.04 droplet to run the block-history feeder.
#
# Run ON THE DROPLET, as root. Download this script from the exact commit you are pinning, then
# pass that commit's full id:
#
#     curl -fsSLo provision-droplet.sh \
#       https://raw.githubusercontent.com/SmartPacts/block-history/<commit>/ts/deploy/provision-droplet.sh
#     bash provision-droplet.sh <commit>
#
# The code is cloned from BH_REPO, by default the public GitHub repository. Any git source works —
# a local path or a bundle — which is how the script is rehearsed before a release.
#
# What it does: installs a checksum-pinned Node, clones EXACTLY the pinned commit and refuses any
# other, creates an unprivileged service user, generates the feeder's signing key ON THIS MACHINE
# (the secret never leaves it and is never printed), installs the service and log rotation, then
# proves the droplet can see mainnet under the same sandbox the service will run in.
#
# What it never does: start the feeder, sign, or send. Enabling the service is what starts sending
# mainnet transactions, and that is the operator's step, after the module is deployed.
#
# Safe to re-run. Every step checks before it acts, and an existing key is NEVER regenerated —
# regenerating it would orphan whatever the old account holds.
set -euo pipefail

NODE_VERSION="v24.21.0"
# node-v24.21.0-linux-x64.tar.xz, read in full from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
NODE_SHA256="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
APP=/opt/block-history
SVC_USER=blockhistory
LOG_DIR=/var/log/block-history
MAINNET_HOST="https://chainweb.eckowallet.com"
STREAM_SECONDS=180   # the longest mainnet block interval measured over 40,000 blocks was 136 s

PIN="${1:?usage: provision-droplet.sh <full-commit-id>}"
REPO="${BH_REPO:-https://github.com/SmartPacts/block-history.git}"

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
skip() { printf '    SKIPPED: %s\n' "$*"; SKIPPED+=("$*"); }
die()  { printf '\n!! STOPPED: %s\n   Nothing after this point was done.\n' "$*" >&2; exit 1; }
SKIPPED=()

HAVE_SYSTEMD=0; [ -d /run/systemd/system ] && HAVE_SYSTEMD=1
IN_CONTAINER=0; [ -f /.dockerenv ] && IN_CONTAINER=1

# ---------------------------------------------------------------------------------------------
say "0. Preconditions"
[ "$(id -u)" = 0 ] || die "run as root"
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu required (found ${ID:-unknown})"
[ "$(uname -m)" = x86_64 ] || die "x86_64 required — the Node pin is for linux-x64"
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || die "the pin must be a full 40-character commit id, got: $PIN"
if [ $HAVE_SYSTEMD = 0 ] && [ $IN_CONTAINER = 0 ]; then die "no systemd and not a container — unsupported host"; fi
[ $IN_CONTAINER = 1 ] && echo "    NOTE: running in a CONTAINER (rehearsal). Firewall, swap and service steps will be skipped; SSH hardening runs only if sshd is installed."
ok "Ubuntu ${VERSION_ID:-?}, x86_64, root"

# ---------------------------------------------------------------------------------------------
say "1. Swap — a small box can spike past its RAM while installing"
if [ $IN_CONTAINER = 1 ]; then skip "swap (container)"
elif [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then ok "swap already present"   # no pipe: see step 5
else
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "1 GiB swap enabled and made permanent"
fi

# ---------------------------------------------------------------------------------------------
say "2. System packages"
# A fresh droplet often runs its own apt jobs in its first minutes: cloud-init, then the daily
# upgrade timer, which is Persistent and so fires soon after first boot. Wait for cloud-init, then
# retry apt while ANY apt/dpkg lock is held. Measured on apt 2.8: -o DPkg::Lock::Timeout makes
# `install` wait for the dpkg lock, but NOT `update` for the package-list lock — that still failed
# in 1 s — so the retry is what covers every lock; the option only shortens waits within a try.
if command -v cloud-init >/dev/null 2>&1; then timeout 600 cloud-init status --wait >/dev/null 2>&1 || true; fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # no prompts, no service restarts mid-install
apt_retry() {
  local i out
  for i in $(seq 1 60); do
    if out=$(apt-get -o DPkg::Lock::Timeout=60 -qq "$@" 2>&1); then return 0; fi
    # Only a held lock is worth waiting for; any other failure is real and is reported at once.
    grep -q 'Could not get lock' <<<"$out" || { printf '%s\n' "$out" >&2; return 1; }
    [ "$i" = 1 ] && echo "    NOTE: another apt job holds a lock (normal on a fresh droplet) — waiting for it, up to ~10 minutes"
    sleep 10
  done
  printf '%s\n' "$out" >&2; return 1
}
apt_retry update || die "apt-get update failed"
apt_retry install -y git ca-certificates curl xz-utils ufw unattended-upgrades logrotate || die "installing system packages failed"
ok "git, curl, ufw, unattended-upgrades, logrotate"

say "3. Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
ok "security updates install themselves daily"

# ---------------------------------------------------------------------------------------------
say "4. Firewall — nothing listens except SSH; the feeder only makes outbound connections"
if [ $IN_CONTAINER = 1 ]; then skip "firewall (container)"
else
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
  ok "inbound: SSH only"
fi

say "5. SSH — keys only"
# sshd keeps the FIRST value it reads for each setting, and DigitalOcean's cloud-init writes
# 50-cloud-init.conf. So this file is named 01-… to be read first: measured in a clean Ubuntu 24.04,
# the same file named 60-… was silently overridden by a cloud-init "PasswordAuthentication yes".
SSHD_DROPIN=/etc/ssh/sshd_config.d/01-block-history.conf
if ! command -v sshd >/dev/null 2>&1 || [ ! -d /etc/ssh/sshd_config.d ]; then
  skip "SSH hardening (no sshd on this host)"
elif [ ! -s /root/.ssh/authorized_keys ]; then
  # Refusing here is the point: turning passwords off with no key installed locks you out for good.
  skip "password login left as it was — /root/.ssh/authorized_keys is empty, and disabling passwords now would lock you out"
else
  mkdir -p /run/sshd
  if ! pre=$(sshd -t 2>&1); then
    skip "SSH hardening — sshd's existing configuration already fails its own check, so it was left alone: ${pre:0:160}"
  else
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > "$SSHD_DROPIN"
    if ! err=$(sshd -t 2>&1); then
      rm -f "$SSHD_DROPIN"; die "the hardening made sshd's own check fail, so it was removed: ${err:0:160}"
    fi
    # Read the setting sshd will ACTUALLY use, not the file just written. Captured first and matched
    # without a pipe: `sshd -T | grep -q` under pipefail fails whenever grep exits early and sshd -T
    # dies of SIGPIPE — measured: it reported "still ON" for a correctly hardened host.
    if ! effective=$(sshd -T 2>/dev/null); then
      rm -f "$SSHD_DROPIN"; die "could not read sshd's effective configuration, so the hardening was removed"
    fi
    if ! grep -qx 'passwordauthentication no' <<<"$effective"; then
      rm -f "$SSHD_DROPIN"; die "password login is still ON in sshd's effective configuration (another file overrides it), so the hardening was removed"
    fi
    if [ "$HAVE_SYSTEMD" = 1 ]; then
      systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service 2>/dev/null \
        || echo "    NOTE: ssh could not be reloaded now; the setting applies the next time ssh starts"
    fi
    ok "password login disabled in sshd's effective configuration; your SSH key still works"
  fi
fi

# ---------------------------------------------------------------------------------------------
say "6. Node $NODE_VERSION, verified against its pinned checksum"
if [ -x "/opt/node-$NODE_VERSION/bin/node" ]; then ok "already installed"
else
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c - >/dev/null || { rm -rf "$tmp"; die "Node tarball checksum MISMATCH — refusing to install it"; }
  mkdir -p "/opt/node-$NODE_VERSION"
  tar -xJf "$tmp/node.tar.xz" -C "/opt/node-$NODE_VERSION" --strip-components=1
  rm -rf "$tmp"
  ok "checksum verified, installed"
fi
for b in node npm npx; do ln -sf "/opt/node-$NODE_VERSION/bin/$b" "/usr/local/bin/$b"; done
[ "$(/usr/local/bin/node --version)" = "$NODE_VERSION" ] || die "node reports $(/usr/local/bin/node --version), not $NODE_VERSION"
ok "node $(/usr/local/bin/node --version)"

# ---------------------------------------------------------------------------------------------
say "7. Service user '$SVC_USER' — no login shell, no sudo"
if id "$SVC_USER" >/dev/null 2>&1; then ok "exists"
else useradd --system --home-dir "/var/lib/$SVC_USER" --create-home --shell /usr/sbin/nologin "$SVC_USER"; ok "created"; fi

# ---------------------------------------------------------------------------------------------
say "8. The code, at exactly the pinned commit"
# The code is owned by root and only READABLE by the service, so a compromised feeder cannot
# rewrite what it runs. Only its key directory belongs to it.
G="git -c safe.directory=$APP -C $APP"
if [ ! -d "$APP/.git" ]; then git clone -q "$REPO" "$APP" || die "could not clone $REPO"; ok "cloned $REPO"
else $G fetch -q --tags "$REPO" '+refs/heads/*:refs/remotes/origin/*' || die "could not fetch $REPO"; ok "fetched $REPO into the existing clone"; fi
$G -c advice.detachedHead=false checkout -q "$PIN" 2>/dev/null || die "commit $PIN is not in $REPO — a mistyped commit, or the wrong repository"
HEAD=$($G rev-parse HEAD)
[ "$HEAD" = "$PIN" ] || die "checked out $HEAD, which is not the pinned $PIN"
$G fsck --full --no-progress >/dev/null 2>&1 || die "git fsck found corruption in the repository"
[ -z "$($G status --porcelain)" ] || die "the working tree is not clean at the pinned commit"
# The script you ran must be the one the pinned commit contains, or the pin means nothing.
cmp -s "$0" "$APP/ts/deploy/provision-droplet.sh" || die "this script differs from the copy inside commit $PIN — download it from that exact commit"
ok "HEAD $HEAD, fsck clean, working tree clean, this script matches the pinned copy"

# ---------------------------------------------------------------------------------------------
say "9. Dependencies, exactly as locked"
cd "$APP/ts"
# npm verifies every package against the sha512 integrity recorded in package-lock.json.
if [ ! -d node_modules ]; then npm ci --no-audit --no-fund --loglevel=error; ok "installed from package-lock.json"
else ok "already installed"; fi
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit -p . || die "typecheck failed"
/usr/local/bin/node --import tsx src/tools-check.ts >/dev/null || die "tool self-checks failed"
ok "typecheck and tool self-checks pass under node $NODE_VERSION"

# ---------------------------------------------------------------------------------------------
say "10. Mainnet configuration"
cat > "$APP/ts/.env" <<EOF
# Written by provision-droplet.sh. The feeder reads this; the shell environment overrides it.
BH_HOST=$MAINNET_HOST
BH_NETWORK_ID=mainnet01
BH_NS=free
BH_CHAINS=0-19
BH_FEEDER_KEY=out/feeder-key.json
BH_ATTEST_GAS_LIMIT=400
BH_ATTEST_TTL=300
BH_MAX_INFLIGHT=4
BH_SAMPLE_POLL=25
# One attest waiting per chain every 10 s: about 93 % of blocks instead of about 75 %, at about 3 times the fees.
BH_WAITING_INTERVAL=10
EOF
chmod 644 "$APP/ts/.env"
ok "mainnet01 via $MAINNET_HOST, namespace free, chains 0-19"

# ---------------------------------------------------------------------------------------------
say "11. The feeder's signing key — generated HERE, once, never printed"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$APP/ts/out"
KEY="$APP/ts/out/feeder-key.json"
if [ -f "$KEY" ]; then ok "key already exists — NOT regenerated"
else
  runuser -u "$SVC_USER" -- /usr/local/bin/node --import tsx src/keygen.ts out/feeder-key.json >/dev/null || die "key generation failed"
  ok "new key generated"
fi
[ "$(stat -c '%a %U' "$KEY")" = "600 $SVC_USER" ] || die "key file must be mode 600 owned by $SVC_USER, found: $(stat -c '%a %U' "$KEY")"
PUB=$(runuser -u "$SVC_USER" -- /usr/local/bin/node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('out/feeder-key.json','utf8')).publicKey)")
[[ "$PUB" =~ ^[0-9a-f]{64}$ ]] || die "the service user could not read a valid public key from its own key file"
ok "mode 600, owned by $SVC_USER, readable by the service"

# ---------------------------------------------------------------------------------------------
say "12. Logs and rotation"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$LOG_DIR"
install -m 644 "$APP/ts/deploy/block-history-feeder.logrotate" /etc/logrotate.d/block-history-feeder
logrotate -d /etc/logrotate.d/block-history-feeder >/dev/null 2>&1 || die "logrotate rejected its config"
ok "$LOG_DIR, rotated daily, 14 days kept"

say "13. The service — installed, NOT started"
install -m 644 "$APP/ts/deploy/block-history-feeder.service" /etc/systemd/system/block-history-feeder.service
if [ $HAVE_SYSTEMD = 1 ]; then
  systemctl daemon-reload
  systemd-analyze verify /etc/systemd/system/block-history-feeder.service || die "systemd rejected the unit file"
  systemctl is-enabled block-history-feeder >/dev/null 2>&1 && echo "    NOTE: already enabled (a previous run, or by hand) — left exactly as it was"
  ok "installed and verified. Deliberately NOT enabled and NOT started."
else skip "systemd registration (container)"; fi

# ---------------------------------------------------------------------------------------------
say "14. Can this droplet see mainnet? (read-only; ~${STREAM_SECONDS}s)"
# Run as the service user, and under systemd with the SAME sandbox the service uses, so a sandbox
# setting that would stop the feeder shows up now instead of after you enable it.
STREAM=(/usr/local/bin/node --import tsx src/stream-check.ts --seconds "$STREAM_SECONDS")
if [ $HAVE_SYSTEMD = 1 ]; then
  systemd-run --quiet --wait --pipe --collect \
    --uid="$SVC_USER" --gid="$SVC_USER" --working-directory="$APP/ts" \
    -p NoNewPrivileges=true -p ProtectSystem=strict -p ProtectHome=true -p PrivateTmp=true \
    -p PrivateDevices=true -p ProtectKernelTunables=true -p ProtectKernelModules=true \
    -p ProtectControlGroups=true -p RestrictSUIDSGID=true -p LockPersonality=true \
    -p "ReadWritePaths=$LOG_DIR" -E NODE_ENV=production \
    "${STREAM[@]}" || die "the droplet could not see every chain's block stream under the service sandbox"
else
  runuser -u "$SVC_USER" -- env NODE_ENV=production "${STREAM[@]}" || die "the droplet could not see every chain's block stream"
fi
ok "every chain's new blocks arrive here"

say "15. The feeder account's balance (read-only)"
set +e
runuser -u "$SVC_USER" -- /usr/local/bin/node --import tsx src/balances.ts "k:$PUB"
BAL=$?
set -e
[ $BAL = 2 ] && die "balances could not be read — mainnet /local is not reachable from here"

# ---------------------------------------------------------------------------------------------
cat <<EOF

================================================================================
  PROVISIONED at commit $HEAD — the feeder is installed and STOPPED.

  FEEDER ACCOUNT — fund this on EVERY chain, 0 through 19:

      k:$PUB

  It signs only its own gas, so a leak of this key costs its balance and nothing else.
================================================================================
EOF
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "  Skipped on this host:"; for s in "${SKIPPED[@]}"; do echo "    - $s"; done
fi
cat <<'EOF'

  Next, in this order:
    1. Fund the account above on all 20 chains, then confirm:
         cd /opt/block-history/ts && sudo -u blockhistory node --import tsx src/balances.ts <that account>
    2. Confirm the module is deployed on every chain: until it is, the feeder refuses to start.
    3. Then start sending:
         systemctl enable --now block-history-feeder
         journalctl -u block-history-feeder -f
EOF

#!/usr/bin/env bash
# Install progbar on this device: progd service + prog wrapper + Claude Code hook.
#
#   ./install.sh --ntfy http://ntfy-box:8080/progress --peers http://laptop-b:7777,http://laptop-c:7777
#
# Options:
#   --ntfy URL       ntfy topic URL (e.g. http://<ntfy-host>:8080/progress or https://ntfy.sh/<random>)
#   --ntfy-token T   ntfy access token (optional)
#   --peers LIST     comma-separated base URLs of the other devices' progd
#   --port N         port (default 7777)
#   --no-hook        don't touch ~/.claude/settings.json
#   --no-service     don't install/start the background service
# Re-running is safe: binaries are replaced; the env file is only rewritten for flags you pass.
set -euo pipefail
cd "$(dirname "$0")"

NTFY="" NTFY_TOKEN="" PEERS="" PORT=7777 HOOK=1 SERVICE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ntfy) NTFY="$2"; shift 2;;
    --ntfy-token) NTFY_TOKEN="$2"; shift 2;;
    --peers) PEERS="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --no-hook) HOOK=0; shift;;
    --no-service) SERVICE=0; shift;;
    -h|--help) sed -n '2,15p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

BIN="$HOME/.local/bin"; CONF="$HOME/.config/progbar"; ENVF="$CONF/env"
mkdir -p "$BIN" "$CONF"
command -v python3 >/dev/null || { echo "python3 is required for prog"; exit 1; }

PREBUILT="progd/progd-$(uname -s | tr A-Z a-z)-$(uname -m)"
if command -v go >/dev/null; then
  echo "==> building progd"
  ( cd progd && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$BIN/progd.new" . )
elif [ -x "$PREBUILT" ]; then
  echo "==> using prebuilt $PREBUILT"
  cp "$PREBUILT" "$BIN/progd.new"
else
  echo "Go not found and no prebuilt $PREBUILT. Build one elsewhere with:"
  echo "  cd progd && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags='-s -w' -o progd-linux-x86_64 ."
  exit 1
fi
mv "$BIN/progd.new" "$BIN/progd"
install -m 755 bin/prog bin/prog-hook "$BIN/"

TS_IP="" TS_NAME=""
if command -v tailscale >/dev/null; then
  TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
  TS_NAME=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
fi
[ -n "$TS_IP" ] || echo "!! tailscale IP not found: progd will listen on localhost only until you add it to PROGD_LISTEN in $ENVF"

setkv() {  # setkv KEY VALUE  -> update or append in env file
  local k="$1" v="$2"
  touch "$ENVF"
  if grep -q "^$k=" "$ENVF"; then
    python3 - "$ENVF" "$k" "$v" <<'PY'
import sys; f,k,v=sys.argv[1:]
lines=open(f).read().splitlines()
open(f,"w").write("\n".join(f"{k}={v}" if l.startswith(k+"=") else l for l in lines)+"\n")
PY
  else
    echo "$k=$v" >> "$ENVF"
  fi
}

if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOF
# progbar config (read by progd service and prog-hook). KEY=value, no quotes needed.
PROGD_LISTEN=127.0.0.1:$PORT${TS_IP:+,$TS_IP:$PORT}
PROGD_HOST=$(hostname -s 2>/dev/null || hostname)
PROGD_PEERS=
PROGD_PUBLIC_URL=${TS_NAME:+http://$TS_NAME:$PORT}
PROGD_KEEP=6h
PROGD_MAX_RUNS=100
NTFY_URL=
NTFY_TOKEN=
NTFY_MIN_SECONDS=30
NTFY_ON_START=0
# Hook: background = wrap only Claude's background runs; auto = also known long commands; all; off
PROG_WRAP=background
#PROG_WRAP_EXTRA=\\b(my_long_script|bench)\\b
#PROG_WRAP_SKIP=
EOF
  echo "==> wrote $ENVF"
fi
[ -n "$NTFY" ] && setkv NTFY_URL "$NTFY"
[ -n "$NTFY_TOKEN" ] && setkv NTFY_TOKEN "$NTFY_TOKEN"
[ -n "$PEERS" ] && setkv PROGD_PEERS "$PEERS"
chmod 600 "$ENVF"

echo "==> generating iPhone widget"
widget/generate.sh || echo "   (skipped: run widget/generate.sh http://host:7777 ... yourself)"

if [ "$SERVICE" = 1 ]; then
  case "$(uname -s)" in
    Linux)
      echo "==> installing systemd user service"
      mkdir -p "$HOME/.config/systemd/user"
      cat > "$HOME/.config/systemd/user/progd.service" <<EOF
[Unit]
Description=progd - progress dashboard + ntfy notifier
After=network-online.target

[Service]
EnvironmentFile=$ENVF
ExecStart=$BIN/progd
Restart=always
RestartSec=3
MemoryMax=64M
Nice=10

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now progd.service
      systemctl --user restart progd.service
      loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes || \
        echo "   tip: 'sudo loginctl enable-linger $USER' keeps progd running when you're logged out"
      ;;
    Darwin)
      echo "==> installing launchd agent"
      PL="$HOME/Library/LaunchAgents/dev.progbar.progd.plist"
      mkdir -p "$(dirname "$PL")"
      cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.progbar.progd</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>set -a; . "$ENVF"; exec "$BIN/progd"</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$CONF/progd.log</string>
</dict></plist>
EOF
      launchctl unload "$PL" 2>/dev/null || true
      launchctl load "$PL"
      ;;
  esac
fi

if [ "$HOOK" = 1 ]; then
  S="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"; [ -f "$S" ] || echo '{}' > "$S"
  if grep -q "prog-hook" "$S"; then
    echo "==> Claude Code hook already present in $S"
  else
    cp "$S" "$S.bak.$(date +%s)"
    python3 - "$S" "$BIN/prog-hook" <<'PY'
import json, sys
path, hook = sys.argv[1:]
s = json.load(open(path))
pre = s.setdefault("hooks", {}).setdefault("PreToolUse", [])
pre.append({"matcher": "Bash", "hooks": [{"type": "command", "command": hook, "timeout": 5}]})
json.dump(s, open(path, "w"), indent=2)
PY
    echo "==> added PreToolUse hook to $S (backup saved next to it)"
  fi
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "   ufw is active: run 'sudo ufw allow in on tailscale0 to any port $PORT' so other devices can reach progd"
fi

echo
echo "Done."
echo "  Dashboard (this device): http://${TS_NAME:-localhost}:$PORT"
echo "  Config:                  $ENVF   (restart: systemctl --user restart progd)"
echo "  iPhone widget:           $(pwd)/widget/progbar-widget.js   (paste into Scriptable)"
echo "  Try it:                  prog -- python3 -c 'import time,sys;[ (sys.stdout.write(f\"\\r{i}%\"),sys.stdout.flush(),time.sleep(.1)) for i in range(101)]'"

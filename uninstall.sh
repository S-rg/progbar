#!/usr/bin/env bash
# Remove progbar from this device: service, binaries, Claude Code hook.
# Keeps ~/.config/progbar/env unless you pass --purge.
set -euo pipefail
BIN="$HOME/.local/bin"; CONF="$HOME/.config/progbar"

case "$(uname -s)" in
  Linux)
    systemctl --user disable --now progd.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/progd.service"
    systemctl --user daemon-reload 2>/dev/null || true ;;
  Darwin)
    PL="$HOME/Library/LaunchAgents/dev.progbar.progd.plist"
    launchctl unload "$PL" 2>/dev/null || true
    rm -f "$PL" ;;
esac
rm -f "$BIN/progd" "$BIN/prog" "$BIN/prog-hook"

S="$HOME/.claude/settings.json"
if [ -f "$S" ] && grep -q prog-hook "$S"; then
  cp "$S" "$S.bak.$(date +%s)"
  python3 - "$S" <<'PY'
import json, sys
path = sys.argv[1]
s = json.load(open(path))
pre = s.get("hooks", {}).get("PreToolUse", [])
pre = [m for m in pre if not any("prog-hook" in h.get("command", "") for h in m.get("hooks", []))]
if pre:
    s["hooks"]["PreToolUse"] = pre
else:
    s.get("hooks", {}).pop("PreToolUse", None)
    if s.get("hooks") == {}:
        s.pop("hooks")
json.dump(s, open(path, "w"), indent=2)
PY
  echo "removed hook from $S (backup saved next to it)"
fi

[ "${1:-}" = "--purge" ] && rm -rf "$CONF" && echo "removed $CONF"
echo "progbar uninstalled."

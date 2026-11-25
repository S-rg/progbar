# progbar

Live progress bars for long-running jobs on all your machines, viewable from a webpage, an
iPhone widget, or push notifications. Built for jobs started by [Claude Code](https://claude.com/claude-code),
whose shell doesn't show progress bars, and it works just as well for anything you run yourself.

- **Tiny:** one ~5 MB Go binary per machine, ~8 MB RAM, no database, no dependencies beyond Python 3's stdlib.
- **Works with any CLI:** tqdm, pip, rsync, curl, wget, cargo, ffmpeg, pytest… with no code changes.
- **Multi-device:** every machine runs its own server, and any machine's dashboard shows all of them.
- **Private by default:** meant to run over [Tailscale](https://tailscale.com). Servers listen on localhost and the
  Tailscale IP only.

```
 your shell / Claude Code ──▶ prog -c '<cmd>'            (on each machine)
                               │ runs cmd in a pseudo-terminal, parses progress bars
                               ▼ POST ≤1/s to 127.0.0.1:7777
                             progd  (Go)
                               ├─ /           live dashboard (SSE), shows all peers
                               ├─ /api/runs   JSON, used by the iPhone widget
                               └─ done/failed/lost ──▶ ntfy push (optional)
```

## Requirements

- Linux (systemd) or macOS (launchd)
- Python 3.8+
- Go 1.22+ to build `progd`, or prebuilt binaries from `make dist` (see below)
- Tailscale (or any private network) so other devices can reach port 7777

## Install

On each machine:

```bash
git clone https://github.com/<you>/progbar && cd progbar
./install.sh --peers http://other-machine:7777,http://third-machine:7777
```

Options: `--ntfy <topic-url>`, `--ntfy-token <token>`, `--port <n>`, `--no-hook` (don't touch
Claude Code settings), `--no-service`.

The installer:

1. builds `progd` into `~/.local/bin` (or copies a prebuilt `progd/progd-<os>-<arch>`)
2. installs `prog` and `prog-hook` into `~/.local/bin`
3. writes `~/.config/progbar/env` (listen addresses come from `tailscale ip -4`)
4. starts a systemd user service / launchd agent
5. adds a PreToolUse hook to `~/.claude/settings.json` (backed up first)

On Linux, run `sudo loginctl enable-linger $USER` so the service keeps running after you log out.

**Machines without Go:** run `make dist` on any machine that has Go, copy the repo over, then run `./install.sh`.

## Usage

Wrap any command:

```bash
prog -- python train.py --epochs 10
prog --name "nightly backup" -c 'rsync -a ~/data backup:/data && echo ok'
```

The command runs in a pseudo-terminal, so it draws its normal progress bar. You still get clean
output (each bar's final state, without ANSI escapes or carriage-return spam), and the exit code is preserved.
If `progd` isn't running, the command just runs as normal.

### Claude Code

The installed PreToolUse hook rewrites Bash calls so they run under `prog`.

| `PROG_WRAP` (in `~/.config/progbar/env`) | What gets wrapped |
|---|---|
| `background` *(default)* | only calls Claude runs with `run_in_background` |
| `auto` | background calls + commands that look long (installs, builds, docker, downloads, git clone, pytest, training scripts) + `PROG_WRAP_EXTRA` regex |
| `all` | every Bash call |
| `off` | nothing |

`PROG_WRAP_SKIP=<regex>` excludes commands in any mode. Changes take effect on the next command.

The default is `background` because Claude Code's auto mode can't review a command after a hook has
rewritten it. Every wrapped call then has to be sent twice. Only wrapping background runs keeps that rare.

## Viewing

- **Webpage (live):** `http://<machine>:7777`. It shows every machine in `PROGD_PEERS`, plus any you add
  in the page's *Devices* box. On a phone, use *Add to Home Screen*.
- **iPhone widget:** install [Scriptable](https://scriptable.app), paste
  [`widget/progbar-widget.js`](widget/progbar-widget.js) into a new script, set `HOSTS`, and add a
  Scriptable widget (small, medium, large, or lock-screen). iOS refreshes widgets only every few minutes,
  so the widget is for a quick glance; tap it to open the live page.
- **Push notifications (optional):** set `NTFY_URL` to an [ntfy](https://ntfy.sh) topic to get alerts when
  runs finish, fail or go silent. Self-host ntfy on your tailnet, or use ntfy.sh with a long random
  topic (anyone who knows the topic can read the messages).

## Configuration

`~/.config/progbar/env` (restart with `systemctl --user restart progd`):

| Key | Default | |
|---|---|---|
| `PROGD_LISTEN` | `127.0.0.1:7777,<tailscale-ip>:7777` | comma-separated listen addresses |
| `PROGD_HOST` | hostname | label shown on the dashboard |
| `PROGD_PEERS` | | other machines' base URLs, comma-separated |
| `PROGD_PUBLIC_URL` | `http://<tailscale-name>:7777` | link used in notifications |
| `PROGD_KEEP` | `6h` | how long finished runs are kept |
| `PROGD_MAX_RUNS` | `100` | max runs kept in memory |
| `PROGD_LOST_AFTER` | `90s` | no heartbeat for this long → run marked *lost* |
| `PROGD_ALLOW_REMOTE_UPDATES` | `0` | allow non-localhost clients to post updates |
| `NTFY_URL` / `NTFY_TOKEN` | | ntfy topic URL and optional token |
| `NTFY_MIN_SECONDS` | `30` | don't notify for runs shorter than this |
| `NTFY_ON_START` | `0` | also notify when runs start |

## HTTP API

| Endpoint | |
|---|---|
| `GET /api/runs` | `{host, now, runs:[…]}` (CORS enabled) |
| `GET /api/events` | server-sent events; a full snapshot on every change |
| `GET /api/peers` | configured peers |
| `POST /api/update` | `{id, name, cmd, state, pct, cur, total, rate, eta, line, exit}`, from localhost only by default |
| `POST /api/clear` | drop finished runs |

## What `prog` recognises

The tqdm format (`45%|███ | 450/1000 [00:12<00:15, 36it/s]`), any `NN%`, `step/epoch/batch/file N/M`,
`[N/M]`, rates like `12.3MB/s` / `36it/s`, and `ETA 1:23`. Runs with no recognisable progress still show a
pulsing bar, the elapsed time and the last output line.

## Caveats

- stdout and stderr are merged (both go to the pseudo-terminal).
- A wrapped command runs in a child shell, so `cd`/`export` inside it don't carry over to the next command.
  Shell functions and aliases aren't available inside it (exported variables are).
- Tools see a terminal, so some enable colours or pagers. `prog` sets `PAGER=cat` and strips ANSI escapes.
- The dashboard has no authentication. Anyone who can reach the port can see run names and output lines,
  so keep it on a private network.

## Development

```bash
make test    # go vet + Python unit tests
make build   # progd/progd
make dist    # cross-compiled progd-<os>-<arch> binaries
```

## Uninstall

```bash
./uninstall.sh           # removes the service, binaries and Claude Code hook
./uninstall.sh --purge   # also removes ~/.config/progbar
```

## License

MIT

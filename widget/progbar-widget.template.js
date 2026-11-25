// progbar iPhone widget for the Scriptable app (https://scriptable.app).
//
// TEMPLATE: don't paste this file directly. Generate the real widget with your hosts:
//   widget/generate.sh                       # hosts from ~/.config/progbar/env
//   widget/generate.sh http://a:7777 http://b:7777
// That writes widget/progbar-widget.js. install.sh also runs it for you.
//
// Setup: paste the generated script into a new Scriptable script, add a Scriptable
// widget to your home screen, long-press -> Edit Widget -> Script: this one.
// Optional "Parameter": comma-separated hosts, overrides HOSTS for that widget.
// Tap the widget to open the full live dashboard.
//
// Needs the Tailscale VPN on. iOS decides how often widgets refresh (often every 5-15 min),
// so this is a glance view; the dashboard page is live, and ntfy pushes are instant.

const HOSTS = [/*PROGBAR_HOSTS*/];
const MAX_ROWS = { small: 2, medium: 3, large: 8, accessoryRectangular: 1 };

const hosts = (args.widgetParameter ? args.widgetParameter.split(",") : HOSTS)
  .map(h => h.trim().replace(/\/$/, "")).filter(Boolean);
const family = config.widgetFamily || "medium";
// Always dark, regardless of the phone's appearance setting.
const C = {
  bg: new Color("#111318"),
  fg: new Color("#e8eaee"),
  mut: new Color("#8b93a1"),
  track: new Color("#2a2f3a"),
  running: new Color("#60a5fa"),
  done: new Color("#4ade80"),
  failed: new Color("#f87171"),
  lost: new Color("#fbbf24"),
};

async function fetchHost(base) {
  try {
    const r = new Request(base + "/api/runs");
    r.timeoutInterval = 4;
    const d = await r.loadJSON();
    return { base, host: d.host, runs: d.runs || [], skew: Date.now() - d.now, up: true };
  } catch (e) {
    return { base, host: base.replace(/^https?:\/\//, "").replace(/:\d+$/, ""), runs: [], up: false };
  }
}

function bar(pct, color, w, h) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(track); ctx.setFillColor(C.track); ctx.fillPath();
  if (pct > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, Math.max(h, w * Math.min(pct, 100) / 100), h), h / 2, h / 2);
    ctx.addPath(fill); ctx.setFillColor(color); ctx.fillPath();
  }
  return ctx.getImage();
}

const dur = ms => { let s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60; return h ? `${h}h${m}m` : m ? `${m}m${s}s` : `${s}s`; };

const fmtClock = secs => { const s = Math.max(0, Math.round(secs)); const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60), x = s % 60, p = n => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`; };

// Seconds left as of the run's last update: the run's own ETA if it printed one
// (tqdm "01:23" / "1:02:03"), else simple extrapolation: elapsed × (100 − pct) / pct.
function secondsLeft(r) {
  if (r.state !== "running") return null;
  const eta = (r.eta || "").trim();
  if (/^\d+(:\d{1,2}){1,2}$/.test(eta)) return eta.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  const pct = r.pct;
  const elapsed = (r.updated - r.start) / 1000;
  if (pct == null || pct < 0.5 || pct >= 100 || elapsed < 10) return null; // too early to guess
  return elapsed * (100 - pct) / pct;
}

// A live timer that iOS ticks between refreshes (counts down to a future date, up from a
// past one). iOS gives a date text all the free width in its row, which pushed whatever
// came after it far to the right, so each timer sits in a box sized to its digits.
function addTimer(stack, date, sampleSecs, size, color) {
  const box = stack.addStack();
  box.size = new Size(Math.ceil(fmtClock(sampleSecs).length * size * 0.62) + 2, 0);
  const d = box.addDate(date);
  d.applyTimerStyle();
  d.leftAlignText();
  d.font = Font.regularMonospacedSystemFont(size);
  d.textColor = color; d.lineLimit = 1; d.minimumScaleFactor = 0.6;
  return d;
}

function addMuted(stack, text, size) {
  const t = stack.addText(text);
  t.font = Font.systemFont(size); t.textColor = C.mut; t.lineLimit = 1;
  return t;
}

const results = await Promise.all(hosts.map(fetchHost));
// Only active runs: done, failed (exited) and lost runs are hidden. Newest first.
const rows = results.flatMap(h => h.runs.map(r => ({ ...r, hostLabel: h.host, skew: h.skew })))
  .filter(r => r.state === "running")
  .sort((a, b) => b.start - a.start);
const running = rows.filter(r => r.state === "running").length;

const w = new ListWidget();
w.backgroundColor = C.bg;
w.setPadding(14, 14, 12, 14);
w.url = results.find(h => h.up)?.base || hosts[0];
w.refreshAfterDate = new Date(Date.now() + (running ? 60 : 600) * 1000);

if (!hosts.length) {
  const t = w.addText("No hosts set. Generate this script with widget/generate.sh, or put hosts in the widget Parameter.");
  t.font = Font.systemFont(12); t.textColor = C.mut;
} else if (family === "accessoryRectangular") {
  // Lock screen widget
  const r = rows[0];
  const t = w.addText(r ? `${r.state === "running" && r.pct != null ? Math.round(r.pct) + "% " : ""}${r.name || r.cmd}` : "No active runs");
  t.font = Font.semiboldSystemFont(13); t.lineLimit = 2;
  const s = w.addText(`${running} running`); s.font = Font.systemFont(11);
} else {
  const head = w.addStack();
  head.centerAlignContent();
  const title = head.addText(running ? `${running} running` : "Idle");
  title.font = Font.boldSystemFont(14); title.textColor = C.fg;
  head.addSpacer();
  const down = results.filter(h => !h.up).length;
  const hs = head.addText(down ? `${down}/${results.length} offline` : `${results.length} devices`);
  hs.font = Font.systemFont(11); hs.textColor = down ? C.failed : C.mut;
  w.addSpacer(10);

  // Bars must fit inside the widget minus padding, or iOS shrinks/shifts the whole layout.
  const barW = family === "small" ? 118 : 290;
  const show = rows.slice(0, MAX_ROWS[family] || 3);
  if (!show.length) {
    const e = w.addText("No active runs"); e.font = Font.systemFont(12); e.textColor = C.mut;
  }
  for (const r of show) {
    const now = Date.now() - (r.skew || 0);
    const known = r.pct !== null && r.pct !== undefined;
    const pct = r.state === "done" ? 100 : known ? r.pct : 0;
    const color = C[r.state] || C.running;
    const top = w.addStack(); top.centerAlignContent();
    const n = top.addText(r.name || r.cmd); n.font = Font.semiboldSystemFont(12); n.textColor = C.fg; n.lineLimit = 1;
    top.addSpacer(4);
    const label = r.state === "running" ? (known ? `${Math.round(pct)}%` : "…")
      : r.state === "done" ? "done" : r.state === "failed" ? `exit ${r.exit ?? "?"}` : "lost";
    const p = top.addText(label); p.font = Font.semiboldMonospacedSystemFont(12); p.textColor = color;
    w.addSpacer(3);
    const img = w.addImage(bar(known || r.state !== "running" ? pct : 4, color, barW, 6));
    img.imageSize = new Size(barW, 6);
    w.addSpacer(2);
    const meta = [r.hostLabel];
    if (family !== "small" && r.cur && r.total) meta.push(`${r.cur}/${r.total}`);
    const row = w.addStack(); row.centerAlignContent();
    const left = secondsLeft(r);
    // r.updated is server time; skew = phone clock − server clock
    const end = left == null ? null : new Date(r.updated + (r.skew || 0) + left * 1000);
    const leftNow = end ? (end - Date.now()) / 1000 : -1;
    if (leftNow > 0) {
      addMuted(row, meta.join(" · ") + " · ~", 10);
      addTimer(row, end, leftNow, 10, C.mut);
      addMuted(row, " left", 10);
    } else {
      meta.push(dur((r.end || now) - r.start)); // no estimate yet (or it's overdue): show elapsed
      addMuted(row, meta.join(" · "), 10);
    }
    row.addSpacer();
    w.addSpacer(6);
  }
  w.addSpacer();
  // "Refreshed 14:32 · 3:12 ago": the clock time is when this snapshot was taken; iOS ticks
  // the timer on its own between refreshes. (Scriptable widgets can't have a refresh button.)
  const now = new Date();
  const foot = w.addStack();
  foot.centerAlignContent();
  const df = new DateFormatter(); df.useNoDateStyle(); df.useShortTimeStyle();
  addMuted(foot, `Refreshed ${df.string(now)} · `, 9);
  addTimer(foot, now, 59 * 60 + 59, 9, C.mut); // sized for "59:59"; shrinks to fit past an hour
  addMuted(foot, " ago", 9);
  foot.addSpacer();
}

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();

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
const dark = Device.isUsingDarkAppearance();
const C = {
  bg: dark ? new Color("#171a21") : new Color("#ffffff"),
  fg: dark ? new Color("#e8eaee") : new Color("#14171c"),
  mut: dark ? new Color("#8b93a1") : new Color("#6b7280"),
  track: dark ? new Color("#2a2f3a") : new Color("#e5e7eb"),
  running: dark ? new Color("#60a5fa") : new Color("#2563eb"),
  done: dark ? new Color("#4ade80") : new Color("#16a34a"),
  failed: dark ? new Color("#f87171") : new Color("#dc2626"),
  lost: dark ? new Color("#fbbf24") : new Color("#d97706"),
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

const results = await Promise.all(hosts.map(fetchHost));
// Running runs first (any host), then most recent finished.
const rows = results.flatMap(h => h.runs.map(r => ({ ...r, hostLabel: h.host, skew: h.skew })))
  .sort((a, b) => (b.state === "running") - (a.state === "running") || b.start - a.start);
const running = rows.filter(r => r.state === "running").length;

const w = new ListWidget();
w.backgroundColor = C.bg;
w.setPadding(12, 14, 12, 14);
w.url = results.find(h => h.up)?.base || hosts[0];
w.refreshAfterDate = new Date(Date.now() + (running ? 60 : 600) * 1000);

if (!hosts.length) {
  const t = w.addText("No hosts set. Generate this script with widget/generate.sh, or put hosts in the widget Parameter.");
  t.font = Font.systemFont(12); t.textColor = C.mut;
} else if (family === "accessoryRectangular") {
  // Lock screen widget
  const r = rows[0];
  const t = w.addText(r ? `${r.state === "running" && r.pct != null ? Math.round(r.pct) + "% " : ""}${r.name || r.cmd}` : "No runs");
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
  w.addSpacer(8);

  const barW = family === "small" ? 130 : 300;
  const show = rows.slice(0, MAX_ROWS[family] || 3);
  if (!show.length) {
    const e = w.addText("No runs"); e.font = Font.systemFont(12); e.textColor = C.mut;
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
    if (family !== "small") {
      if (r.cur && r.total) meta.push(`${r.cur}/${r.total}`);
      if (r.eta && r.state === "running") meta.push(`ETA ${r.eta}`);
    }
    meta.push(dur((r.end || now) - r.start));
    const m = w.addText(meta.join(" · ")); m.font = Font.systemFont(10); m.textColor = C.mut; m.lineLimit = 1;
    w.addSpacer(6);
  }
  w.addSpacer();
}

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();

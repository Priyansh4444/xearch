// Minimal overview dashboard served at /. Derives a small summary from the full
// snapshot (see index.ts) and renders it client-side so the refresh button can
// re-fetch /api/summary without a page reload. No auto-refresh.

import type { RunSummary, Snapshot, ThresholdCheck } from "./index";

export interface RunLite {
  runId: string;
  kind: "live" | "archived";
  status: string | null;
  error: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  posts: number | null;
  authors: number | null;
  accounts: RunSummary["accounts"];
  requests: number | null;
  pages: number | null;
  archiveBytes: number | null;
  archiveFiles: number | null;
  acceptance: RunSummary["acceptance"];
}

export interface Summary {
  generatedAt: number;
  bucket: Snapshot["bucket"];
  totals: {
    runs: number;
    runsNormalized: number;
    posts: number; // accepted after normalization, summed over distinct runs
    postsTimeline: number;
    postsEmbedded: number;
    rejected: number;
    duplicates: number;
    skippedOutsideWindow: number;
    authors: number;
    accounts: NonNullable<RunSummary["accounts"]>;
    requests: number;
    retries: number;
    pages: number;
    rowsReturned: number;
  };
  live: RunLite | null; // a run whose acquisition is in progress right now
  latest: RunLite | null; // most recently updated run
  quality: {
    runId: string;
    generatedAt: number;
    passed: boolean;
    checks: ThresholdCheck[];
    acceptance: RunSummary["acceptance"];
  } | null;
  runs: RunLite[];
}

function lite(run: RunSummary): RunLite {
  return {
    runId: run.runId,
    kind: run.kind,
    status: run.status,
    error: run.error,
    updatedAt: run.updatedAt,
    createdAt: run.createdAt,
    posts: run.normalization?.counts.accepted?.total ?? null,
    authors: run.normalization?.counts.authors ?? null,
    accounts: run.accounts,
    requests: run.requests,
    pages: run.pages,
    archiveBytes: run.archiveBytes,
    archiveFiles: run.archiveFiles,
    acceptance: run.acceptance,
  };
}

export function buildSummary(snapshot: Snapshot): Summary {
  // A run pushed live and later archived appears twice; the archived copy is final, so it wins.
  const byId = new Map<string, RunSummary>();
  for (const run of snapshot.runs) {
    const existing = byId.get(run.runId);
    if (existing === undefined || (existing.kind === "live" && run.kind === "archived")) byId.set(run.runId, run);
  }
  const distinct = [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const totals: Summary["totals"] = {
    runs: distinct.length,
    runsNormalized: 0,
    posts: 0,
    postsTimeline: 0,
    postsEmbedded: 0,
    rejected: 0,
    duplicates: 0,
    skippedOutsideWindow: 0,
    authors: 0,
    accounts: { total: 0, completed: 0, paused: 0, active: 0, pending: 0, abandoned: 0 },
    requests: 0,
    retries: 0,
    pages: 0,
    rowsReturned: 0,
  };
  for (const run of distinct) {
    if (run.error !== null) continue;
    const c = run.normalization?.counts;
    if (c) {
      totals.runsNormalized += 1;
      totals.posts += c.accepted?.total ?? 0;
      totals.postsTimeline += c.accepted?.timeline ?? 0;
      totals.postsEmbedded += c.accepted?.embedded ?? 0;
      totals.rejected += c.rejected?.total ?? 0;
      totals.duplicates += c.duplicates ?? 0;
      totals.skippedOutsideWindow += c.skippedOutsideWindow ?? 0;
      totals.authors += c.authors ?? 0;
    }
    if (run.accounts) {
      for (const key of Object.keys(totals.accounts) as (keyof typeof totals.accounts)[]) {
        totals.accounts[key] += run.accounts[key];
      }
    }
    totals.requests += run.requests ?? 0;
    totals.retries += run.retries ?? 0;
    totals.pages += run.pages ?? 0;
    totals.rowsReturned += run.rowsReturned ?? 0;
  }

  const live = snapshot.runs.find((run) => run.kind === "live" && run.status === "in_progress") ?? null;
  const latest = distinct[0] ?? null;
  const reported = distinct.find((run) => run.report !== null) ?? null;
  const quality: Summary["quality"] = reported && reported.report
    ? {
        runId: reported.runId,
        generatedAt: reported.report.generatedAt,
        passed: reported.report.thresholds.passed,
        checks: reported.report.thresholds.checks,
        acceptance: reported.acceptance,
      }
    : null;

  return {
    generatedAt: snapshot.generatedAt,
    bucket: snapshot.bucket,
    totals,
    live: live ? lite(live) : null,
    latest: latest ? lite(latest) : null,
    quality,
    runs: distinct.map(lite),
  };
}

// ---------- HTML ----------

export function renderOverviewHtml(summary: Summary): string {
  // The initial summary is embedded so the first paint needs no extra request.
  const initial = JSON.stringify(summary).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>xearch</title>
<script>(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #111; --dim: #71717a; --card: #fff; --line: #e4e4e7; --accent: #2563eb; --ok: #16a34a; --warn: #d97706; --bad: #dc2626; }
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0b0c0f; --fg: #ececf1; --dim: #8b8b96; --card: #15171c; --line: #262931; --accent: #60a5fa; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; } }
:root[data-theme="dark"] { --bg: #0b0c0f; --fg: #ececf1; --dim: #8b8b96; --card: #15171c; --line: #262931; --accent: #60a5fa; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.25rem; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 880px; margin-inline: auto; }
header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1.25rem; }
header h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
header .spacer { flex: 1; }
button { font: inherit; font-size: .85rem; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .35rem .7rem; cursor: pointer; }
button:hover { border-color: var(--dim); }
button:disabled { opacity: .6; cursor: default; }
.dim { color: var(--dim); } .small { font-size: .82rem; }
nav.tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--line); margin-bottom: 1.25rem; overflow-x: auto; }
nav.tabs button { border: 0; background: none; border-radius: 0; padding: .5rem .8rem; color: var(--dim); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
nav.tabs button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .75rem; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: .9rem 1rem; min-width: 0; }
.tile .label { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
.tile .value { font-size: 1.7rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: .15rem; overflow-wrap: anywhere; }
.tile .sub { font-size: .8rem; color: var(--dim); margin-top: .2rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1rem; margin-top: .75rem; }
.card h2 { font-size: .95rem; margin: 0 0 .5rem; font-weight: 600; }
.bar { display: flex; height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; margin: .5rem 0; }
.seg.ok { background: var(--ok); } .seg.bad { background: var(--bad); } .seg.warn { background: var(--warn); } .seg.live { background: var(--accent); }
.ok-text { color: var(--ok); } .bad-text { color: var(--bad); } .warn-text { color: var(--warn); } .accent-text { color: var(--accent); }
.pill { font-size: .72rem; padding: .1rem .5rem; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); text-transform: uppercase; letter-spacing: .04em; }
.pill.ok { color: var(--ok); border-color: var(--ok); } .pill.bad { color: var(--bad); border-color: var(--bad); } .pill.warn { color: var(--warn); border-color: var(--warn); } .pill.live { color: var(--accent); border-color: var(--accent); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--dim); font-weight: 500; font-size: .72rem; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; }
.error { color: var(--bad); background: color-mix(in srgb, var(--bad) 10%, transparent); padding: .5rem .75rem; border-radius: 8px; margin-bottom: 1rem; overflow-wrap: anywhere; }
.empty { color: var(--dim); padding: 2rem 0; text-align: center; }
footer { color: var(--dim); font-size: .8rem; margin-top: 2rem; display: flex; gap: 1rem; flex-wrap: wrap; }
footer a { color: inherit; }
ul { margin: .25rem 0; padding-left: 1.25rem; font-size: .9rem; }
</style>
</head>
<body>
<header>
  <h1>xearch</h1>
  <span id="updated" class="dim small"></span>
  <span class="spacer"></span>
  <button id="theme" type="button" title="Toggle theme">theme</button>
  <button id="refresh" type="button">Refresh</button>
</header>
<div id="error" class="error" hidden></div>
<nav class="tabs" role="tablist">
  <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
  <button role="tab" data-tab="runs" aria-selected="false">Runs</button>
  <button role="tab" data-tab="quality" aria-selected="false">Quality</button>
  <button role="tab" data-tab="storage" aria-selected="false">Storage</button>
</nav>
<main id="main"></main>
<footer>
  <span>Manual refresh only.</span>
  <a href="/nerds">stats for nerds</a>
  <a href="/api/summary">json</a>
</footer>
<script id="initial" type="application/json">${initial}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("initial").textContent);
  var tab = "overview";
  var main = document.getElementById("main");
  var errorBox = document.getElementById("error");
  var updatedEl = document.getElementById("updated");
  var refreshBtn = document.getElementById("refresh");
  var themeBtn = document.getElementById("theme");

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function int(v) { return v == null ? "–" : Number(v).toLocaleString("en-US"); }
  function bytes(b) { if (b == null) return "–"; if (b < 1024) return b + " B"; var u = ["KiB", "MiB", "GiB", "TiB"], v = b / 1024, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return v.toFixed(v >= 100 ? 0 : 1) + " " + u[i]; }
  function iso(ms) { return ms == null ? "–" : new Date(ms).toISOString().replace("T", " ").replace(/\\.\\d{3}Z$/, "Z"); }
  function ago(ms) {
    if (ms == null) return "never";
    var s = Math.round((Date.now() - ms) / 1000), a = Math.abs(s), suf = s < 0 ? "from now" : "ago";
    if (a < 45) return a + "s " + suf; if (a < 3600) return Math.round(a / 60) + " min " + suf;
    if (a < 86400) return (Math.round(a / 360) / 10) + " h " + suf; return (Math.round(a / 8640) / 10) + " d " + suf;
  }
  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
  function statusPill(status) {
    if (!status) return "";
    var cls = status === "completed" ? "ok" : status === "in_progress" ? "live" : status === "partial" ? "warn" : (status === "abandoned" || status === "failed") ? "bad" : "";
    return '<span class="pill ' + cls + '">' + esc(status.replace("_", " ")) + "</span>";
  }
  function tile(label, value, sub) { return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + value + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>"; }
  function accountsBar(a) {
    if (!a) return "";
    return '<div class="bar" title="' + (a.completed + a.abandoned) + "/" + a.total + ' accounts finished">' +
      '<span class="seg ok" style="width:' + pct(a.completed, a.total) + '%"></span>' +
      '<span class="seg bad" style="width:' + pct(a.abandoned, a.total) + '%"></span>' +
      '<span class="seg warn" style="width:' + pct(a.paused, a.total) + '%"></span>' +
      '<span class="seg live" style="width:' + pct(a.active, a.total) + '%"></span></div>' +
      '<div class="dim small">' + int(a.completed) + " completed · " + int(a.active) + " active · " + int(a.pending) + " pending · " + int(a.paused) + " paused · " + int(a.abandoned) + " abandoned</div>";
  }

  function renderOverview(d) {
    var t = d.totals;
    if (t.runs === 0) return '<p class="empty">No runs in the bucket yet. Archived runs appear after <code>pnpm collect:sync</code>; live runs after <code>pnpm collect:push-status</code>.</p>';
    var html = '<div class="tiles">' +
      tile("Posts processed", int(t.posts), int(t.postsTimeline) + " timeline · " + int(t.postsEmbedded) + " embedded") +
      tile("Authors", int(t.authors), "across " + int(t.runsNormalized) + " normalized run" + (t.runsNormalized === 1 ? "" : "s")) +
      tile("Accounts finished", int(t.accounts.completed + t.accounts.abandoned) + ' <span class="dim" style="font-size:1rem">/ ' + int(t.accounts.total) + "</span>", int(t.accounts.abandoned) + " abandoned · " + int(t.accounts.paused) + " paused") +
      tile("Runs", int(t.runs), d.latest ? "latest " + esc(ago(d.latest.updatedAt)) : "") +
      tile("Requests", int(t.requests), int(t.pages) + " pages · " + int(t.rowsReturned) + " rows returned") +
      tile("Data stored", esc(bytes(d.bucket.bytes)), int(d.bucket.objects) + " objects") +
      "</div>";
    if (d.live) {
      var l = d.live;
      html += '<div class="card"><h2>Live run ' + statusPill(l.status) + ' <span class="dim small">' + esc(l.runId) + "</span></h2>" + accountsBar(l.accounts) +
        '<div class="dim small">' + int(l.requests) + " requests · " + int(l.pages) + " pages · updated " + esc(ago(l.updatedAt)) + "</div></div>";
    } else {
      html += '<div class="card"><h2>No run in progress</h2><div class="dim small">' + (d.latest ? "Latest run " + esc(d.latest.runId) + " " + statusPill(d.latest.status) + " · updated " + esc(ago(d.latest.updatedAt)) : "") + "</div></div>";
    }
    if (d.quality) {
      var failed = d.quality.checks.filter(function (c) { return c.passed === false; });
      html += '<div class="card"><h2>Quality ' + '<span class="pill ' + (d.quality.passed ? "ok" : "bad") + '">' + (d.quality.passed ? "pass" : "fail") + "</span></h2>" +
        '<div class="dim small">' + (failed.length ? failed.length + " failing check" + (failed.length === 1 ? "" : "s") + ": " + esc(failed.map(function (c) { return c.name; }).join(", ")) : "All threshold checks pass") + " · report for " + esc(d.quality.runId) + "</div></div>";
    }
    return html;
  }

  function renderRuns(d) {
    if (!d.runs.length) return '<p class="empty">No runs.</p>';
    return '<div class="scroll"><table><thead><tr><th>Run</th><th>Status</th><th class="num">Posts</th><th class="num">Authors</th><th class="num">Accounts</th><th class="num">Requests</th><th>Updated</th></tr></thead><tbody>' +
      d.runs.map(function (r) {
        if (r.error) return "<tr><td>" + esc(r.runId) + '</td><td colspan="6" class="bad-text">' + esc(r.error) + "</td></tr>";
        var a = r.accounts;
        return "<tr><td>" + esc(r.runId) + ' <span class="pill">' + r.kind + "</span></td><td>" + statusPill(r.status) + (r.acceptance ? ' <span class="pill ' + (r.acceptance.passed ? "ok" : "warn") + '">' + (r.acceptance.passed ? "accepted" : "not accepted") + "</span>" : "") +
          '</td><td class="num">' + int(r.posts) + '</td><td class="num">' + int(r.authors) + '</td><td class="num">' + (a ? int(a.completed + a.abandoned) + " / " + int(a.total) : "–") +
          '</td><td class="num">' + int(r.requests) + '</td><td title="' + esc(iso(r.updatedAt)) + '">' + esc(ago(r.updatedAt)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function renderQuality(d) {
    var q = d.quality;
    if (!q) return '<p class="empty">No run has a report.json yet.</p>';
    var html = '<div class="card"><h2>Thresholds <span class="pill ' + (q.passed ? "ok" : "bad") + '">' + (q.passed ? "pass" : "fail") + '</span> <span class="dim small">' + esc(q.runId) + " · report " + esc(ago(q.generatedAt)) + "</span></h2>" +
      '<div class="scroll"><table><thead><tr><th>Check</th><th class="num">Value</th><th>Bound</th><th>Result</th></tr></thead><tbody>' +
      q.checks.map(function (c) {
        var v = c.value == null ? "–" : typeof c.value === "number" ? (Number.isInteger(c.value) ? String(c.value) : c.value.toFixed(4)) : c.value;
        return "<tr><td>" + esc(c.name) + '</td><td class="num">' + esc(v) + "</td><td>" + esc(c.bound) + '</td><td class="' + (c.passed === null ? "dim" : c.passed ? "ok-text" : "bad-text") + '">' + (c.passed === null ? "n/a" : c.passed ? "pass" : "FAIL") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
    if (q.acceptance) {
      html += '<div class="card"><h2>Acceptance <span class="pill ' + (q.acceptance.passed ? "ok" : "warn") + '">' + (q.acceptance.passed ? "passed" : "not passed") + "</span></h2>" +
        (q.acceptance.reasons.length ? "<ul>" + q.acceptance.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" : '<div class="dim small">No reasons recorded.</div>') + "</div>";
    }
    var t = d.totals;
    html += '<div class="card"><h2>Normalization totals</h2><div class="tiles">' +
      tile("Accepted", int(t.posts)) + tile("Rejected", int(t.rejected)) + tile("Duplicates", int(t.duplicates)) + tile("Outside window", int(t.skippedOutsideWindow)) + tile("Retries", int(t.retries)) +
      "</div></div>";
    return html;
  }

  function renderStorage(d) {
    var html = '<div class="tiles">' + tile("Bucket size", esc(bytes(d.bucket.bytes))) + tile("Objects", int(d.bucket.objects)) + tile("Archived runs", int(d.runs.filter(function (r) { return r.archiveBytes != null; }).length)) + "</div>";
    var archived = d.runs.filter(function (r) { return r.archiveBytes != null; });
    if (archived.length) {
      html += '<div class="card"><div class="scroll"><table><thead><tr><th>Run</th><th class="num">Size</th><th class="num">Files</th><th>Created</th></tr></thead><tbody>' +
        archived.map(function (r) { return "<tr><td>" + esc(r.runId) + '</td><td class="num">' + esc(bytes(r.archiveBytes)) + '</td><td class="num">' + int(r.archiveFiles) + "</td><td>" + esc(iso(r.createdAt)) + "</td></tr>"; }).join("") +
        "</tbody></table></div></div>";
    } else {
      html += '<p class="empty">No archived runs.</p>';
    }
    return html;
  }

  function render() {
    var renderers = { overview: renderOverview, runs: renderRuns, quality: renderQuality, storage: renderStorage };
    main.innerHTML = renderers[tab](data);
    updatedEl.textContent = "as of " + iso(data.generatedAt) + " (" + ago(data.generatedAt) + ")";
    updatedEl.title = "Data snapshot time. Click Refresh to fetch again.";
  }

  document.querySelectorAll("nav.tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      tab = b.dataset.tab;
      document.querySelectorAll("nav.tabs button").forEach(function (o) { o.setAttribute("aria-selected", o === b ? "true" : "false"); });
      render();
    });
  });

  refreshBtn.addEventListener("click", function () {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    fetch("/api/summary", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (next) { data = next; errorBox.hidden = true; render(); })
      .catch(function (e) { errorBox.textContent = "Refresh failed: " + (e && e.message ? e.message : e) + ". Showing previous data."; errorBox.hidden = false; })
      .then(function () { refreshBtn.disabled = false; refreshBtn.textContent = "Refresh"; });
  });

  function themeLabel() {
    var t = document.documentElement.dataset.theme;
    themeBtn.textContent = t === "dark" ? "dark" : t === "light" ? "light" : "auto";
  }
  themeBtn.addEventListener("click", function () {
    var t = document.documentElement.dataset.theme;
    var next = !t ? "dark" : t === "dark" ? "light" : "";
    if (next) { document.documentElement.dataset.theme = next; try { localStorage.setItem("theme", next); } catch (e) {} }
    else { delete document.documentElement.dataset.theme; try { localStorage.removeItem("theme"); } catch (e) {} }
    themeLabel();
  });
  themeLabel();
  render();
})();
</script>
</body>
</html>`;
}

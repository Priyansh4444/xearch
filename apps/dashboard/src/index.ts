// Read-only dashboard for collection pilot runs stored in the xearch-runs R2 bucket.
// Routes: / (overview, see overview.ts), /nerds (full per-run detail), /api/summary, /api/runs.
// Live runs are pushed to _live/<run-id>/ by apps/collector/scripts/push-status.sh;
// archived runs are mirrored to <run-id>/ by apps/collector/scripts/sync-runs.sh.
// Only manifest.json and report.json are ever read; raw pages are never loaded.

import { buildSummary, renderOverviewHtml } from "./overview";

// Minimal R2 binding types (no @cloudflare/workers-types dependency).
interface R2Object {
  key: string;
  size: number;
}
interface R2ObjectBody extends R2Object {
  text(): Promise<string>;
}
interface R2Objects {
  objects: R2Object[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
}
interface Env {
  xearch_runs: R2Bucket;
}

// Shapes mirrored from apps/collector/src/pilot/manifest.ts and report.ts (only fields used here).
export type AccountState = "pending" | "active" | "paused" | "completed" | "abandoned";
export interface ManifestAccount {
  requestedHandle: string;
  resolvedHandle: string | null;
  cohort: string;
  state: AccountState;
  pagesCompleted: number;
  requests: number;
  retries: number;
  rowsReturned: number;
  stopReason: string | null;
  pauseReason: string | null;
  abandonReason: string | null;
  lastError: string | null;
}
export interface Manifest {
  runId: string;
  createdAt: number;
  updatedAt: number;
  historyDays: number;
  cutoffAt: number;
  acquisition: { status: string; startedAt: number | null; completedAt: number | null; accounts: ManifestAccount[] };
  normalization: {
    normalizedAt: number;
    counts: {
      accepted: { total: number; timeline: number; embedded: number };
      rejected: { total: number; timeline: number; embedded: number };
      duplicates: number;
      skippedOutsideWindow: number;
      authors: number;
    };
  } | null;
  archive: { archivedAt: number; files: { path: string; bytes: number }[] } | null;
  acceptance: { passed: boolean; reasons: string[] };
}
export interface ThresholdCheck {
  name: string;
  value: number | string | null;
  bound: string;
  passed: boolean | null;
}
export interface Report {
  generatedAt: number;
  thresholds: { passed: boolean; checks: ThresholdCheck[] };
}

export interface RunSummary {
  runId: string;
  kind: "live" | "archived";
  error: string | null;
  manifestUpdatedAt: number | null; // R2 object upload time is not exposed by list(); use manifest.updatedAt.
  status: string | null;
  accounts: { total: number; completed: number; paused: number; active: number; pending: number; abandoned: number } | null;
  requests: number | null;
  retries: number | null;
  rowsReturned: number | null;
  pages: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  cutoffAt: number | null;
  historyDays: number | null;
  acquisitionStartedAt: number | null;
  acquisitionCompletedAt: number | null;
  acceptance: { passed: boolean; reasons: string[] } | null;
  normalization: Manifest["normalization"];
  archiveBytes: number | null;
  archiveFiles: number | null;
  archivedAt: number | null;
  report: { generatedAt: number; thresholds: Report["thresholds"] } | null;
  reportError: string | null;
  accountRows: ManifestAccount[];
}

export interface Snapshot {
  generatedAt: number;
  bucket: { objects: number; bytes: number };
  runs: RunSummary[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      if (url.pathname === "/api/runs") {
        const snapshot = await buildSnapshot(env.xearch_runs);
        return new Response(JSON.stringify(snapshot, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/api/summary") {
        const snapshot = await buildSnapshot(env.xearch_runs);
        return new Response(JSON.stringify(buildSummary(snapshot)), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/") {
        const snapshot = await buildSnapshot(env.xearch_runs);
        return new Response(renderOverviewHtml(buildSummary(snapshot)), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/nerds") {
        const snapshot = await buildSnapshot(env.xearch_runs);
        return new Response(renderNerdsHtml(snapshot), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`dashboard error: ${message}`, { status: 500, headers: { "content-type": "text/plain" } });
    }
  },
};

async function buildSnapshot(bucket: R2Bucket): Promise<Snapshot> {
  const [bucketTotals, runIds] = await Promise.all([countBucket(bucket), discoverRuns(bucket)]);
  const runs = await Promise.all(runIds.map((run) => loadRun(bucket, run.runId, run.kind)));
  runs.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "live" ? -1 : 1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  return { generatedAt: Date.now(), bucket: bucketTotals, runs };
}

async function countBucket(bucket: R2Bucket): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      objects += 1;
      bytes += object.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objects, bytes };
}

async function listPrefixes(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    prefixes.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return prefixes;
}

async function discoverRuns(bucket: R2Bucket): Promise<{ runId: string; kind: "live" | "archived" }[]> {
  const [top, live] = await Promise.all([listPrefixes(bucket, ""), listPrefixes(bucket, "_live/")]);
  const runs: { runId: string; kind: "live" | "archived" }[] = [];
  for (const prefix of live) {
    runs.push({ runId: prefix.slice("_live/".length).replace(/\/$/, ""), kind: "live" });
  }
  for (const prefix of top) {
    const runId = prefix.replace(/\/$/, "");
    if (runId === "_live" || runId === "") continue;
    runs.push({ runId, kind: "archived" });
  }
  return runs;
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<{ value: T | null; error: string | null }> {
  const object = await bucket.get(key);
  if (object === null) return { value: null, error: null };
  const text = await object.text();
  try {
    return { value: JSON.parse(text) as T, error: null };
  } catch (error) {
    return { value: null, error: `${key}: ${error instanceof Error ? error.message : "invalid JSON"}` };
  }
}

async function loadRun(bucket: R2Bucket, runId: string, kind: "live" | "archived"): Promise<RunSummary> {
  const base = kind === "live" ? `_live/${runId}/` : `${runId}/`;
  const empty: RunSummary = {
    runId,
    kind,
    error: null,
    manifestUpdatedAt: null,
    status: null,
    accounts: null,
    requests: null,
    retries: null,
    rowsReturned: null,
    pages: null,
    createdAt: null,
    updatedAt: null,
    cutoffAt: null,
    historyDays: null,
    acquisitionStartedAt: null,
    acquisitionCompletedAt: null,
    acceptance: null,
    normalization: null,
    archiveBytes: null,
    archiveFiles: null,
    archivedAt: null,
    report: null,
    reportError: null,
    accountRows: [],
  };
  const [manifestResult, reportResult] = await Promise.all([
    readJson<Manifest>(bucket, `${base}manifest.json`),
    readJson<Report>(bucket, `${base}report.json`),
  ]);
  if (manifestResult.error !== null) return { ...empty, error: manifestResult.error };
  const manifest = manifestResult.value;
  if (manifest === null) return { ...empty, error: `${base}manifest.json is missing` };
  if (typeof manifest !== "object" || !Array.isArray(manifest.acquisition?.accounts)) {
    return { ...empty, error: `${base}manifest.json has an unexpected shape` };
  }
  const accounts = manifest.acquisition.accounts;
  const count = (state: AccountState) => accounts.filter((account) => account.state === state).length;
  const sum = (pick: (account: ManifestAccount) => number) => accounts.reduce((total, account) => total + (pick(account) || 0), 0);
  const report = reportResult.value;
  const reportValid = report !== null && typeof report === "object" && Array.isArray(report.thresholds?.checks);
  return {
    ...empty,
    manifestUpdatedAt: manifest.updatedAt ?? null,
    status: manifest.acquisition.status ?? null,
    accounts: {
      total: accounts.length,
      completed: count("completed"),
      paused: count("paused"),
      active: count("active"),
      pending: count("pending"),
      abandoned: count("abandoned"),
    },
    requests: sum((account) => account.requests),
    retries: sum((account) => account.retries),
    rowsReturned: sum((account) => account.rowsReturned),
    pages: sum((account) => account.pagesCompleted),
    createdAt: manifest.createdAt ?? null,
    updatedAt: manifest.updatedAt ?? null,
    cutoffAt: manifest.cutoffAt ?? null,
    historyDays: manifest.historyDays ?? null,
    acquisitionStartedAt: manifest.acquisition.startedAt ?? null,
    acquisitionCompletedAt: manifest.acquisition.completedAt ?? null,
    acceptance: manifest.acceptance ?? null,
    normalization: manifest.normalization ?? null,
    archiveBytes: manifest.archive ? manifest.archive.files.reduce((total, file) => total + (file.bytes || 0), 0) : null,
    archiveFiles: manifest.archive ? manifest.archive.files.length : null,
    archivedAt: manifest.archive?.archivedAt ?? null,
    report: reportValid ? { generatedAt: report.generatedAt, thresholds: report.thresholds } : null,
    reportError: reportResult.error ?? (report !== null && !reportValid ? `${base}report.json has an unexpected shape` : null),
    accountRows: accounts,
  };
}

// ---------- HTML ----------

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function fmtInt(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : value.toLocaleString("en-US");
}

function fmtDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function ago(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined) return "never";
  const seconds = Math.round((now - ms) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds < 0 ? "from now" : "ago";
  if (abs < 45) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)} min ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600 * 10) / 10} h ${suffix}`;
  return `${Math.round(abs / 86400 * 10) / 10} d ${suffix}`;
}

function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function fmtCheckValue(value: number | string | null): string {
  if (value === null) return "–";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return value;
}

function timeCell(ms: number | null, now: number): string {
  if (ms === null) return "–";
  return `<span title="${esc(fmtDate(ms))}">${esc(ago(ms, now))}</span> <small class="dim">${esc(fmtDate(ms))}</small>`;
}

function statusClass(status: string | null): string {
  switch (status) {
    case "completed": return "ok";
    case "in_progress": return "live";
    case "partial": return "warn";
    case "abandoned":
    case "failed": return "bad";
    default: return "";
  }
}

function renderRun(run: RunSummary, now: number): string {
  const head = `<div class="run-head">
    <h2>${esc(run.runId)}</h2>
    <span class="tag ${run.kind}">${run.kind}</span>
    ${run.status ? `<span class="tag ${statusClass(run.status)}">${esc(run.status.replace("_", " "))}</span>` : ""}
    ${run.acceptance ? `<span class="tag ${run.acceptance.passed ? "ok" : "warn"}">acceptance ${run.acceptance.passed ? "passed" : "not passed"}</span>` : ""}
    ${run.updatedAt !== null ? `<span class="dim">updated ${esc(ago(run.updatedAt, now))}</span>` : ""}
  </div>`;

  if (run.error !== null) {
    return `<section class="run">${head}<p class="error">Could not read this run: ${esc(run.error)}</p></section>`;
  }

  const a = run.accounts!;
  const done = a.completed + a.abandoned;
  const pct = a.total === 0 ? 0 : Math.round((done / a.total) * 100);
  const progress = `<div class="bar" title="${done}/${a.total} accounts finished">
    <span class="seg ok" style="width:${a.total ? (a.completed / a.total) * 100 : 0}%"></span>
    <span class="seg bad" style="width:${a.total ? (a.abandoned / a.total) * 100 : 0}%"></span>
    <span class="seg warn" style="width:${a.total ? (a.paused / a.total) * 100 : 0}%"></span>
    <span class="seg live" style="width:${a.total ? (a.active / a.total) * 100 : 0}%"></span>
  </div>
  <p class="dim small">${done}/${a.total} accounts finished (${pct}%) · completed ${a.completed} · paused ${a.paused} · active ${a.active} · pending ${a.pending} · abandoned ${a.abandoned}</p>`;

  let elapsed = "–";
  if (run.acquisitionStartedAt !== null) {
    const end = run.acquisitionCompletedAt ?? (run.status === "in_progress" ? now : run.updatedAt ?? now);
    elapsed = fmtDuration(end - run.acquisitionStartedAt);
  }

  const stats = `<dl class="stats">
    <div><dt>Requests</dt><dd>${fmtInt(run.requests)}${run.retries ? ` <small class="dim">(${fmtInt(run.retries)} retries)</small>` : ""}</dd></div>
    <div><dt>Pages</dt><dd>${fmtInt(run.pages)}</dd></div>
    <div><dt>Rows returned</dt><dd>${fmtInt(run.rowsReturned)}</dd></div>
    <div><dt>Acquisition time</dt><dd>${esc(elapsed)}</dd></div>
    <div><dt>Cutoff</dt><dd>${esc(fmtDate(run.cutoffAt))}${run.historyDays !== null ? ` <small class="dim">(${run.historyDays} days)</small>` : ""}</dd></div>
    <div><dt>Created</dt><dd>${timeCell(run.createdAt, now)}</dd></div>
    <div><dt>Updated</dt><dd>${timeCell(run.updatedAt, now)}</dd></div>
    <div><dt>Data in bucket</dt><dd>${run.archiveBytes !== null ? `${esc(fmtBytes(run.archiveBytes))} <small class="dim">(${fmtInt(run.archiveFiles)} files, archived ${esc(ago(run.archivedAt, now))})</small>` : `<span class="dim">not archived (manifest${run.report ? " + report" : ""} only)</span>`}</dd></div>
  </dl>`;

  const acceptance = run.acceptance
    ? run.acceptance.passed
      ? `<p class="ok-text">Acceptance passed.</p>`
      : `<details><summary>Acceptance not passed (${run.acceptance.reasons.length} reason${run.acceptance.reasons.length === 1 ? "" : "s"})</summary><ul>${run.acceptance.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul></details>`
    : "";

  let normalization = `<p class="dim small">Not normalized yet.</p>`;
  if (run.normalization) {
    const c = run.normalization.counts;
    normalization = `<h3>Normalization <small class="dim">${esc(ago(run.normalization.normalizedAt, now))}</small></h3>
    <dl class="stats">
      <div><dt>Accepted</dt><dd>${fmtInt(c.accepted?.total)} <small class="dim">(${fmtInt(c.accepted?.timeline)} timeline, ${fmtInt(c.accepted?.embedded)} embedded)</small></dd></div>
      <div><dt>Rejected</dt><dd>${fmtInt(c.rejected?.total)}</dd></div>
      <div><dt>Duplicates</dt><dd>${fmtInt(c.duplicates)}</dd></div>
      <div><dt>Skipped (outside window)</dt><dd>${fmtInt(c.skippedOutsideWindow)}</dd></div>
      <div><dt>Authors</dt><dd>${fmtInt(c.authors)}</dd></div>
    </dl>`;
  }

  let thresholds = "";
  if (run.report) {
    const t = run.report.thresholds;
    thresholds = `<h3>Thresholds <span class="tag ${t.passed ? "ok" : "bad"}">${t.passed ? "pass" : "fail"}</span> <small class="dim">report ${esc(ago(run.report.generatedAt, now))}</small></h3>
    <table class="checks"><thead><tr><th>Check</th><th>Value</th><th>Bound</th><th>Result</th></tr></thead><tbody>
    ${t.checks.map((check) => `<tr><td>${esc(check.name)}</td><td>${esc(fmtCheckValue(check.value))}</td><td>${esc(check.bound)}</td><td class="${check.passed === null ? "dim" : check.passed ? "ok-text" : "bad-text"}">${check.passed === null ? "n/a" : check.passed ? "pass" : "FAIL"}</td></tr>`).join("")}
    </tbody></table>`;
  } else if (run.reportError) {
    thresholds = `<p class="error">Report unreadable: ${esc(run.reportError)}</p>`;
  }

  const accountsTable = `<details><summary>Accounts (${a.total})</summary>
  <div class="scroll"><table class="accounts"><thead><tr><th>Handle</th><th>Cohort</th><th>State</th><th>Pages</th><th>Rows</th><th>Reason</th></tr></thead><tbody>
  ${run.accountRows.map((account) => {
    const reason = account.abandonReason ?? account.pauseReason ?? account.stopReason ?? "";
    const handle = account.resolvedHandle && account.resolvedHandle !== account.requestedHandle
      ? `${esc(account.requestedHandle)} <small class="dim">→ ${esc(account.resolvedHandle)}</small>`
      : esc(account.requestedHandle);
    const stateClass = account.state === "completed" ? "ok-text" : account.state === "abandoned" ? "bad-text" : account.state === "paused" ? "warn-text" : account.state === "active" ? "live-text" : "dim";
    return `<tr><td>${handle}</td><td>${esc(account.cohort)}</td><td class="${stateClass}">${esc(account.state)}</td><td>${fmtInt(account.pagesCompleted)}</td><td>${fmtInt(account.rowsReturned)}</td><td class="small">${esc(reason)}${account.lastError ? ` <span class="dim" title="${esc(account.lastError)}">(error)</span>` : ""}</td></tr>`;
  }).join("")}
  </tbody></table></div></details>`;

  return `<section class="run">${head}${progress}${stats}${acceptance}${normalization}${thresholds}${accountsTable}</section>`;
}

function renderNerdsHtml(snapshot: Snapshot): string {
  const now = snapshot.generatedAt;
  const live = snapshot.runs.filter((run) => run.kind === "live");
  const archived = snapshot.runs.filter((run) => run.kind === "archived");
  const body = snapshot.runs.length === 0
    ? `<p class="dim">The bucket has no runs yet. Archived runs appear after <code>pnpm collect:sync</code>; live runs after <code>pnpm collect:push-status</code>.</p>`
    : `${live.length ? `<h1 class="group">Live</h1>${live.map((run) => renderRun(run, now)).join("")}` : `<p class="dim">No live runs pushed.</p>`}
       ${archived.length ? `<h1 class="group">Archived</h1>${archived.map((run) => renderRun(run, now)).join("")}` : `<p class="dim">No archived runs.</p>`}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>xearch · stats for nerds</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1a1a1a; --dim: #6b6b70; --card: #fff; --line: #e2e2e6; --ok: #2f9e44; --warn: #e8a317; --bad: #d64545; --live: #3b82f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --fg: #e6e6ea; --dim: #8a8a94; --card: #181b22; --line: #2a2e38; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --live: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1rem; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 960px; margin-inline: auto; }
header { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: baseline; margin-bottom: 1rem; }
header h1 { font-size: 1.25rem; margin: 0; }
h1.group { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 1.5rem 0 .5rem; }
.run { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem; margin-bottom: 1rem; overflow: hidden; }
.run-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
.run-head h2 { font-size: 1.05rem; margin: 0; word-break: break-all; }
h3 { font-size: .95rem; margin: 1rem 0 .4rem; }
.tag { font-size: .75rem; padding: .1rem .5rem; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); text-transform: uppercase; letter-spacing: .04em; }
.tag.ok { color: var(--ok); border-color: var(--ok); }
.tag.warn { color: var(--warn); border-color: var(--warn); }
.tag.bad { color: var(--bad); border-color: var(--bad); }
.tag.live { color: var(--live); border-color: var(--live); }
.tag.archived { color: var(--dim); }
.bar { display: flex; height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; margin-top: .5rem; }
.seg.ok { background: var(--ok); } .seg.bad { background: var(--bad); } .seg.warn { background: var(--warn); } .seg.live { background: var(--live); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .6rem .9rem; margin: .75rem 0; }
.stats div { min-width: 0; }
dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dim { color: var(--dim); } .small { font-size: .85rem; }
.ok-text { color: var(--ok); } .bad-text { color: var(--bad); } .warn-text { color: var(--warn); } .live-text { color: var(--live); }
.error { color: var(--bad); background: color-mix(in srgb, var(--bad) 10%, transparent); padding: .5rem .75rem; border-radius: 6px; overflow-wrap: anywhere; }
details { margin: .5rem 0; } summary { cursor: pointer; color: var(--dim); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
td:last-child { white-space: normal; }
th { color: var(--dim); font-weight: 500; font-size: .72rem; text-transform: uppercase; }
ul { margin: .25rem 0; padding-left: 1.25rem; font-size: .9rem; }
footer { color: var(--dim); font-size: .8rem; margin-top: 2rem; }
code { font-size: .85em; }
</style>
</head>
<body>
<header>
  <h1>xearch · stats for nerds</h1>
  <span class="dim">bucket: ${fmtInt(snapshot.bucket.objects)} objects · ${esc(fmtBytes(snapshot.bucket.bytes))}</span>
  <span class="dim">rendered ${esc(fmtDate(now))}</span>
  <a href="/">overview</a>
  <a href="/api/runs">json</a>
</header>
${body}
<footer>Read-only. Refreshes every 60s. Live status is pushed by <code>pnpm collect:push-status</code>; archived runs by <code>pnpm collect:sync</code>. Archived means immutable and finalized, not successful.</footer>
</body>
</html>`;
}

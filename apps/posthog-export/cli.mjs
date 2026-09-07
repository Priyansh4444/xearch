#!/usr/bin/env node
// Offline only. No PostHog, X, or Convex client and no third-party dependencies.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const MAX_EVENT_BYTES = 200_000;
const FLOOR = Date.UTC(2006, 0, 1);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function requireValue(ok, reason) { if (!ok) throw new Error(reason); }
function id(x) { requireValue(typeof x === 'string' && /^\d+$/.test(x), 'missing/invalid string ID'); return x; }
function string(x, field) { requireValue(typeof x === 'string' && x.trim().length > 0, `missing/invalid ${field}`); return x; }
function count(x, field) { requireValue(Number.isSafeInteger(x) && x >= 0, `missing/invalid ${field}`); return x; }
function timestamp(x) {
  const n = typeof x === 'number' ? (x < 1e11 ? x * 1000 : x) : typeof x === 'string' ? Date.parse(x) : NaN;
  requireValue(Number.isSafeInteger(n) && n > FLOOR && n <= Date.now() + 300_000, 'timestamp outside (2006, now+5m]');
  return n;
}
function publicUrl(x) {
  if (typeof x !== 'string') return undefined;
  try {
    const u = new URL(x);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    u.search = ''; u.hash = '';
    return u.toString();
  } catch { return undefined; }
}
function author(a) {
  requireValue(object(a), 'missing author');
  const verified = a.verification?.verified ?? a.verified;
  requireValue(typeof verified === 'boolean', 'missing/invalid verified');
  const out = { kind: 'author', id: id(a.id), handle: string(a.screen_name, 'screen_name').replace(/^@/, ''), displayName: string(a.name, 'name'), followerCount: count(a.followers, 'followers'), followingCount: count(a.following, 'following'), verified, createdAt: timestamp(a.joined) };
  if (typeof a.description === 'string') out.bio = a.description;
  const avatar = publicUrl(a.avatar_url); if (avatar) out.avatarUrl = avatar;
  return out;
}
function media(m) {
  if (m == null) return [];
  requireValue(object(m), 'invalid media');
  const arrays = ['all', 'photos', 'videos', 'animated'];
  for (const key of arrays) requireValue(m[key] == null || Array.isArray(m[key]), 'invalid media list');
  const items = m.all?.length ? m.all.map(x => [x, undefined]) : [
    ...(m.photos ?? []).map(x => [x, 'image']), ...(m.videos ?? []).map(x => [x, 'video']), ...(m.animated ?? []).map(x => [x, 'gif'])];
  return items.map(([item, fallback]) => {
    requireValue(object(item), 'invalid media item');
    const type = ({ photo: 'image', animated_gif: 'gif' })[item.type] ?? item.type ?? fallback;
    const variants = Array.isArray(item.variants) ? item.variants : Array.isArray(item.formats) ? item.formats : [];
    const url = publicUrl(item.url) ?? variants.map(x => publicUrl(x?.url)).find(Boolean);
    requireValue(['image', 'video', 'gif'].includes(type) && url, 'unsupported media type or missing URL');
    return { type, url };
  });
}
function tweet(t, captured) {
  requireValue(object(t), 'invalid post');
  const parent = (!Array.isArray(t.replying_to) && t.replying_to?.status) || t.replying_to_status?.[0];
  const out = { kind: 'tweet', id: id(t.id), text: string(t.text, 'text'), authorId: id(t.author?.id), createdAt: timestamp(t.created_timestamp ?? t.created_at), metrics: { likes: count(t.likes, 'likes'), retweets: count(t.retweets ?? t.reposts, 'retweets'), quotes: count(t.quotes, 'quotes'), replies: count(t.replies, 'replies') }, metricsAt: captured, media: media(t.media), quotedTweetId: t.quote == null ? null : id(t.quote.id), retweetOfTweetId: null, inReplyToTweetId: parent == null ? null : id(parent) };
  // reposted_by identifies the reposter, not a new tweet or an original-status edge.
  if (typeof t.lang === 'string') out.lang = t.lang;
  return out;
}
function fingerprint(record) { const { metricsAt, ...content } = record; return hash(content); }

export function normalizeEvent(event) {
  const records = [], issues = [];
  requireValue(object(event), 'event is not an object');
  if (event.event !== 'xmd_data_captured') return { records, issues, ignored: true };
  const p = typeof event.properties === 'string' ? JSON.parse(event.properties) : event.properties;
  requireValue(object(p) && p.archive_schema_version === 1, 'unsupported archive schema');
  requireValue(typeof p.request_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.request_id), 'invalid request_id');
  requireValue(p.http_status === 200 && ['tweet', 'profile', 'search', 'followers', 'following'].includes(p.resource), 'invalid status/resource');
  requireValue(typeof p.source === 'string' && typeof p.degraded === 'boolean', 'invalid source/degraded');
  requireValue(p.cache === undefined || typeof p.cache === 'string', 'invalid cache');
  requireValue(p.warnings === undefined || (Array.isArray(p.warnings) && p.warnings.every(x => typeof x === 'string')), 'invalid warnings');
  requireValue(Number.isSafeInteger(p.chunk_count) && p.chunk_count > 0 && Number.isSafeInteger(p.chunk_index) && p.chunk_index >= 0 && p.chunk_index < p.chunk_count, 'invalid chunk indices');
  requireValue(typeof p.captured_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.captured_at), 'invalid captured_at');
  const captured = timestamp(p.captured_at);
  requireValue(Buffer.byteLength(JSON.stringify({ event: event.event, properties: p, distinct_id: event.distinct_id ?? p.distinct_id })) < MAX_EVENT_BYTES, 'oversized capture event; re-export/re-chunk upstream; no truncation');
  requireValue(object(p.payload) && Array.isArray(p.payload.posts) && Array.isArray(p.payload.users), 'invalid payload lists');
  const attempt = (raw, location, fn) => {
    try { records.push({ record: fn(raw), captured }); }
    catch (error) { issues.push({ location, reason: error.message }); }
  };
  p.payload.users.forEach((a, i) => attempt(a, `users[${i}]`, author));
  if (p.payload.profile !== undefined) attempt(p.payload.profile, 'profile', author);
  const visit = (t, location, depth = 0) => {
    if (depth > 32) { issues.push({ location, reason: 'quote nesting exceeds 32; record retained only in original export' }); return; }
    if (t?.author) attempt(t.author, `${location}.author`, author);
    attempt(t, location, x => tweet(x, captured));
    if (object(t?.quote)) visit(t.quote, `${location}.quote`, depth + 1);
  };
  p.payload.posts.forEach((t, i) => visit(t, `posts[${i}]`));
  return { records, issues, chunk: { request: hash(p.request_id), index: p.chunk_index, count: p.chunk_count } };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
async function locked(state, fn) {
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const lock = path.join(state, '.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); } catch (error) { throw new Error(`state locked: ${lock}; if a process crashed, verify it stopped before removing lock`, { cause: error }); }
  try { await handle.writeFile(String(process.pid)); return await fn(); } finally { await handle.close(); await fs.unlink(lock); }
}
async function ledgerAt(state) {
  const ledger = await readJson(path.join(state, 'ledger.json'), { version: 1, records: {}, acked: [] });
  requireValue(ledger.version === 1 && object(ledger.records) && Array.isArray(ledger.acked), 'unsupported/corrupt ledger');
  return ledger;
}

export async function stage(input, state) {
  state = path.resolve(state);
  return locked(state, async () => {
    const ledger = await ledgerAt(state);
    const batches = path.join(state, 'batches');
    await fs.mkdir(batches, { recursive: true });
    for (const name of await fs.readdir(batches)) {
      if (!name.startsWith('.') && !ledger.acked.includes(name)) throw new Error(`pending batch ${name}: retry ingestion and ack before staging more input`);
    }
    const coverage = await readJson(path.join(state, 'chunks.json'), {});
    const selected = new Map(), issues = [], chunks = new Map(Object.entries(coverage).map(([key, group]) => [key, { count: group.count, seen: new Set(group.seen) }]));
    let lines = 0, ignored = 0, duplicates = 0;
    for await (const raw of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
      lines++;
      if (!raw.trim()) continue;
      try {
        const result = normalizeEvent(JSON.parse(raw));
        if (result.ignored) { ignored++; continue; }
        issues.push(...result.issues.map(x => ({ line: lines, ...x })));
        const chunk = result.chunk;
        const group = chunks.get(chunk.request) ?? { count: chunk.count, seen: new Set() };
        if (group.count !== chunk.count) issues.push({ line: lines, reason: 'inconsistent chunk_count' });
        group.seen.add(chunk.index); chunks.set(chunk.request, group);
        for (const entry of result.records) {
          const r = entry.record, key = `${r.kind}:${r.id}`;
          const previous = selected.get(key) ?? ledger.records[key];
          const candidate = { ...entry, hash: fingerprint(r), textHash: r.kind === 'tweet' ? hash(r.text) : undefined };
          if (previous?.textHash && previous.textHash !== candidate.textHash) { issues.push({ line: lines, kind: r.kind, id: r.id, reason: 'text changed for existing tweet ID; explicit edit policy required' }); continue; }
          if (previous && candidate.captured < previous.captured) { duplicates++; continue; }
          if (previous && candidate.hash === previous.hash) { duplicates++; selected.set(key, candidate); continue; }
          if (previous && candidate.captured === previous.captured && candidate.hash !== previous.hash) { issues.push({ line: lines, kind: r.kind, id: r.id, reason: 'conflicting content at same snapshot time' }); continue; }
          selected.set(key, candidate);
        }
      } catch (error) { issues.push({ line: lines, sha256: hash(raw), reason: error instanceof SyntaxError ? 'invalid JSON event/properties' : error.message }); }
    }
    for (const group of chunks.values()) if (group.seen.size !== group.count) issues.push({ reason: 'incomplete request chunks across observed exports', expected: group.count, received: group.seen.size });
    const entries = [...selected.entries()].filter(([key, x]) => ledger.records[key]?.hash !== x.hash).sort(([a], [b]) => a.localeCompare(b)); // author:* precedes tweet:*
    const content = entries.map(([, x]) => JSON.stringify(x.record) + '\n').join('');
    const batch = `posthog-${Date.now()}-${randomUUID()}`;
    const temp = path.join(batches, `.${batch}.tmp`), target = path.join(batches, batch);
    await fs.mkdir(path.join(temp, 'ingress'), { recursive: true });
    const filename = `${batch}.jsonl`;
    await fs.writeFile(path.join(temp, 'ingress', filename), content, { mode: 0o600 });
    const manifest = { version: 1, batch, filename, createdAt: new Date().toISOString(), inputLines: lines, ignored, duplicates, records: entries.length, tweets: entries.filter(([, x]) => x.record.kind === 'tweet').length, sha256: hash(content), quarantineCount: issues.length, entries: entries.map(([key, x]) => ({ key, hash: x.hash, textHash: x.textHash, captured: x.captured })) };
    await atomic(path.join(temp, 'manifest.json'), manifest);
    await fs.writeFile(path.join(temp, 'quarantine.jsonl'), issues.map(x => JSON.stringify(x) + '\n').join(''), { mode: 0o600 });
    await fs.rename(temp, target); // publish only a closed, complete batch
    await atomic(path.join(state, 'chunks.json'), Object.fromEntries([...chunks].map(([key, group]) => [key, { count: group.count, seen: [...group.seen] }])));
    if (manifest.records === 0) {
      // There is nothing to upload. Keep diagnostic sidecars, but do not block the next export.
      ledger.acked.push(batch);
      await atomic(path.join(state, 'ledger.json'), ledger);
    }
    return { batch, directory: target, records: manifest.records, tweets: manifest.tweets, quarantineCount: issues.length };
  });
}

export async function acknowledge(state, batch, checkpointFile, quarantineDir) {
  state = path.resolve(state);
  requireValue(/^posthog-[0-9]+-[0-9a-f-]+$/.test(batch), 'invalid batch name');
  return locked(state, async () => {
    const ledger = await ledgerAt(state);
    if (ledger.acked.includes(batch)) return { batch, alreadyAcknowledged: true };
    const dir = path.join(state, 'batches', batch), manifest = await readJson(path.join(dir, 'manifest.json'));
    requireValue(manifest.batch === batch && manifest.filename === `${batch}.jsonl`, 'manifest mismatch');
    const content = await fs.readFile(path.join(dir, 'ingress', manifest.filename), 'utf8');
    requireValue(hash(content) === manifest.sha256, 'staged file changed; refusing ack');
    const checkpoint = await readJson(checkpointFile);
    requireValue(typeof checkpoint.configHash === 'string' || typeof checkpoint.config_hash === 'string', 'invalid indexer checkpoint');
    requireValue(checkpoint.offsets?.[manifest.filename] === manifest.records, 'checkpoint does not cover the complete batch; retry backfill without --limit');
    await fs.stat(quarantineDir); // explicit directory required; do not hide a wrong path
    try {
      const q = await fs.readFile(path.join(quarantineDir, manifest.filename), 'utf8');
      requireValue(q.trim() === '', 'indexer quarantined records; resolve/retry before ack');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of manifest.entries) ledger.records[entry.key] = { hash: entry.hash, textHash: entry.textHash, captured: entry.captured };
    ledger.acked.push(batch);
    await atomic(path.join(state, 'ledger.json'), ledger);
    return { batch, acknowledged: manifest.records };
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stage' && args.length === 2) return stage(args[0], args[1]);
  if (command === 'ack' && args.length === 4) return acknowledge(...args);
  throw new Error('Usage: node apps/posthog-export/cli.mjs stage EXPORT.jsonl STATE_DIR\n       node apps/posthog-export/cli.mjs ack STATE_DIR BATCH CHECKPOINT.json INDEXER_QUARANTINE_DIR');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

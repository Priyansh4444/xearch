import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeEvent, stage, ingest, acknowledge } from './cli.mjs';

const author = { id: '42', screen_name: 'alice', name: 'Alice', followers: 20, following: 5, verification: { verified: false }, joined: '2010-01-01T00:00:00Z' };
const post = { id: '123', text: 'Full text 😀', author, likes: 1, reposts: 2, quotes: 3, replies: 4, created_timestamp: 1700000000 };
function event(posts = [post], extra = {}) {
  return { event: 'xmd_data_captured', distinct_id: 'private-requester', properties: { archive_schema_version: 1, request_id: '00000000-0000-4000-8000-000000000001', captured_at: '2025-01-01T00:00:00Z', resource: 'tweet', http_status: 200, source: 'fxtwitter', degraded: false, chunk_index: 0, chunk_count: 1, payload: { posts, users: [] }, ...extra } };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xearch-posthog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'export.jsonl'), state = path.join(dir, 'state');
  const write = events => fs.writeFile(input, events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n');
  return { dir, input, state, write };
}
// Native child-process boundary is mocked: tests never run Cargo or contact Convex.
function mockIndexer({ offset, rejected = false, code = 0, signal = null, error, during } = {}) {
  return async (command, args, options) => {
    assert.equal(command, 'cargo');
    assert.ok(path.isAbsolute(options.cwd));
    assert.ok(path.isAbsolute(args[args.indexOf('--manifest-path') + 1]));
    assert.ok(path.isAbsolute(args[args.indexOf('--lexicons') + 1]));
    const dataDir = args[args.indexOf('--data-dir') + 1];
    const checkpoint = args[args.indexOf('--checkpoint') + 1];
    const quarantine = args[args.indexOf('--quarantine') + 1];
    const [filename] = await fs.readdir(dataDir);
    const rows = (await fs.readFile(path.join(dataDir, filename), 'utf8')).trim().split('\n').length;
    const attempt = JSON.parse(await fs.readFile(path.join(path.dirname(checkpoint), 'attempt.json'), 'utf8'));
    assert.equal(attempt.status, 'started');
    assert.equal(attempt.checkpoint, checkpoint);
    assert.equal(attempt.quarantine, quarantine);
    assert.equal(await fs.realpath(quarantine), quarantine);
    if (error) throw new Error(error);
    await fs.writeFile(checkpoint, JSON.stringify({ config_hash: 'test', offsets: { [filename]: offset ?? rows } }));
    if (rejected) await fs.writeFile(path.join(quarantine, filename), 'rejected record\n');
    if (during) await during({ checkpoint, quarantine, dataDir, filename, attempt });
    return { code, signal };
  };
}
test('object/string properties, closed fields, epoch seconds/ms, quotes and identity separation', () => {
  const e = event([{ ...post, created_timestamp: 1700000000000, quote: { ...post, id: '124' }, replying_to: { status: '122' } }]);
  e.properties.url = 'https://private.example/?token=secret';
  const a = normalizeEvent(e);
  const b = normalizeEvent({ ...e, properties: JSON.stringify(e.properties) });
  assert.deepEqual(a, b);
  assert.equal(a.records.length, 4);
  const tweet = a.records.find(x => x.record.id === '123').record;
  assert.equal(tweet.createdAt, 1700000000000);
  assert.equal(tweet.quotedTweetId, '124');
  assert.equal(tweet.inReplyToTweetId, '122');
  assert.equal(tweet.metrics.retweets, 2);
  assert.equal(JSON.stringify(a.records).includes('private'), false);
  assert.deepEqual(Object.keys(tweet).sort(), ['kind', 'id', 'text', 'authorId', 'createdAt', 'metrics', 'metricsAt', 'media', 'quotedTweetId', 'retweetOfTweetId', 'inReplyToTweetId'].sort());
});
test('missing author facts defer to indexer stubs; missing metrics never become zero', () => {
  const result = normalizeEvent(event([{ ...post, author: { id: '42' } }, { ...post, id: '124', likes: undefined }]));
  assert.equal(result.records.filter(x => x.record.kind === 'tweet').length, 1);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.some(x => x.reason.includes('likes')));
});
test('media provider variants and repost metadata do not invent edges', () => {
  const r = normalizeEvent(event([{ ...post, reposted_by: { id: '99' }, media: { photos: [{ url: 'https://img.example/a' }], videos: [{ formats: [{ url: 'https://video.example/a', container: 'mp4' }] }], animated: [{ type: 'animated_gif', url: 'https://video.example/b' }] } }])).records.at(-1).record;
  assert.deepEqual(r.media.map(x => x.type), ['image', 'video', 'gif']);
  assert.equal(r.retweetOfTweetId, null);
});
test('malformed versions, sizes and timestamps reject; unrelated events ignored', () => {
  assert.equal(normalizeEvent({ event: 'other' }).ignored, true);
  assert.throws(() => normalizeEvent(event([], { archive_schema_version: 2 })), /schema/);
  assert.throws(() => normalizeEvent(event([{ ...post, text: 'a'.repeat(200000) }])), /oversized/);
  assert.throws(() => normalizeEvent(event([], { captured_at: 'not-date' })), /captured_at/);
  assert.equal(normalizeEvent(event([{ ...post, created_at: 'bad', created_timestamp: undefined }])).issues.length, 1);
});
test('stage, retry, checkpoint-gated ack, content dedup and changed metrics', async t => {
  const f = await fixture(t);
  await f.write([event(), event(), 'not json']);
  const batch = await stage(f.input, f.state);
  assert.equal(batch.records, 2); assert.equal(batch.quarantineCount, 1);
  await assert.rejects(stage(f.input, f.state), /pending batch/);
  await assert.rejects(fs.stat(path.join(f.state, 'ledger.json')), /ENOENT/);
  await assert.rejects(acknowledge(f.state, batch.batch), /no bound ingestion attempt/);
  await assert.rejects(acknowledge(f.state, batch.batch, 'wrong-checkpoint', 'wrong-quarantine'), /no longer accepts proof paths/);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ offset: 1 }) }), /complete batch/);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ rejected: true }) }), /quarantined/);
  assert.equal((await ingest(f.state, batch.batch, { run: mockIndexer() })).acknowledged, 2);
  assert.equal((await acknowledge(f.state, batch.batch)).alreadyAcknowledged, true);
  const attempts = await fs.readdir(path.join(batch.directory, 'attempts'));
  assert.equal(attempts.length, 3); // Fresh retries retain prior failure evidence.
  const rejections = await Promise.all(attempts.map(async id => fs.readdir(path.join(batch.directory, 'attempts', id, 'quarantine'))));
  assert.equal(rejections.flat().length, 1);
  await f.write([event(), event([{ ...post, likes: 8 }], { captured_at: '2025-01-02T00:00:00Z' }), event([{ ...post, text: 'Edited' }], { captured_at: '2025-01-03T00:00:00Z' })]);
  const next = await stage(f.input, f.state);
  assert.equal(next.records, 1); assert.equal(next.quarantineCount, 1);
  const output = await fs.readFile(path.join(next.directory, 'ingress', `${next.batch}.jsonl`), 'utf8');
  assert.equal(JSON.parse(output).metrics.likes, 8);
  assert.equal(output.includes('private-requester'), false);
});
test('file tampering and concurrent state lock block ack/staging', async t => {
  const f = await fixture(t); await f.write([event()]);
  const batch = await stage(f.input, f.state);
  await fs.appendFile(path.join(batch.directory, 'ingress', `${batch.batch}.jsonl`), '\n');
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer() }), /changed/);
  await fs.writeFile(path.join(f.state, '.lock'), 'stale');
  await assert.rejects(stage(f.input, f.state), /state locked/);
});
test('partial chunks reported, all exported resources supported', async t => {
  const f = await fixture(t);
  await f.write(['profile', 'search', 'followers', 'following'].map(resource => event([], { resource, chunk_count: 2, payload: { posts: [], users: [author], profile: author } })));
  const batch = await stage(f.input, f.state);
  assert.equal(batch.records, 1); assert.equal(batch.quarantineCount, 1);
});

test('chunk coverage spans windows; empty diagnostic batches do not block', async t => {
  const f = await fixture(t);
  await f.write([event([], { chunk_count: 2 })]);
  assert.equal((await stage(f.input, f.state)).quarantineCount, 1);
  await f.write([event([], { chunk_count: 2, chunk_index: 1 })]);
  assert.equal((await stage(f.input, f.state)).quarantineCount, 0);
  const coverage = JSON.parse(await fs.readFile(path.join(f.state, 'chunks.json'), 'utf8'));
  assert.equal(Object.values(coverage)[0].seen.length, 2);
  assert.equal(JSON.stringify(coverage).includes('00000000-0000'), false);
});
test('out-of-order snapshots select newest; public URLs omit query credentials', async t => {
  const f = await fixture(t);
  await f.write([event([{ ...post, likes: 8 }], { captured_at: '2025-01-03T00:00:00Z' }), event([{ ...post, likes: 7 }], { captured_at: '2025-01-02T00:00:00Z' })]);
  const b = await stage(f.input, f.state);
  const rows = (await fs.readFile(path.join(b.directory, 'ingress', `${b.batch}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).metrics.likes, 8);
  const r = normalizeEvent(event([{ ...post, media: { photos: [{ url: 'https://img.example/a?token=secret#secret' }] } }])).records.at(-1).record;
  assert.equal(r.media[0].url, 'https://img.example/a');
});

for (const mixed of [false, true]) {
  test(`unchanged newer snapshots advance cross-run watermarks (${mixed ? 'mixed delta' : 'zero delta'})`, async t => {
    const f = await fixture(t);
    const ack = batch => ingest(f.state, batch.batch, { run: mockIndexer() });
    await f.write([event()]);
    await ack(await stage(f.input, f.state));
    const newer = '2025-01-03T00:00:00Z';
    await f.write([event(mixed ? [post, { ...post, id: '124' }] : [post], { captured_at: newer })]);
    const batch = await stage(f.input, f.state);
    assert.equal(batch.records, mixed ? 1 : 0);
    const readLedger = async () => JSON.parse(await fs.readFile(path.join(f.state, 'ledger.json'), 'utf8'));
    if (mixed) {
      // A pending delta must not advance either record's committed watermark.
      assert.equal((await readLedger()).records['tweet:123'].captured, Date.parse('2025-01-01T00:00:00Z'));
      await ack(batch);
    }
    const ledger = await readLedger();
    assert.equal(ledger.records['tweet:123'].captured, Date.parse(newer));
    assert.equal(ledger.records['author:42'].captured, Date.parse(newer));
    await f.write([event([{ ...post, likes: 8, author: { ...author, followers: 100 } }], { captured_at: '2025-01-02T00:00:00Z' })]);
    assert.equal((await stage(f.input, f.state)).records, 0);
    // A genuinely newer changed observation is still eligible.
    await f.write([event([{ ...post, likes: 9 }], { captured_at: '2025-01-04T00:00:00Z' })]);
    assert.equal((await stage(f.input, f.state)).records, 1);
  });
}

test('raw export lines are bounded before parsing and oversized lines do not hide following records', async t => {
  const f = await fixture(t);
  const oversized = JSON.stringify({ ...event(), export_metadata: 'x'.repeat(1_000_000) });
  const valid = JSON.stringify(event([{ ...post, text: 'multibyte 😀' }]));
  const malformed = '😀'.repeat(300_000);
  await fs.writeFile(f.input, oversized + '\n' + valid + '\r\n' + malformed);
  const batch = await stage(f.input, f.state);
  assert.equal(batch.records, 2);
  assert.equal(batch.quarantineCount, 2);
  const issues = (await fs.readFile(path.join(batch.directory, 'quarantine.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(issues.map(x => x.line), [1, 3]);
  for (const [i, raw] of [oversized, malformed].entries()) {
    assert.match(issues[i].reason, /export line exceeds/);
    assert.equal(issues[i].sha256, createHash('sha256').update(raw).digest('hex'));
  }
});
test('raw line byte bound accepts the boundary and normal unterminated JSONL', async t => {
  const f = await fixture(t);
  const raw = JSON.stringify(event());
  await fs.writeFile(f.input, raw + ' '.repeat(1_000_000 - Buffer.byteLength(raw)));
  const batch = await stage(f.input, f.state);
  assert.equal(batch.records, 2);
  assert.equal(batch.quarantineCount, 0);
});

for (const failure of [{ code: 1 }, { code: null, signal: 'SIGTERM' }, { error: 'spawn failed' }]) {
  test(`unsuccessful process cannot acknowledge: ${JSON.stringify(failure)}`, async t => {
    const f = await fixture(t); await f.write([event()]);
    const batch = await stage(f.input, f.state);
    await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer(failure) }), /process failed|spawn failed/);
    await assert.rejects(acknowledge(f.state, batch.batch), /did not complete successfully/);
    await assert.rejects(fs.stat(path.join(f.state, '.lock')), /ENOENT/);
    assert.equal((await ingest(f.state, batch.batch, { run: mockIndexer() })).acknowledged, 2);
  });
}
test('successful process can resume ack after local ledger write failure', async t => {
  const f = await fixture(t); await f.write([event()]);
  const batch = await stage(f.input, f.state);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ during: async () => {
    await fs.mkdir(path.join(f.state, 'ledger.json'));
  } }) }), /EISDIR/);
  await fs.rmdir(path.join(f.state, 'ledger.json'));
  assert.equal((await acknowledge(f.state, batch.batch)).acknowledged, 2);
});
test('successful process cannot ack a batch changed while it ran, even with matching checkpoint', async t => {
  const f = await fixture(t); await f.write([event()]);
  const batch = await stage(f.input, f.state);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ during: async ({ dataDir, filename }) => {
    await fs.appendFile(path.join(dataDir, filename), '\n');
  } }) }), /staged file changed/);
  await assert.rejects(fs.stat(path.join(f.state, 'ledger.json')), /ENOENT/);
});
test('wrong quarantine path cannot be substituted for a rejected bound attempt', async t => {
  const f = await fixture(t); await f.write([event()]);
  const batch = await stage(f.input, f.state);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ rejected: true }) }), /quarantined/);
  const clean = path.join(f.dir, 'clean'); await fs.mkdir(clean);
  await assert.rejects(acknowledge(f.state, batch.batch, path.join(f.dir, 'checkpoint.json'), clean), /no longer accepts proof paths/);
  await assert.rejects(acknowledge(f.state, batch.batch), /quarantined/);
});

test('legacy CLI proof-path overrides fail closed before touching state', () => {
  const result = spawnSync(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'ack', 'unused', 'unused', 'checkpoint', 'quarantine'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer accepts proof paths/);
});
test('state stays locked while the child runs and ack validates recorded attempt hash', async t => {
  const f = await fixture(t); await f.write([event()]);
  const batch = await stage(f.input, f.state);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ during: async () => {
    await assert.rejects(stage(f.input, f.state), /state locked/);
    await assert.rejects(acknowledge(f.state, batch.batch), /state locked/);
    await fs.mkdir(path.join(f.state, 'ledger.json'));
  } }) }), /EISDIR/);
  await fs.rmdir(path.join(f.state, 'ledger.json'));
  const latest = JSON.parse(await fs.readFile(path.join(batch.directory, 'latest-attempt.json'), 'utf8'));
  const attemptFile = path.join(batch.directory, 'attempts', latest.attemptId, 'attempt.json');
  const attempt = JSON.parse(await fs.readFile(attemptFile, 'utf8'));
  await fs.writeFile(attemptFile, JSON.stringify({ ...attempt, sha256: 'mismatched' }));
  await assert.rejects(acknowledge(f.state, batch.batch), /does not match immutable batch/);
});

for (const mode of ['success', 'nonzero', 'signal', 'missing-executable']) {
  test(`native subprocess boundary with fake Cargo: ${mode}`, async t => {
    const f = await fixture(t); await f.write([event()]);
    const batch = await stage(f.input, f.state);
    const bin = path.join(f.dir, 'bin'); await fs.mkdir(bin);
    if (mode !== 'missing-executable') await fs.writeFile(path.join(bin, 'cargo'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'run' || args.at(-1) !== 'backfill') process.exit(9);
if (process.env.FAKE_CARGO_MODE === 'nonzero') process.exit(17);
if (process.env.FAKE_CARGO_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
else {
  const dataDir = args[args.indexOf('--data-dir') + 1];
  const checkpoint = args[args.indexOf('--checkpoint') + 1];
  const filename = fs.readdirSync(dataDir)[0];
  const rows = fs.readFileSync(path.join(dataDir, filename), 'utf8').trim().split('\\n').length;
  fs.writeFileSync(checkpoint, JSON.stringify({ config_hash: 'fake', offsets: { [filename]: rows } }));
}
`, { mode: 0o700 });
    const alias = path.join(f.dir, 'state-link'); await fs.symlink(f.state, alias);
    const result = spawnSync(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'ingest', alias, batch.batch], {
      cwd: f.dir, encoding: 'utf8', env: { ...process.env, PATH: bin, FAKE_CARGO_MODE: mode }, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    const latest = JSON.parse(await fs.readFile(path.join(batch.directory, 'latest-attempt.json'), 'utf8'));
    const attempt = JSON.parse(await fs.readFile(path.join(batch.directory, 'attempts', latest.attemptId, 'attempt.json'), 'utf8'));
    assert.equal(attempt.status, mode === 'success' ? 'succeeded' : 'failed');
    if (mode === 'success') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).acknowledged, 2);
    } else {
      assert.equal(result.status, 1, result.stderr);
      await assert.rejects(acknowledge(f.state, batch.batch), /did not complete successfully/);
    }
    await assert.rejects(fs.stat(path.join(f.state, '.lock')), /ENOENT/);
  });
}
for (const missing of ['checkpoint', 'quarantine']) {
  test(`bound acknowledgement rejects missing ${missing}`, async t => {
    const f = await fixture(t); await f.write([event()]);
    const batch = await stage(f.input, f.state);
    await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ during: async proof => {
      await fs.rm(proof[missing], { recursive: true });
    } }) }), /ENOENT/);
    await assert.rejects(fs.stat(path.join(f.state, 'ledger.json')), /ENOENT/);
  });
}
test('bound acknowledgement rejects edited attempt paths', async t => {
  const f = await fixture(t); await f.write([event()]);
  const batch = await stage(f.input, f.state);
  await assert.rejects(ingest(f.state, batch.batch, { run: mockIndexer({ offset: 1 }) }), /complete batch/);
  const latest = JSON.parse(await fs.readFile(path.join(batch.directory, 'latest-attempt.json'), 'utf8'));
  const attemptFile = path.join(batch.directory, 'attempts', latest.attemptId, 'attempt.json');
  const attempt = JSON.parse(await fs.readFile(attemptFile, 'utf8'));
  await fs.writeFile(attemptFile, JSON.stringify({ ...attempt, quarantine: f.dir }));
  await assert.rejects(acknowledge(f.state, batch.batch), /paths do not match/);
});

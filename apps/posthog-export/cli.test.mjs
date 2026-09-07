import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeEvent, stage, acknowledge } from './cli.mjs';

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
  const checkpoint = path.join(f.dir, 'checkpoint.json'), quarantine = path.join(f.dir, 'quarantine');
  await fs.mkdir(quarantine);
  const filename = `${batch.batch}.jsonl`;
  await fs.writeFile(checkpoint, JSON.stringify({ config_hash: 'test', offsets: { [filename]: 1 } }));
  await assert.rejects(acknowledge(f.state, batch.batch, checkpoint, quarantine), /complete batch/);
  await fs.writeFile(checkpoint, JSON.stringify({ config_hash: 'test', offsets: { [filename]: 2 } }));
  await fs.writeFile(path.join(quarantine, filename), 'rejected record\n');
  await assert.rejects(acknowledge(f.state, batch.batch, checkpoint, quarantine), /quarantined/);
  await fs.unlink(path.join(quarantine, filename));
  assert.equal((await acknowledge(f.state, batch.batch, checkpoint, quarantine)).acknowledged, 2);
  assert.equal((await acknowledge(f.state, batch.batch, checkpoint, quarantine)).alreadyAcknowledged, true);
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
  await assert.rejects(acknowledge(f.state, batch.batch, 'unused', 'unused'), /changed/);
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

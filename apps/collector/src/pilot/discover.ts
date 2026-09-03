// Gate 2: one-hop account discovery (docs/collection/01-pilot.md "Gate 2").
// Evidence comes only from retained raw pages of finished or running seed runs.
// Output is a ranked report for human approval; admission is never automatic.

import type { PilotClient } from "../acquisition/fxtwitter.ts";
import type { PilotAccount, PilotConfig } from "../config/pilot.ts";
import { isRecord } from "../normalization/mapping.ts";
import type { RawPageInput } from "../normalization/normalize.ts";

export type InteractionKind = "reply" | "quote" | "repost" | "mention";

export interface DiscoveryCandidate {
  /** Numeric id when any evidence carried one; otherwise null until resolved. */
  userId: string | null;
  /** Lowercase handle as last seen in the evidence. */
  handle: string | null;
  displayName: string | null;
  followers: number | null;
  statuses: number | null;
  protected: boolean | null;
  /** Distinct seed user ids that interacted with this account. */
  seeds: string[];
  interactions: Record<InteractionKind, number>;
  /** Present when the account is already part of the seed configuration. */
  configured: boolean;
  resolution: "embedded" | "resolved" | "unresolved" | "not_found" | "mismatch";
}

export interface DiscoveryOptions {
  seeds: { userId: string; handle: string }[];
  /** Handles (lowercase) and ids already configured; they are reported but never proposed. */
  configuredIds: Set<string>;
  configuredHandles: Set<string>;
  minSeeds: number;
}

interface Bucket {
  userId: string | null;
  handle: string | null;
  displayName: string | null;
  followers: number | null;
  statuses: number | null;
  protected: boolean | null;
  seeds: Set<string>;
  interactions: Record<InteractionKind, number>;
}

/** Pure: raw pages in, ranked candidates out. */
export function discoverFromPages(pages: RawPageInput[], options: DiscoveryOptions): DiscoveryCandidate[] {
  const handleToId = new Map<string, string>();
  const byId = new Map<string, Bucket>();
  const byHandle = new Map<string, Bucket>();
  const seedIds = new Set(options.seeds.map((seed) => seed.userId));

  const learn = (author: unknown): void => {
    if (!isRecord(author)) return;
    const id = str(author.id);
    const handle = lower(str(author.screen_name));
    if (id !== null && handle !== null) handleToId.set(handle, id);
  };

  const bucketFor = (id: string | null, handle: string | null): Bucket | null => {
    const resolvedId = id ?? (handle !== null ? (handleToId.get(handle) ?? null) : null);
    if (resolvedId !== null) {
      if (seedIds.has(resolvedId)) return null;
      let bucket = byId.get(resolvedId);
      if (bucket === undefined) {
        bucket = newBucket(resolvedId, handle);
        byId.set(resolvedId, bucket);
        if (handle !== null) {
          const orphan = byHandle.get(handle);
          if (orphan !== undefined) {
            mergeInto(bucket, orphan);
            byHandle.delete(handle);
          }
        }
      }
      if (handle !== null) bucket.handle = handle;
      return bucket;
    }
    if (handle === null) return null;
    let bucket = byHandle.get(handle);
    if (bucket === undefined) {
      bucket = newBucket(null, handle);
      byHandle.set(handle, bucket);
    }
    return bucket;
  };

  const record = (bucket: Bucket | null, seed: string, kind: InteractionKind, author?: unknown): void => {
    if (bucket === null) return;
    bucket.seeds.add(seed);
    bucket.interactions[kind] += 1;
    if (isRecord(author)) {
      bucket.displayName = str(author.name) ?? bucket.displayName;
      bucket.followers = num(author.followers) ?? bucket.followers;
      bucket.statuses = num(author.statuses) ?? bucket.statuses;
      bucket.protected = typeof author.protected === "boolean" ? author.protected : bucket.protected;
    }
  };

  // Pass 1: learn every handle -> id pair the pages expose, so reply handles resolve.
  for (const page of pages) {
    for (const row of page.results) {
      if (!isRecord(row)) continue;
      learn(row.author);
      if (isRecord(row.quote)) learn(row.quote.author);
      if (isRecord(row.reposted_by)) learn(row.reposted_by);
      for (const facet of facets(row)) {
        if (facet.type === "mention") {
          const id = str(facet.id);
          const handle = lower(str(facet.original));
          if (id !== null && handle !== null) handleToId.set(handle, id);
        }
      }
    }
  }

  // Pass 2: evidence. Only rows authored by the seed (or reposted by it) count.
  for (const page of pages) {
    const seed = page.accountUserId;
    for (const row of page.results) {
      if (!isRecord(row) || !isRecord(row.author)) continue;
      const authorId = str(row.author.id);
      const reposted = isRecord(row.reposted_by) && str(row.reposted_by.id) === seed;
      if (reposted) {
        record(bucketFor(authorId, lower(str(row.author.screen_name))), seed, "repost", row.author);
        continue;
      }
      if (authorId !== seed) continue;

      if (isRecord(row.replying_to)) {
        const handle = lower(str(row.replying_to.screen_name));
        record(bucketFor(null, handle), seed, "reply");
      }
      if (isRecord(row.quote) && row.quote.type === "status" && isRecord(row.quote.author)) {
        record(bucketFor(str(row.quote.author.id), lower(str(row.quote.author.screen_name))), seed, "quote", row.quote.author);
      }
      const replyTarget = isRecord(row.replying_to) ? lower(str(row.replying_to.screen_name)) : null;
      for (const facet of facets(row)) {
        if (facet.type !== "mention") continue;
        const handle = lower(str(facet.original));
        if (handle === null || handle === replyTarget) continue;
        record(bucketFor(str(facet.id), handle), seed, "mention");
      }
    }
  }

  const candidates: DiscoveryCandidate[] = [];
  for (const bucket of [...byId.values(), ...byHandle.values()]) {
    if (bucket.seeds.size < options.minSeeds) continue;
    const configured =
      (bucket.userId !== null && options.configuredIds.has(bucket.userId)) ||
      (bucket.handle !== null && options.configuredHandles.has(bucket.handle));
    candidates.push({
      userId: bucket.userId,
      handle: bucket.handle,
      displayName: bucket.displayName,
      followers: bucket.followers,
      statuses: bucket.statuses,
      protected: bucket.protected,
      seeds: [...bucket.seeds].sort(),
      interactions: { ...bucket.interactions },
      configured,
      resolution: bucket.userId === null ? "unresolved" : "embedded",
    });
  }
  return candidates.sort(
    (a, b) =>
      b.seeds.length - a.seeds.length ||
      total(b) - total(a) ||
      (a.handle ?? "").localeCompare(b.handle ?? ""),
  );
}

/** Resolve handle-only candidates through the profile endpoint, one request at a time. */
export async function resolveCandidates(
  candidates: DiscoveryCandidate[],
  client: PilotClient,
  pace: () => Promise<void>,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.resolution !== "unresolved" || candidate.handle === null) continue;
    await pace();
    try {
      const response = await client.fetchProfile(candidate.handle);
      if (response.profile === null) {
        candidate.resolution = "not_found";
        continue;
      }
      candidate.userId = response.profile.id;
      candidate.handle = response.profile.screenName.toLowerCase();
      candidate.displayName = response.profile.name;
      candidate.protected = response.profile.protected;
      const user = isRecord(response.raw) && isRecord(response.raw.user) ? response.raw.user : null;
      if (user !== null) {
        candidate.followers = num(user.followers) ?? candidate.followers;
        candidate.statuses = num(user.statuses) ?? candidate.statuses;
      }
      candidate.resolution = "resolved";
    } catch (error) {
      candidate.resolution = "unresolved";
      log(`@${candidate.handle}: resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Candidates that can go straight into a gate-2 config: resolved, public, not already configured. */
export function proposeConfig(base: PilotConfig, candidates: DiscoveryCandidate[]): PilotConfig {
  const accounts: PilotAccount[] = [];
  for (const candidate of candidates) {
    if (candidate.configured || candidate.userId === null || candidate.handle === null) continue;
    if (candidate.protected === true) continue;
    if (candidate.resolution !== "embedded" && candidate.resolution !== "resolved") continue;
    accounts.push({ handle: candidate.handle, expectedUserId: candidate.userId, cohort: "guest" });
  }
  return { ...base, accounts };
}

export function renderMarkdown(candidates: DiscoveryCandidate[], minSeeds: number, sourceRuns: string[]): string {
  const lines = [
    `# Discovery report`,
    ``,
    `Source runs: ${sourceRuns.join(", ")}. Threshold: at least ${minSeeds} distinct seeds.`,
    `Interactions are replies, quotes, reposts, and mentions by seed accounts. Nothing here is`,
    `admitted automatically; copy approved rows into a frozen gate-2 config.`,
    ``,
    `| # | Handle | User id | Seeds | Reply | Quote | Repost | Mention | Followers | Posts | Flags |`,
    `|--:|---|---|--:|--:|--:|--:|--:|--:|--:|---|`,
  ];
  candidates.forEach((candidate, index) => {
    const flags = [
      candidate.configured ? "configured" : "",
      candidate.protected ? "protected" : "",
      candidate.resolution === "unresolved" ? "unresolved" : "",
      candidate.resolution === "not_found" ? "not found" : "",
      candidate.statuses !== null && candidate.statuses < 250 ? "<250 posts" : "",
    ].filter(Boolean);
    lines.push(
      `| ${index + 1} | \`${candidate.handle ?? "?"}\` | ${candidate.userId ? `\`${candidate.userId}\`` : "—"} | ${candidate.seeds.length} | ${candidate.interactions.reply} | ${candidate.interactions.quote} | ${candidate.interactions.repost} | ${candidate.interactions.mention} | ${fmt(candidate.followers)} | ${fmt(candidate.statuses)} | ${flags.join(", ")} |`,
    );
  });
  return `${lines.join("\n")}\n`;
}

function newBucket(userId: string | null, handle: string | null): Bucket {
  return {
    userId,
    handle,
    displayName: null,
    followers: null,
    statuses: null,
    protected: null,
    seeds: new Set(),
    interactions: { reply: 0, quote: 0, repost: 0, mention: 0 },
  };
}

function mergeInto(target: Bucket, source: Bucket): void {
  for (const seed of source.seeds) target.seeds.add(seed);
  for (const kind of Object.keys(source.interactions) as InteractionKind[]) target.interactions[kind] += source.interactions[kind];
  target.displayName ??= source.displayName;
  target.followers ??= source.followers;
  target.statuses ??= source.statuses;
  target.protected ??= source.protected;
}

function facets(row: Record<string, unknown>): Record<string, unknown>[] {
  const rawText = row.raw_text;
  if (!isRecord(rawText) || !Array.isArray(rawText.facets)) return [];
  return rawText.facets.filter(isRecord);
}

function total(candidate: DiscoveryCandidate): number {
  return Object.values(candidate.interactions).reduce((sum, value) => sum + value, 0);
}

function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lower(value: string | null): string | null {
  return value === null ? null : value.replace(/^@/, "").toLowerCase();
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

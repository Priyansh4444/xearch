// Pure provider -> ingress mapping (docs/COLLECTION.md §3–§5, docs/INGRESS.md).
// No filesystem, HTTP, or CLI access. A future Rust normalizer must reproduce
// exactly this behaviour; the golden fixtures under apps/collector/tests/fixtures
// are the executable contract.

import { Option } from "effect";
import * as Schema from "effect/Schema";
import {
  parseNonEmptyString,
  parseNonNegativeNumber,
} from "../contracts/primitives.ts";
import {
  parseProviderMediaType,
  toIngressMediaType,
} from "../contracts/media.ts";

export type CandidateOrigin = "timeline" | "embedded";

const ProviderVerificationSchema = Schema.Struct({
  verified: Schema.optional(Schema.Boolean),
});

const ProviderAuthorSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  screen_name: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  followers: Schema.optional(Schema.Number),
  following: Schema.optional(Schema.Number),
  statuses: Schema.optional(Schema.Number),
  joined: Schema.optional(Schema.Unknown),
  verification: Schema.optional(Schema.NullOr(ProviderVerificationSchema)),
  description: Schema.optional(Schema.String),
  avatar_url: Schema.optional(Schema.String),
  protected: Schema.optional(Schema.Boolean),
});

const ProviderMediaItemSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const ProviderMediaSchema = Schema.Struct({
  all: Schema.optional(Schema.NullOr(Schema.Array(ProviderMediaItemSchema))),
});

const ProviderFacetSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  original: Schema.optional(Schema.String),
  replacement: Schema.optional(Schema.String),
});

const ProviderStatusSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  created_timestamp: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.String),
  likes: Schema.optional(Schema.Number),
  reposts: Schema.optional(Schema.Number),
  quotes: Schema.optional(Schema.Number),
  replies: Schema.optional(Schema.Number),
  media: Schema.optional(Schema.NullOr(ProviderMediaSchema)),
  author: Schema.optional(Schema.NullOr(ProviderAuthorSchema)),
  quote: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  reposted_by: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  lang: Schema.optional(Schema.String),
  raw_text: Schema.optional(
    Schema.NullOr(Schema.Struct({ facets: Schema.optional(Schema.Array(ProviderFacetSchema)) })),
  ),
  replying_to: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        screen_name: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
      }),
    ),
  ),
  replying_to_status: Schema.optional(
    Schema.NullOr(
      Schema.Union([
        Schema.String,
        Schema.Array(Schema.Union([Schema.String, Schema.Struct({ id: Schema.optional(Schema.String) })])),
      ]),
    ),
  ),
});

export type ProviderStatus = Schema.Schema.Type<typeof ProviderStatusSchema>;
export type ProviderAuthor = Schema.Schema.Type<typeof ProviderAuthorSchema>;
export type ProviderFacet = Schema.Schema.Type<typeof ProviderFacetSchema>;

export function parseProviderStatus(value: unknown): ProviderStatus | null {
  const status = Schema.decodeUnknownOption(ProviderStatusSchema)(value);
  return Option.isSome(status) ? status.value : null;
}

export function parseProviderAuthor(value: unknown): ProviderAuthor | null {
  const author = Schema.decodeUnknownOption(ProviderAuthorSchema)(value);
  return Option.isSome(author) ? author.value : null;
}

export interface CandidateContext {
  /** Numeric id of the seed account whose timeline this page belongs to. */
  accountUserId: string;
  page: number;
  /** Run-relative path of the retained provider page, e.g. raw/123/000001.json. */
  rawFile: string;
  /** Epoch ms when the page arrived (from the page's .meta.json sidecar). */
  receivedAt: number;
  origin: CandidateOrigin;
  /** Index of the top-level result on its page (shared by embedded candidates). */
  index: number;
  /** Tweet id of the enclosing candidate for embedded candidates. */
  parentId: string | null;
}

export interface IngressMetrics {
  likes: number;
  retweets: number;
  quotes: number;
  replies: number;
}

export interface IngressMedia {
  type: "image" | "video" | "gif";
  url: string;
}

export interface IngressEntities {
  hashtags: string[];
  mentions: string[];
  urls: string[];
}

/** Field order here is the field order on disk; keep it stable. */
export interface IngressTweet {
  kind: "tweet";
  id: string;
  text: string;
  authorId: string;
  createdAt: number;
  metrics: IngressMetrics;
  metricsAt: number;
  media: IngressMedia[];
  quotedTweetId: string | null;
  retweetOfTweetId: null;
  inReplyToTweetId: string | null;
  lang?: string;
  entities?: IngressEntities;
}

export interface IngressAuthor {
  kind: "author";
  id: string;
  handle: string;
  displayName: string;
  followerCount: number;
  followingCount: number;
  verified: boolean;
  createdAt: number;
  bio?: string;
  avatarUrl?: string;
}

export const REJECTION_CODES = [
  "invalid_response_shape",
  "missing_tweet_id",
  "empty_text",
  "invalid_created_at",
  "missing_metric",
  "invalid_media",
  "missing_author",
  "missing_author_id",
  "missing_author_handle",
  "missing_author_display_name",
  "missing_author_counts",
  "missing_author_created_at",
  "missing_author_verification",
  "conflicting_tweet_text",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface Rejection {
  kind: "rejection";
  accountUserId: string;
  page: number;
  rawFile: string;
  index: number;
  origin: CandidateOrigin;
  parentId: string | null;
  candidateId: string | null;
  reasons: RejectionCode[];
}

export interface MappedTweet {
  ok: true;
  tweet: IngressTweet;
  author: IngressAuthor;
  context: CandidateContext;
  /** `author.id` equals the seed account id. */
  authoredByAccount: boolean;
  /** The timeline row was a repost (status.reposted_by present). */
  reposted: boolean;
  /** The quote target exists but is hidden (tombstone); its id is kept as a dangling edge. */
  quoteTombstone: boolean;
  embedded: MappedCandidate[];
}

export interface RejectedCandidate {
  ok: false;
  rejection: Rejection;
  embedded: MappedCandidate[];
}

export type MappedCandidate = MappedTweet | RejectedCandidate;

/** Map one provider status (timeline row or embedded quote) and everything nested in it. */
export function mapStatus(value: unknown, context: CandidateContext): MappedCandidate {
  const status = parseProviderStatus(value);
  if (status === null || status.type !== "status") {
    return reject(context, null, ["invalid_response_shape"], []);
  }
  return mapProviderStatus(status, context);
}

function mapProviderStatus(value: ProviderStatus, context: CandidateContext): MappedCandidate {
  const id = parseNonEmptyString(value.id);
  const reasons: RejectionCode[] = [];
  if (id === null) reasons.push("missing_tweet_id");

  const embedded = mapEmbedded(value, context, id);

  const text = typeof value.text === "string" ? value.text : "";
  if (text.trim().length === 0) reasons.push("empty_text");

  const createdAt = timestampMilliseconds(value.created_timestamp) ?? dateMilliseconds(value.created_at);
  if (createdAt === null) reasons.push("invalid_created_at");

  const metrics = mapMetrics(value);
  if (metrics === null) reasons.push("missing_metric");

  const media = mapMedia(value.media);
  if (media === null) reasons.push("invalid_media");

  const authorResult = mapAuthor(value.author);
  if (!authorResult.ok) reasons.push(...authorResult.reasons);

  if (reasons.length > 0 || id === null || createdAt === null || metrics === null || media === null || !authorResult.ok) {
    return reject(context, id, dedupe(reasons), embedded);
  }

  const quote = value.quote;
  const quotedTweetId = quote !== null && typeof quote === "object" && !Array.isArray(quote)
    ? parseNonEmptyString(quote["id"])
    : null;
  const quoteTombstone =
    quote !== null &&
    typeof quote === "object" &&
    !Array.isArray(quote) &&
    quote["type"] === "tombstone";
  const reposted = value.reposted_by !== undefined && value.reposted_by !== null;

  const tweet: IngressTweet = {
    kind: "tweet",
    id,
    text,
    authorId: authorResult.author.id,
    createdAt,
    metrics,
    metricsAt: context.receivedAt,
    media,
    quotedTweetId,
    retweetOfTweetId: null,
    inReplyToTweetId: mapInReplyTo(value),
  };
  const lang = parseNonEmptyString(value.lang);
  if (lang !== null) tweet.lang = lang;
  const entities = mapEntities(value.raw_text);
  if (entities !== null) tweet.entities = entities;

  return {
    ok: true,
    tweet,
    author: authorResult.author,
    context,
    authoredByAccount: authorResult.author.id === context.accountUserId,
    reposted,
    quoteTombstone,
    embedded,
  };
}

export type MappedAuthor = { ok: true; author: IngressAuthor } | { ok: false; reasons: RejectionCode[] };

/** Map an embedded provider author (status.author or profile user). */
export function mapAuthor(value: unknown): MappedAuthor {
  const authorData = parseProviderAuthor(value);
  if (authorData === null) return { ok: false, reasons: ["missing_author"] };
  const reasons: RejectionCode[] = [];

  const id = parseNonEmptyString(authorData.id);
  if (id === null) reasons.push("missing_author_id");
  const screenName = parseNonEmptyString(authorData.screen_name);
  if (screenName === null) reasons.push("missing_author_handle");
  const displayName = parseNonEmptyString(authorData.name);
  if (displayName === null) reasons.push("missing_author_display_name");
  const followerCount = parseNonNegativeNumber(authorData.followers);
  const followingCount = parseNonNegativeNumber(authorData.following);
  if (followerCount === null || followingCount === null) {
    reasons.push("missing_author_counts");
  }
  const createdAt = dateMilliseconds(authorData.joined);
  if (createdAt === null) reasons.push("missing_author_created_at");
  const verified = authorData.verification?.verified ?? null;
  if (verified === null) reasons.push("missing_author_verification");

  if (
    reasons.length > 0 ||
    id === null ||
    screenName === null ||
    displayName === null ||
    createdAt === null ||
    verified === null ||
    followerCount === null ||
    followingCount === null
  ) {
    return { ok: false, reasons };
  }

  const author: IngressAuthor = {
    kind: "author",
    id,
    handle: screenName.replace(/^@/, "").toLowerCase(),
    displayName,
    followerCount,
    followingCount,
    verified,
    createdAt,
  };
  const bio = parseNonEmptyString(authorData.description);
  if (bio !== null) author.bio = bio;
  const avatarUrl = parseNonEmptyString(authorData.avatar_url);
  if (avatarUrl !== null) author.avatarUrl = avatarUrl;
  return { ok: true, author };
}

function mapEmbedded(status: ProviderStatus, context: CandidateContext, parentId: string | null): MappedCandidate[] {
  const quote = status.quote;
  const quotedStatus = parseProviderStatus(quote);
  if (quotedStatus === null || quotedStatus.type !== "status") return [];
  return [
    mapProviderStatus(quotedStatus, {
      ...context,
      origin: "embedded",
      parentId: parentId ?? `${context.rawFile}#${context.index}`,
    }),
  ];
}

function mapMetrics(status: ProviderStatus): IngressMetrics | null {
  const likes = status.likes;
  const reposts = status.reposts;
  const quotes = status.quotes;
  const replies = status.replies;
  const likeCount = parseNonNegativeNumber(likes);
  const repostCount = parseNonNegativeNumber(reposts);
  const quoteCount = parseNonNegativeNumber(quotes);
  const replyCount = parseNonNegativeNumber(replies);
  if (likeCount === null || repostCount === null || quoteCount === null || replyCount === null) {
    return null;
  }
  return { likes: likeCount, retweets: repostCount, quotes: quoteCount, replies: replyCount };
}

function mapMedia(value: ProviderStatus["media"]): IngressMedia[] | null {
  if (value === undefined || value === null || value.all === undefined || value.all === null) return [];

  const out: IngressMedia[] = [];
  const seen = new Set<string>();
  for (const item of value.all) {
    const url = parseNonEmptyString(item.url);
    if (url === null) return null;
    const providerType = parseProviderMediaType(item.type);
    if (providerType === null) return null;
    const type = toIngressMediaType(providerType);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ type, url });
  }
  return out;
}

function mapInReplyTo(status: ProviderStatus): string | null {
  if (status.replying_to !== undefined && status.replying_to !== null) {
    const parent = parseNonEmptyString(status.replying_to.status);
    if (parent !== null) return parent;
  }
  if (Array.isArray(status.replying_to_status)) {
    const first = status.replying_to_status[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      return parseNonEmptyString(first.id);
    }
    return parseNonEmptyString(first);
  }
  return parseNonEmptyString(status.replying_to_status);
}

function mapEntities(rawText: ProviderStatus["raw_text"]): IngressEntities | null {
  if (rawText === undefined || rawText === null || rawText.facets === undefined) return null;
  const hashtags: string[] = [];
  const mentions: string[] = [];
  const urls: string[] = [];
  for (const facet of rawText.facets) {
    if (facet.type === "hashtag") pushUnique(hashtags, parseNonEmptyString(facet.original)?.replace(/^#/, ""));
    else if (facet.type === "mention") pushUnique(mentions, parseNonEmptyString(facet.original)?.replace(/^@/, ""));
    else if (facet.type === "url") pushUnique(urls, parseNonEmptyString(facet.replacement) ?? parseNonEmptyString(facet.original));
  }
  return { hashtags, mentions, urls };
}

function reject(
  context: CandidateContext,
  candidateId: string | null,
  reasons: RejectionCode[],
  embedded: MappedCandidate[],
): RejectedCandidate {
  return {
    ok: false,
    rejection: {
      kind: "rejection",
      accountUserId: context.accountUserId,
      page: context.page,
      rawFile: context.rawFile,
      index: context.index,
      origin: context.origin,
      parentId: context.parentId,
      candidateId,
      reasons,
    },
    embedded,
  };
}

function pushUnique(list: string[], value: string | null | undefined): void {
  if (value === null || value === undefined || value.length === 0) return;
  if (!list.includes(value)) list.push(value);
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function timestampMilliseconds(value: unknown): number | null {
  const timestamp = parseNonNegativeNumber(value);
  if (timestamp === null || timestamp === 0) return null;
  return timestamp >= 1_000_000_000_000 ? Math.round(timestamp) : Math.round(timestamp * 1_000);
}

export function dateMilliseconds(value: unknown): number | null {
  const date = parseNonEmptyString(value);
  if (date === null) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

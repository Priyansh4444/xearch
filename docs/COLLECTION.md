# Collection sources: exact mappings and fallbacks

`docs/INGRESS.md` owns the JSONL contract. This document owns how the collector
gets the public data needed to satisfy it.

The collector calls providers directly. It does not depend on `x-md`.

## 1. Decision

1. FxTwitter is the primary source for posts, profiles, timelines, search, metrics,
   relationships, and media.
2. X syndication is a partial fallback. It can recover a post, but it cannot fill
   every required metric or author field.
3. Firecrawl is a last-resort text recovery path for X URLs. It never supplies
   missing counts, ids, relationships, or media by inference.
4. Repost wrappers are not ingested. We ingest the original post once, use its
   repost count, and leave `retweetOfTweetId` null.
5. Missing data stays missing. The collector never turns an unavailable count into
   zero just to pass validation.

This is a hackathon collector: small, focused, and best-effort. It still writes
checkpointed JSONL so interrupted runs can resume without duplicating data.

## 2. Tested sources

Tests ran on 2026-08-31 from the development machine. Latency is one observed
round trip, not an SLA.

| Source | Request | Result | Latency |
|---|---|---|---:|
| FxTwitter | `GET /2/status/1546621144358391808` | Full image post, author, metrics, and media | 339 ms |
| FxTwitter | `GET /2/status/1546648714311131136` | Full reply and parent post id | 262 ms |
| FxTwitter | `GET /2/status/2094133014330565026` | Full quote and quoted post id | 319 ms |
| FxTwitter | `GET /2/status/2094033367767339277` | Direct video URL and variants | 264 ms |
| FxTwitter | `GET /2/profile/NASA` | Numeric id, counts, joined date, and verification | 270 ms |
| FxTwitter | `GET /2/profile/NASA/statuses?count=20&with_replies=true` | Timeline with originals, replies, quotes, and repost context | 1.29 s |
| FxTwitter | `GET /2/search?q=gif&feed=media&count=20` | GIF results with direct media data | 2.12 s |
| X syndication | `GET /tweet-result?id=1546621144358391808&lang=en&token=0` | Text, ids, time, likes, replies, language, and image | 274 ms |
| X syndication | `GET /tweet-result?id=1546648714311131136&lang=en&token=0` | Reply parent id recovered | 265 ms |
| Firecrawl | Public X post/profile scrape | Text was usable; structured data was incomplete | 6–10 s |
| Firecrawl | External NASA page | 45–53k characters of noisy Markdown | 1.48–1.51 s |

FxTwitter endpoints use `https://api.fxtwitter.com`. The syndication endpoint uses
`https://cdn.syndication.twimg.com`. Neither requires collector credentials.

## 3. Tweet mapping

| Ingress / Convex field | FxTwitter source | Rule |
|---|---|---|
| `id` / `tweetId` | `status.id` | Keep as a string. This is the dedupe key. |
| `authorId` | `status.author.id` | Keep the numeric id as a string. |
| `authorHandle` | `status.author.screen_name` | Lowercase and remove a leading `@`. |
| `text` | `status.text` | Use the resolved display text, not `raw_text.text`, which may contain encoded entities and `t.co` links. |
| `createdAt` | `status.created_timestamp` | Multiply Unix seconds by 1,000. Parse `created_at` only as a fallback. |
| `metrics.likes` / `likeCount` | `status.likes` | Required. |
| `metrics.retweets` / `retweetCount` | `status.reposts` | Required. FxTwitter calls reposts `reposts`. |
| `metrics.replies` / `replyCount` | `status.replies` | Required. |
| `metrics.quotes` / `quoteCount` | `status.quotes` | Required. |
| `metricsAt` | Collector clock | Set immediately after the response arrives. |
| `quotedTweetId` | `status.quote.id` | Null when there is no quote. Keep dangling target ids. |
| `retweetOfTweetId` | — | Always null under the repost policy in §5. |
| `inReplyToTweetId` | `status.replying_to.status` | Fall back to the first `replying_to_status` entry if present. |
| `lang` | `status.lang` | Omit only when the provider omits it. |
| `media[].type` / `mediaType` | `status.media.all[].type` | Map `photo` → `image`, `video` → `video`, `gif` → `gif`. No items → `none`. |
| `media[].url` / `mediaUrls` | `status.media.all[].url` | Deduplicate. Keep one primary URL per item, not every video bitrate. |
| `entities.hashtags` | `status.raw_text.facets[type=hashtag]` | Store the original tag without `#`. Derive from text if facets are absent. |
| `entities.mentions` | `status.raw_text.facets[type=mention]` | Store the original handle without `@`. |
| `entities.urls` | `status.raw_text.facets[type=url].replacement` | Prefer the expanded replacement over the `t.co` original. |
| `hasLink` | URL facets, then local tokenizer | Media-only facets do not count as external links. |

For the schema's single `mediaType`, use this precedence if a provider ever returns
mixed items: `video`, then `gif`, then `image`, then `none`.

Direct media URLs are upstream CDN URLs. They may change or expire. A failed media
fetch does not invalidate the tweet record; it only skips that media embedding.

## 4. Author mapping

The author embedded in a FxTwitter post is sufficient for normal ingestion. Use
`GET /2/profile/{handle}` when discovering an author without a post or refreshing
profile counts.

| Ingress / Convex field | FxTwitter source | Rule |
|---|---|---|
| `id` / `authorId` | `author.id` | Keep as a string. |
| `handle` | `author.screen_name` | Lowercase and remove a leading `@`. |
| `displayName` | `author.name` | Preserve Unicode. |
| `followerCount` | `author.followers` | Snapshot value. |
| `followingCount` | `author.following` | Snapshot value. |
| `verified` | `author.verification.verified` | Store the boolean. The current schema does not retain verification type. |
| `createdAt` | `author.joined` | Parse to epoch milliseconds. This is required by ingress but is not stored in Convex. |
| `bio` | `author.description` | Optional ingress enrichment. |
| `avatarUrl` | `author.avatar_url` | Optional ingress enrichment. |
| `nameTokens` | Local tokenizer | Never take tokenization from a provider. |
| `authority` | Local indexer | Initialize from follower count, then refresh from the collected graph. |
| `isStub` | Collector/indexer state | False for a real author object; true only for a synthesized orphan. |

Follower and following counts can move between two requests. That is expected.
Their collection time is the enclosing ingest run's timestamp.

## 5. Repost policy

FxTwitter represents a reposted timeline item as:

```text
originalTweetId = status.id
reposterAuthorId = status.reposted_by.id
```

It does not expose a separate repost event id or repost timestamp. A synthetic
tweet row would need both, so we do not create one.

When `status.reposted_by` is present:

1. Normalize and ingest `status` as its original author's tweet, deduped by
   `status.id`.
2. Do not emit a second tweet for the reposter.
3. Set the required ingress key `retweetOfTweetId` to null.
4. Use `status.reposts` as the original tweet's `retweetCount`.

The accepted loss is per-reposter graph edges. Quote, reply, and mention edges still
feed authority and boost propagation. If repost edges later prove useful, add a
separate relation table keyed by `(originalTweetId, reposterAuthorId)` instead of
inventing tweet rows.

## 6. Fallback rules

### X syndication

Syndication can recover:

- post id, numeric author id, handle, display name, and text
- creation time, likes, replies, language, and reply parent id
- photo/video metadata on supported posts
- some quote data

It did not provide every required field in testing, notably repost count, quote
count, follower count, and following count. A syndication response therefore goes
to staging unless another source fills the missing fields. It does not become a
complete JSONL record by replacing unknown values with zero.

### Firecrawl

Firecrawl recovered readable X text, but it missed or misidentified numeric author
ids, reply and quote counts, relationships, and media. It is the final text-only
recovery path:

1. Record the URL, recovered text, provider, collection time, and error that led to
   the fallback.
2. Keep the result in staging.
3. Retry the structured source later.
4. Never infer required fields from surrounding comments or page links.

Firecrawl's better use is fetching external pages linked by tweets. The tested NASA
page returned useful content in about 1.5 seconds for one credit, but also tens of
thousands of characters of navigation. External-page text needs cleanup and belongs
in a separate enrichment path, not the tweet ingress record.

## 7. Collector boundary

The collector writes source data and collection metadata. It does not calculate:

- tokens, term frequencies, postings, or document frequencies
- static scores, score buckets, propagated boosts, or authority
- text or media embeddings
- query cache, feedback, answers, or config metadata

Those remain owned by the indexer and Convex functions. Provider responses should
be retained in raw staging files so a mapping bug can be fixed without fetching the
same post again.

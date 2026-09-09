// Branded domain identities — type-only (Grok's "branded domain IDs" item).
// Convex validators stay `v.string()` and the stored JSON is untouched, so there
// is no schema migration and no change to canonical XQuery JSON or index reads.
// The brands exist so the four string spaces can never be silently swapped:
//
// - TweetId: source tweet id (`tweets.tweetId`, the ingest idempotency key).
//   NOT a Convex doc id: `postings.tweetId` and `Candidate.tweetId` hold doc
//   `_id`s and stay plain `string` on purpose — see the notes there.
// - AuthorId: source author id (`tweets/postings/authors.authorId`).
// - Term: tokenizer-normalized index term (or `~aspect` token).
// - QueryKey: FNV-1a hex over canonical XQuery JSON.
// - Handle: normalized author handle (lowercase, no `@`).
//
// DB rows arrive as plain strings; assert the space once at the read boundary
// with `as AuthorId` / `as Term` / …, never deep inside logic.

export type TweetId = string & { readonly __brand: "TweetId" };
export type AuthorId = string & { readonly __brand: "AuthorId" };
export type Term = string & { readonly __brand: "Term" };
export type QueryKey = string & { readonly __brand: "QueryKey" };
export type Handle = string & { readonly __brand: "Handle" };

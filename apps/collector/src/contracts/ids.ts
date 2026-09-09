// Branded domain identities: a tweet id, author id, handle, term, or query key
// must never silently swap places with another. Each brand is a distinct type
// but erases to a plain string at runtime, so ingress JSON on disk, the Convex
// validators (v.string), and the Rust indexer are all untouched.

import { Option } from "effect";
import * as Schema from "effect/Schema";
import { NonEmptyStringSchema } from "./primitives.ts";

export const TweetIdSchema = NonEmptyStringSchema.pipe(Schema.brand("TweetId"));
export type TweetId = Schema.Schema.Type<typeof TweetIdSchema>;

export const AuthorIdSchema = NonEmptyStringSchema.pipe(Schema.brand("AuthorId"));
export type AuthorId = Schema.Schema.Type<typeof AuthorIdSchema>;

/** Normalized handle: lowercase, no leading `@` (see `normalizeHandle`). */
export const HandleSchema = NonEmptyStringSchema.pipe(Schema.brand("Handle"));
export type Handle = Schema.Schema.Type<typeof HandleSchema>;

/** Tokenizer-normalized index term (or `~aspect` token). */
export const TermSchema = NonEmptyStringSchema.pipe(Schema.brand("Term"));
export type Term = Schema.Schema.Type<typeof TermSchema>;

/** FNV-1a hex over canonical XQuery JSON (engine/xquery.ts `queryKey`). */
export const QueryKeySchema = NonEmptyStringSchema.pipe(Schema.brand("QueryKey"));
export type QueryKey = Schema.Schema.Type<typeof QueryKeySchema>;

// Parse fns share `parseNonEmptyString` semantics exactly (reject blank as well
// as empty), so swapping them in at provider boundaries changes no behavior —
// only the brand on the accepted value.
export function parseTweetId(value: unknown): TweetId | null {
  const parsed = Schema.decodeUnknownOption(TweetIdSchema)(value);
  if (Option.isNone(parsed) || parsed.value.trim().length === 0) return null;
  return parsed.value;
}

export function parseAuthorId(value: unknown): AuthorId | null {
  const parsed = Schema.decodeUnknownOption(AuthorIdSchema)(value);
  if (Option.isNone(parsed) || parsed.value.trim().length === 0) return null;
  return parsed.value;
}

export function parseHandle(value: unknown): Handle | null {
  const parsed = Schema.decodeUnknownOption(HandleSchema)(value);
  if (Option.isNone(parsed) || parsed.value.trim().length === 0) return null;
  return parsed.value;
}

export function parseTerm(value: unknown): Term | null {
  const parsed = Schema.decodeUnknownOption(TermSchema)(value);
  if (Option.isNone(parsed) || parsed.value.trim().length === 0) return null;
  return parsed.value;
}

export function parseQueryKey(value: unknown): QueryKey | null {
  const parsed = Schema.decodeUnknownOption(QueryKeySchema)(value);
  if (Option.isNone(parsed) || parsed.value.trim().length === 0) return null;
  return parsed.value;
}

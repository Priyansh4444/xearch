import { Option } from "effect";
import * as Schema from "effect/Schema";

/** FxTwitter timeline/quote row kinds the collector understands. */
export const ProviderStatusType = {
  Status: "status",
  Tombstone: "tombstone",
} as const;
export type ProviderStatusType = (typeof ProviderStatusType)[keyof typeof ProviderStatusType];
export const ProviderStatusTypeSchema = Schema.Literals([
  ProviderStatusType.Status,
  ProviderStatusType.Tombstone,
]);

/** FxTwitter text facet kinds used by normalization and discovery. */
export const ProviderFacetType = {
  Hashtag: "hashtag",
  Mention: "mention",
  Url: "url",
} as const;
export type ProviderFacetType = (typeof ProviderFacetType)[keyof typeof ProviderFacetType];
export const ProviderFacetTypeSchema = Schema.Literals([
  ProviderFacetType.Hashtag,
  ProviderFacetType.Mention,
  ProviderFacetType.Url,
]);

export function parseProviderStatusType(value: unknown): ProviderStatusType | null {
  const parsed = Schema.decodeUnknownOption(ProviderStatusTypeSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function parseProviderFacetType(value: unknown): ProviderFacetType | null {
  const parsed = Schema.decodeUnknownOption(ProviderFacetTypeSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function isStatusRow(type: unknown): boolean {
  return parseProviderStatusType(type) === ProviderStatusType.Status;
}

export function isTombstoneRow(type: unknown): boolean {
  return parseProviderStatusType(type) === ProviderStatusType.Tombstone;
}

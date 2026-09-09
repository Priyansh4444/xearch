import { Option } from "effect";
import * as Schema from "effect/Schema";

/** Where a mapped candidate came from in the provider page. */
export const CandidateOrigin = {
  Timeline: "timeline",
  Embedded: "embedded",
} as const;
export type CandidateOrigin = (typeof CandidateOrigin)[keyof typeof CandidateOrigin];
export const CandidateOriginSchema = Schema.Literals([
  CandidateOrigin.Timeline,
  CandidateOrigin.Embedded,
]);

/** Why an otherwise-valid tweet was skipped during normalization. */
export const SkipReason = {
  OutsideHistoryWindow: "outside_history_window",
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];
export const SkipReasonSchema = Schema.Literals([SkipReason.OutsideHistoryWindow]);

/** Gate-2 interaction evidence kinds. */
export const InteractionKind = {
  Reply: "reply",
  Quote: "quote",
  Repost: "repost",
  Mention: "mention",
} as const;
export type InteractionKind = (typeof InteractionKind)[keyof typeof InteractionKind];
export const InteractionKindSchema = Schema.Literals([
  InteractionKind.Reply,
  InteractionKind.Quote,
  InteractionKind.Repost,
  InteractionKind.Mention,
]);

export function parseCandidateOrigin(value: unknown): CandidateOrigin | null {
  const parsed = Schema.decodeUnknownOption(CandidateOriginSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

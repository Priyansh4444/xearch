import { Option } from "effect";
import * as Schema from "effect/Schema";

/** Runtime contract for values that may safely be treated as finite numbers. */
export const FiniteNumberSchema = Schema.Finite;

/** Runtime contract for counters and timestamps that cannot be negative. */
export const NonNegativeNumberSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Runtime contract for strings that contain at least one character. */
export const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1));

export function parseFiniteNumber(value: unknown): number | null {
  const parsed = Schema.decodeUnknownOption(FiniteNumberSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function parseNonNegativeNumber(value: unknown): number | null {
  const parsed = Schema.decodeUnknownOption(NonNegativeNumberSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function parseNonEmptyString(value: unknown): string | null {
  const parsed = Schema.decodeUnknownOption(NonEmptyStringSchema)(value);
  if (Option.isNone(parsed) || parsed.value.trim().length === 0) return null;
  return parsed.value;
}

export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/^@/, "").toLowerCase();
}

export function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

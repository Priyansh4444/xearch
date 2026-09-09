import { Option } from "effect";
import * as Schema from "effect/Schema";

/** Per-account acquisition lifecycle (checkpoint + manifest). */
export const AccountState = {
  Pending: "pending",
  Active: "active",
  Paused: "paused",
  Completed: "completed",
  Abandoned: "abandoned",
} as const;
export type AccountState = (typeof AccountState)[keyof typeof AccountState];
export const AccountStateSchema = Schema.Literals([
  AccountState.Pending,
  AccountState.Active,
  AccountState.Paused,
  AccountState.Completed,
  AccountState.Abandoned,
]);

/** Successful stop reasons for a finished account. */
export const StopReason = {
  HistoryCutoff: "history_cutoff",
  CursorExhausted: "cursor_exhausted",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];
export const StopReasonSchema = Schema.Literals([
  StopReason.HistoryCutoff,
  StopReason.CursorExhausted,
]);

/** Why an account paused instead of completing. */
export const PauseReason = {
  CursorStalled: "cursor_stalled",
  ProviderError: "provider_error",
  InvalidResponse: "invalid_response",
  IdentityMismatch: "identity_mismatch",
  ProfileNotFound: "profile_not_found",
  ProfileProtected: "profile_protected",
} as const;
export type PauseReason = (typeof PauseReason)[keyof typeof PauseReason];
export const PauseReasonSchema = Schema.Literals([
  PauseReason.CursorStalled,
  PauseReason.ProviderError,
  PauseReason.InvalidResponse,
  PauseReason.IdentityMismatch,
  PauseReason.ProfileNotFound,
  PauseReason.ProfileProtected,
]);

/** Aggregate acquisition status projected from account states. */
export const AcquisitionStatus = {
  InProgress: "in_progress",
  Completed: "completed",
  Partial: "partial",
  Abandoned: "abandoned",
  Failed: "failed",
} as const;
export type AcquisitionStatus = (typeof AcquisitionStatus)[keyof typeof AcquisitionStatus];
export const AcquisitionStatusSchema = Schema.Literals([
  AcquisitionStatus.InProgress,
  AcquisitionStatus.Completed,
  AcquisitionStatus.Partial,
  AcquisitionStatus.Abandoned,
  AcquisitionStatus.Failed,
]);

/** Gate-2 discovery resolution for a candidate account. */
export const DiscoveryResolution = {
  Embedded: "embedded",
  Resolved: "resolved",
  Unresolved: "unresolved",
  NotFound: "not_found",
  Mismatch: "mismatch",
} as const;
export type DiscoveryResolution = (typeof DiscoveryResolution)[keyof typeof DiscoveryResolution];
export const DiscoveryResolutionSchema = Schema.Literals([
  DiscoveryResolution.Embedded,
  DiscoveryResolution.Resolved,
  DiscoveryResolution.Unresolved,
  DiscoveryResolution.NotFound,
  DiscoveryResolution.Mismatch,
]);

/** Page fetch loop control inside acquisition. */
export const PageOutcome = {
  Continue: "continue",
  Stop: "stop",
} as const;
export type PageOutcome = (typeof PageOutcome)[keyof typeof PageOutcome];
export const PageOutcomeSchema = Schema.Literals([PageOutcome.Continue, PageOutcome.Stop]);

export function parseAccountState(value: unknown): AccountState | null {
  const parsed = Schema.decodeUnknownOption(AccountStateSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function parsePauseReason(value: unknown): PauseReason | null {
  const parsed = Schema.decodeUnknownOption(PauseReasonSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function parseDiscoveryResolution(value: unknown): DiscoveryResolution | null {
  const parsed = Schema.decodeUnknownOption(DiscoveryResolutionSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function isOpenAccountState(state: AccountState): boolean {
  return (
    state === AccountState.Pending || state === AccountState.Active || state === AccountState.Paused
  );
}

export function isFinishedAccountState(state: AccountState): boolean {
  return state === AccountState.Completed || state === AccountState.Abandoned;
}

export function needsIdentityResolution(pauseReason: PauseReason | null): boolean {
  return (
    pauseReason === PauseReason.IdentityMismatch ||
    pauseReason === PauseReason.ProfileNotFound ||
    pauseReason === PauseReason.ProfileProtected
  );
}

export function isAdmissibleDiscoveryResolution(resolution: DiscoveryResolution): boolean {
  return resolution === DiscoveryResolution.Embedded || resolution === DiscoveryResolution.Resolved;
}

export function isNormalizableAcquisitionStatus(status: AcquisitionStatus): boolean {
  return status === AcquisitionStatus.Completed || status === AcquisitionStatus.Partial;
}

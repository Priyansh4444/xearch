//! Lossless-enough integer → f64 helpers without `as` casts (`as_conversions` is denied).

/// Split a `u64` into high/low `u32` halves and recombine as `f64`.
#[must_use]
pub fn u64_as_f64(value: u64) -> f64 {
    let high = u32::try_from(value >> 32).unwrap_or(u32::MAX);
    let low = u32::try_from(value & u64::from(u32::MAX)).unwrap_or(0);
    f64::from(high).mul_add(4_294_967_296.0, f64::from(low))
}

/// Convert `usize` via `u64` (saturating at `u64::MAX` on wider platforms).
#[must_use]
pub fn usize_as_f64(value: usize) -> f64 {
    u64_as_f64(u64::try_from(value).unwrap_or(u64::MAX))
}

/// Convert an `f64` count from the API into a `usize` for bounded slicing.
///
/// Truncates toward zero, clamps non-finite and negative values to 0, and
/// saturates at `usize::MAX` (float→int casts saturate since Rust 1.45).
#[must_use]
#[allow(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn f64_as_usize(value: f64) -> usize {
    if !value.is_finite() || value <= 0.0 {
        0
    } else {
        usize::try_from(value.trunc() as u64).unwrap_or(usize::MAX)
    }
}

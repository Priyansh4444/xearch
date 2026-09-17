//! Thin Convex HTTP client. Retry/backoff lives HERE so the pipeline stays pure.
//!
//! Contract: POST {deployment}/api/mutation with { path, args, format: "json" },
//! auth via `CONVEX_DEPLOY_KEY`. Batches are atomic server-side; safe to retry
//! wholesale (idempotent on tweetId — RISKS O1).

use crate::model::IngestBatch;
use color_eyre::eyre::{bail, eyre, Context, Result};

const BACKOFF_BASE_MS: u64 = 200;
const BACKOFF_CAP_MS: u64 = 30_000;
const MAX_ATTEMPTS: u32 = 8;
/// Deferred df deltas per follow-up call; matches the server's per-call cap.
const MAX_DF_DELTAS_PER_CALL: usize = 1500;

pub struct ConvexClient {
    pub deployment_url: String, // e.g. https://something.convex.cloud
    pub deploy_key: String,
    client: reqwest::blocking::Client,
}

impl ConvexClient {
    /// # Errors
    ///
    /// Returns an error when either required environment variable is missing.
    pub fn from_env() -> Result<Self> {
        let deployment_url = std::env::var("CONVEX_URL").map_err(|_| {
            eyre!("CONVEX_URL is not set (the deployment URL, e.g. http://127.0.0.1:3210 or https://<name>.convex.cloud; `npx convex dev` writes it to .env.local)")
        })?;
        let deploy_key = std::env::var("CONVEX_DEPLOY_KEY").map_err(|_| {
            eyre!("CONVEX_DEPLOY_KEY is not set (a deploy/admin key for the deployment; internal mutations require admin auth)")
        })?;
        Ok(Self {
            deployment_url: deployment_url.trim_end_matches('/').to_string(),
            deploy_key,
            client: reqwest::blocking::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .context("build Convex HTTP client")?,
        })
    }

    /// Sends internal.ingest.ingestBatch. Retries on 5xx/OCC-conflict responses
    /// with jittered exponential backoff (base 200ms, cap 30s, max 8 attempts);
    /// gives up -> Err so main.rs can quarantine the batch WITHOUT checkpointing
    /// past it (never drop silently — O1/failure policy).
    ///
    /// # Errors
    ///
    /// Returns an error when serialization fails, Convex rejects the mutation,
    /// or all retry attempts fail.
    pub fn ingest_batch(&self, batch: &IngestBatch) -> Result<IngestAck> {
        self.ingest_batch_json(&serde_json::to_value(batch)?)
    }

    /// Upload a previously serialized `IngestBatch` (offline prepare files).
    ///
    /// # Errors
    ///
    /// Returns an error when Convex rejects the mutation or the ack is malformed.
    pub fn ingest_batch_json(&self, args: &serde_json::Value) -> Result<IngestAck> {
        let value = self.mutation("ingest:ingestBatch", args)?;
        let ack: IngestAck = serde_json::from_value(value).context("ingestBatch ack shape")?;
        // Batches with a few very long tweets blow past Convex's per-call read
        // limit inside ingestBatch's df maintenance; finish the deferred deltas
        // in bounded follow-up calls.
        let mut pending = ack.df_remainder.clone();
        while !pending.is_empty() {
            let take = pending.len().min(MAX_DF_DELTAS_PER_CALL);
            let batch: Vec<DfDeltaAck> = pending.drain(..take).collect();
            let reply = self.mutation(
                "ingest:applyDfDeltas",
                &serde_json::json!({ "deltas": batch }),
            )?;
            if reply
                .get("applied")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
                == 0
            {
                bail!(
                    "applyDfDeltas made no progress on {} deferred deltas",
                    batch.len()
                );
            }
        }
        Ok(ack)
    }

    /// # Errors
    ///
    /// Returns an error when Convex rejects the mutation, all retries fail, or
    /// the ack is malformed. A short `processed` is not an error: it means the
    /// posting budget stopped the mutation and the caller re-sends the rest.
    pub fn apply_metrics(&self, updates_json: &serde_json::Value) -> Result<ApplyAck> {
        let value = self.mutation("ingest:applyMetrics", updates_json)?;
        serde_json::from_value(value).context("applyMetrics ack shape")
    }

    /// # Errors
    ///
    /// Returns an error when Convex rejects the mutation or all retries fail.
    pub fn upsert_authority(&self, rows_json: &serde_json::Value) -> Result<()> {
        self.mutation("ingest:upsertAuthority", rows_json)?;
        Ok(())
    }

    /// POST {deployment}/api/mutation. Batches are atomic server-side and
    /// idempotent on tweetId, so wholesale retry is always safe.
    ///
    /// # Errors
    ///
    /// Returns an error when the response cannot be decoded or the retry budget
    /// is exhausted.
    fn mutation(&self, path: &str, args: &serde_json::Value) -> Result<serde_json::Value> {
        let url = format!("{}/api/mutation", self.deployment_url);
        let body = serde_json::json!({ "path": path, "args": args, "format": "json" });
        let mut last_error = String::new();
        for attempt in 0..MAX_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms(attempt)));
            }
            let response = self
                .client
                .post(&url)
                .header(
                    reqwest::header::AUTHORIZATION,
                    format!("Convex {}", self.deploy_key),
                )
                .json(&body)
                .send();
            match response {
                Ok(resp) => {
                    let code = resp.status();
                    if code.is_server_error() {
                        last_error = format!("HTTP {code}: {}", resp.text().unwrap_or_default());
                        continue;
                    }
                    if !code.is_success() {
                        bail!(
                            "convex mutation {path} rejected (HTTP {code}): {}",
                            resp.text().unwrap_or_default()
                        );
                    }
                    let reply: serde_json::Value =
                        resp.json().context("convex reply is not JSON")?;
                    match reply.get("status").and_then(serde_json::Value::as_str) {
                        Some("success") => {
                            return reply
                                .get("value")
                                .cloned()
                                .ok_or_else(|| eyre!("successful Convex reply has no value"))
                        }
                        Some(status) if is_occ_conflict(&reply) => {
                            last_error = format!("Convex OCC conflict: {status}: {reply}");
                        }
                        _ => {
                            // Function-level errors (validator rejection, JS throw)
                            // are not transient: fail immediately, loudly.
                            bail!("convex mutation {path} failed: {reply}");
                        }
                    }
                }
                Err(e) => last_error = format!("transport: {e}"), // connection refused etc.
            }
        }
        bail!(
            "convex mutation {path} failed after {MAX_ATTEMPTS} attempts; last error: {last_error}"
        )
    }
}

fn is_occ_conflict(reply: &serde_json::Value) -> bool {
    let text = reply.to_string().to_ascii_lowercase();
    text.contains("optimistic concurrency")
        || text.contains("occ conflict")
        || text.contains("write conflict")
}

/// Exponential backoff with deterministic-enough jitter (nanosecond clock — no
/// rand dependency for one sleep).
fn backoff_ms(attempt: u32) -> u64 {
    let multiplier = 1_u64.checked_shl(attempt.min(10)).unwrap_or(1_u64 << 10);
    let base = BACKOFF_BASE_MS
        .saturating_mul(multiplier)
        .min(BACKOFF_CAP_MS);
    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos())))
    .checked_rem(base.saturating_div(2).saturating_add(1))
    .unwrap_or(0);
    base.saturating_div(2)
        .saturating_add(jitter)
        .min(BACKOFF_CAP_MS)
}

/// Convex's JSON export format renders all numbers as f64; keep the fields f64
/// and treat them as counts.
#[derive(Debug, serde::Deserialize)]
pub struct IngestAck {
    pub inserted: f64,
    pub updated: f64,
    pub skipped: f64,
    /// df deltas the server deferred; drained via `ingest:applyDfDeltas`.
    #[serde(default)]
    pub df_remainder: Vec<DfDeltaAck>,
}

/// One deferred df delta, mirroring convex/ingest.ts's `dfRemainder` shape.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct DfDeltaAck {
    pub term: String,
    pub delta: i64,
}

/// Ack for `ingest:applyMetrics`.
///
/// `processed` is how many updates from the front of the sent slice landed; a
/// short value means the posting budget stopped the mutation and the caller
/// must re-send from that index.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct ApplyAck {
    pub patched: f64,
    pub processed: f64,
}

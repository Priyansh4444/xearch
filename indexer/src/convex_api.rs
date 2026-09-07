//! Thin Convex HTTP client. Retry/backoff lives HERE so the pipeline stays pure.
//! Contract: POST {deployment}/api/mutation with { path, args, format: "json" },
//! auth via CONVEX_DEPLOY_KEY. Batches are atomic server-side; safe to retry
//! wholesale (idempotent on tweetId — RISKS O1).

use crate::model::IngestBatch;
use anyhow::Result;

pub struct ConvexClient {
    pub deployment_url: String, // e.g. https://something.convex.cloud
    pub deploy_key: String,
}

impl ConvexClient {
    pub fn from_env() -> Result<Self> {
        // CONVEX_URL + CONVEX_DEPLOY_KEY; fail fast with a helpful message.
        todo!("from_env")
    }

    /// Sends internal.ingest.ingestBatch. Retries on 5xx/OCC-conflict responses
    /// with jittered exponential backoff (base 200ms, cap 30s, max 8 attempts);
    /// gives up -> Err so main.rs can quarantine the batch WITHOUT checkpointing
    /// past it (never drop silently — O1/failure policy).
    pub fn ingest_batch(&self, batch: &IngestBatch) -> Result<IngestAck> {
        let _ = batch;
        todo!("ingest_batch")
    }

    pub fn apply_metrics(&self, updates_json: &serde_json::Value) -> Result<()> {
        let _ = updates_json;
        todo!("apply_metrics")
    }

    pub fn upsert_authority(&self, rows_json: &serde_json::Value) -> Result<()> {
        let _ = rows_json;
        todo!("upsert_authority")
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct IngestAck {
    pub inserted: u64,
    pub updated: u64,
    pub skipped: u64,
}

//! Wire types. Serde IS the ingress validator (docs/INGRESS.md): a line that fails
//! to deserialize is quarantined, never "fixed up". Outbound types mirror the
//! validators in convex/ingest.ts field-for-field — that file is the contract owner.

use serde::{Deserialize, Serialize};

// ---------- Ingress (JSONL, INGRESS.md §1–2) ----------

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum IngressRecord {
    Tweet(TweetIn),
    Author(AuthorIn),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TweetIn {
    pub id: String,
    pub text: String,
    pub author_id: String,
    pub created_at: i64,
    pub metrics: Metrics,
    pub metrics_at: i64,
    pub media: Vec<MediaIn>,
    // REQUIRED KEYS, null ok — the interaction graph (INGRESS rule 2)
    pub quoted_tweet_id: Option<String>,
    pub retweet_of_tweet_id: Option<String>,
    pub in_reply_to_tweet_id: Option<String>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub entities: Option<Entities>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Metrics {
    pub likes: u64,
    pub retweets: u64,
    pub quotes: u64,
    pub replies: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIn {
    pub r#type: MediaType,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    None,
    Image,
    Video,
    Gif,
}

#[derive(Debug, Default, Deserialize)]
pub struct Entities {
    #[serde(default)]
    pub hashtags: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub urls: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorIn {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    pub follower_count: u64,
    pub following_count: u64, // Tweepcred ratio adjustment needs this (INGRESS §2)
    pub verified: bool,
    pub created_at: i64,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

// ---------- Outbound (convex/ingest.ts ingestBatch args) ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestBatch {
    pub tweets: Vec<TweetOut>,
    pub authors: Vec<AuthorOut>,
    pub df_deltas: Vec<DfDelta>, // pre-aggregated per batch (RISKS O2)
    pub config_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetOut {
    pub tweet_id: String,
    pub author_id: String,
    pub author_handle: String,
    pub text: String,
    pub created_at: i64,
    pub metrics: Metrics,
    pub metrics_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted_tweet_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retweet_of_tweet_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to_tweet_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub media_type: MediaType,
    pub media_urls: Vec<String>,
    pub has_link: bool,
    pub token_count: u32,
    pub static_score: f64,
    pub score_bucket: u8, // 0..=255, quantized (DESIGN §6.1)
    pub postings: Vec<PostingOut>,
}

#[derive(Debug, Serialize)]
pub struct PostingOut {
    pub term: String, // includes aspect tokens (~price, ...)
    pub tf: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorOut {
    pub author_id: String,
    pub handle: String,
    pub display_name: String,
    pub name_tokens: Vec<String>,
    pub follower_count: u64,
    pub following_count: u64,
    pub verified: bool,
    pub is_stub: bool,
}

#[derive(Debug, Serialize)]
pub struct DfDelta {
    pub term: String,
    pub delta: i64,
}

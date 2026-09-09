//! Wire types.
//!
//! Serde IS the ingress validator (docs/INGRESS.md): a line that fails to
//! deserialize is quarantined, never "fixed up". Outbound types mirror the
//! validators in convex/ingest.ts field-for-field.

use crate::ids::{AuthorId, Handle, Term, TweetId};
use serde::{Deserialize, Serialize};

/// Whether an author row came from a complete source record or was synthesized
/// to satisfy a tweet's foreign-key-like author reference.
///
/// The Convex wire contract remains a boolean (`isStub`); keeping the enum in
/// the Rust domain model prevents callers from passing an arbitrary boolean
/// when constructing an author row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorKind {
    Full,
    Stub,
}

impl AuthorKind {
    #[must_use]
    pub const fn is_stub(&self) -> bool {
        matches!(self, Self::Stub)
    }
}

fn serialize_author_kind<S>(kind: &AuthorKind, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_bool(kind.is_stub())
}

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
    pub id: TweetId,
    pub text: String,
    pub author_id: AuthorId,
    pub created_at: i64,
    pub metrics: Metrics,
    pub metrics_at: i64,
    pub media: Vec<MediaIn>,
    // REQUIRED KEYS, null ok — the interaction graph (INGRESS rule 2)
    pub quoted_tweet_id: Option<TweetId>,
    pub retweet_of_tweet_id: Option<TweetId>,
    pub in_reply_to_tweet_id: Option<TweetId>,
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
    pub r#type: VisualMediaType,
    pub url: String,
}

/// Visual media on an ingress item — never `none` (absence is an empty `media` vec).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualMediaType {
    Image,
    Video,
    Gif,
}

/// Aggregated per-tweet media type on the outbound wire (includes `none`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    None,
    Image,
    Video,
    Gif,
}

impl From<VisualMediaType> for MediaType {
    fn from(value: VisualMediaType) -> Self {
        match value {
            VisualMediaType::Image => Self::Image,
            VisualMediaType::Video => Self::Video,
            VisualMediaType::Gif => Self::Gif,
        }
    }
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
    pub id: AuthorId,
    pub handle: Handle,
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
    /// Compatibility field accepted for existing clients. Convex ignores it
    /// and derives document frequency from newly inserted postings.
    pub df_deltas: Vec<DfDelta>,
    pub config_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetOut {
    pub tweet_id: TweetId,
    pub author_id: AuthorId,
    pub author_handle: Handle,
    pub text: String,
    pub created_at: i64,
    pub metrics: Metrics,
    pub metrics_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted_tweet_id: Option<TweetId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retweet_of_tweet_id: Option<TweetId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to_tweet_id: Option<TweetId>,
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
    pub term: Term, // includes aspect tokens (~price, ...)
    pub tf: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorOut {
    pub author_id: AuthorId,
    pub handle: Handle,
    pub display_name: String,
    pub name_tokens: Vec<Term>,
    pub follower_count: u64,
    pub following_count: u64,
    pub verified: bool,
    #[serde(serialize_with = "serialize_author_kind")]
    pub is_stub: AuthorKind,
}

#[derive(Debug, Serialize)]
pub struct DfDelta {
    pub term: Term,
    pub delta: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The brands must never leak onto the wire: Convex validators and the
    /// goldens see plain strings. Fails if a wrapper ever stops being
    /// `serde(transparent)`.
    #[test]
    fn brands_serialize_as_plain_strings() {
        let batch = IngestBatch {
            tweets: vec![TweetOut {
                tweet_id: TweetId("t1".to_string()),
                author_id: AuthorId("a1".to_string()),
                author_handle: Handle("alice".to_string()),
                text: "hello".to_string(),
                created_at: 1,
                metrics: Metrics {
                    likes: 0,
                    retweets: 0,
                    quotes: 0,
                    replies: 0,
                },
                metrics_at: 1,
                quoted_tweet_id: Some(TweetId("t0".to_string())),
                retweet_of_tweet_id: None,
                in_reply_to_tweet_id: None,
                lang: None,
                media_type: MediaType::None,
                media_urls: Vec::new(),
                has_link: false,
                token_count: 1,
                static_score: 0.0,
                score_bucket: 0,
                postings: vec![PostingOut {
                    term: Term("hello".to_string()),
                    tf: 1,
                }],
            }],
            authors: Vec::new(),
            df_deltas: vec![DfDelta {
                term: Term("hello".to_string()),
                delta: 1,
            }],
            config_hash: "bench".to_string(),
        };
        let value = serde_json::to_value(&batch).unwrap();
        assert_eq!(value["tweets"][0]["tweetId"], "t1");
        assert_eq!(value["tweets"][0]["authorId"], "a1");
        assert_eq!(value["tweets"][0]["authorHandle"], "alice");
        assert_eq!(value["tweets"][0]["quotedTweetId"], "t0");
        assert_eq!(value["tweets"][0]["postings"][0]["term"], "hello");
        assert_eq!(value["dfDeltas"][0]["term"], "hello");
    }

    /// And the reverse: plain-string JSON still decodes into branded ingress.
    #[test]
    fn plain_string_json_decodes_into_brands() {
        let line = r#"{"kind":"tweet","id":"t1","text":"hello","authorId":"a1","createdAt":1700000000000,"metrics":{"likes":0,"retweets":0,"quotes":0,"replies":0},"metricsAt":1700000000000,"media":[],"quotedTweetId":null,"retweetOfTweetId":null,"inReplyToTweetId":null}"#;
        let record: IngressRecord = serde_json::from_str(line).unwrap();
        let IngressRecord::Tweet(tweet) = record else {
            panic!("expected tweet");
        };
        assert_eq!(tweet.id, "t1");
        assert_eq!(tweet.author_id, "a1");
    }
}

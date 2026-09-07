//! Record -> batch transformation. Pure: no I/O in this module (main.rs owns files
//! and HTTP). One tweet in => tweet row + postings (incl. aspects) + df deltas out.

use crate::model::*;
use anyhow::Result;
use std::collections::{HashMap, HashSet};

pub struct Config {
    pub stopwords: HashSet<String>,
    pub aspects: AspectLexicon,          // parsed from shared/lexicons/aspects.json
    pub engagement_weights: (f64, f64, f64, f64), // like, reply, rt, quote = 1,2,3,4
    pub bucket_count: u16,               // 256
    pub config_hash: String,             // hash of all of the above (RISKS O4)
}

pub struct AspectLexicon {
    /// aspect -> (strong phrase patterns, weak single words). Same semantics as
    /// convex/engine/parse.ts::mapAspects — weak needs content co-occurrence (G5).
    pub aspects: HashMap<String, (Vec<String>, Vec<String>)>,
}

pub struct BatchBuilder {
    cfg: Config,
    tweets: Vec<TweetOut>,
    authors: Vec<AuthorOut>,
    df: HashMap<String, i64>, // aggregated per batch — the OCC mitigation (O2)
}

impl BatchBuilder {
    pub fn new(cfg: Config) -> Self {
        Self { cfg, tweets: Vec::new(), authors: Vec::new(), df: HashMap::new() }
    }

    /// Idempotence note: dedupe-by-id happens Convex-side (ingestBatch semantics);
    /// the builder itself is deliberately stateless across batches.
    pub fn push_tweet(&mut self, t: TweetIn) -> Result<()> {
        // TODO(implement):
        // 1. tokenize(text) -> tokens, counts, has_link.
        // 2. aspects = map_aspects(tokens, raw_text) -> extra postings, tf = 1.
        // 3. static_score = w1*ln(1 + 1*likes + 2*replies + 3*rts + 4*quotes)
        //                 + w2*recency_bucket(created_at)   (DESIGN §6.1)
        //    score_bucket = quantize(static_score, cfg.bucket_count).
        // 4. postings = unique terms + aspect tokens with tf; df[term] += 1 each.
        // 5. push TweetOut.
        todo!("push_tweet")
    }

    pub fn push_author(&mut self, a: AuthorIn) -> Result<()> {
        // TODO(implement): name_tokens = tokenize(display_name).tokens; is_stub=false.
        todo!("push_author")
    }

    pub fn is_full(&self) -> bool {
        self.tweets.len() >= 100 // batch size contract (ingest.ts header)
    }

    pub fn finish(self) -> IngestBatch {
        IngestBatch {
            tweets: self.tweets,
            authors: self.authors,
            df_deltas: self
                .df
                .into_iter()
                .map(|(term, delta)| DfDelta { term, delta })
                .collect(),
            config_hash: self.cfg.config_hash,
        }
    }
}

/// Bucket quantization: monotone map of static score into 0..=255. Bucket
/// boundaries are log-spaced so viral-range scores don't crowd the top bucket.
pub fn quantize(static_score: f64, buckets: u16) -> u8 {
    // TODO(implement) + unit test: monotone, stable across runs (K1 depends on it)
    let _ = (static_score, buckets);
    todo!("quantize")
}

/// Boost propagation (DESIGN §6.1, refresh mode): one hop, 0.5x, via quotedTweetId /
/// retweetOfTweetId. Input: (tweet_id, edges, metrics) snapshot; output: per-target
/// propagated_boost values for ingest::applyMetrics.
pub fn propagate_boosts(
    edges: &[(String, Option<String>, Option<String>)],
    metrics: &HashMap<String, Metrics>,
) -> HashMap<String, f64> {
    // TODO(implement) — keep one-hop only (K5: bounded, no graph traversal).
    let _ = (edges, metrics);
    todo!("propagate_boosts")
}

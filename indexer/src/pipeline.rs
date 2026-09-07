//! Record -> batch transformation. Pure: no I/O in this module (main.rs owns files
//! and HTTP). One tweet in => tweet row + postings (incl. aspects) + df deltas out.

use crate::model::*;
use crate::tokenizer::tokenize;
use anyhow::Result;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Recency term (DESIGN §6.1 phase 1): a function of createdAt ONLY, so re-ingesting
/// a tweet always produces the same scoreBucket (idempotence, O1). One "month" of
/// recency is worth one log-unit of engagement. Anchored before the corpus starts.
pub const RECENCY_EPOCH_MS: i64 = 1_735_689_600_000; // 2025-01-01T00:00:00Z
pub const RECENCY_PER_DAY: f64 = 1.0 / 30.0;
pub const RECENCY_MAX_DAYS: f64 = 730.0;

/// Upper clamp for quantization: ln(1+4e7 engagement) ≈ 17.5 plus max recency ≈ 24.3.
pub const SCORE_MAX: f64 = 42.0;

#[derive(Clone)]
pub struct Config {
    pub stopwords: HashSet<String>,
    pub aspects: AspectLexicon,          // parsed from shared/lexicons/aspects.json
    pub engagement_weights: (f64, f64, f64, f64), // like, reply, rt, quote = 1,2,3,4
    pub bucket_count: u16,               // 256
    pub config_hash: String,             // hash of all of the above (RISKS O4)
}

#[derive(Clone)]
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
    /// authorId -> handle, fed by push_author and kept across take_batch calls.
    /// A read-through denorm cache, not batch state: authors precede their tweets
    /// in file order (INGRESS §3.3); main.rs re-warms it on checkpoint resume.
    handles: HashMap<String, String>,
}

impl BatchBuilder {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg,
            tweets: Vec::new(),
            authors: Vec::new(),
            df: HashMap::new(),
            handles: HashMap::new(),
        }
    }

    /// Warm the authorId -> handle cache without emitting an author row (used when
    /// resuming from a checkpoint past the author records).
    pub fn learn_handle(&mut self, author_id: &str, handle: &str) {
        self.handles.insert(author_id.to_string(), handle.to_string());
    }

    /// Idempotence note: dedupe-by-id happens Convex-side (ingestBatch semantics);
    /// the builder itself is deliberately stateless across batches.
    pub fn push_tweet(&mut self, t: TweetIn) -> Result<()> {
        // 1. tokenize(text) -> tokens, counts, has_link.
        let tok = tokenize(&t.text, &self.cfg.stopwords);
        // 2. aspects = map_aspects(tokens, raw_text) -> extra postings, tf = 1.
        let aspects = map_aspects(&tok.tokens, &t.text, &self.cfg.aspects);
        // 3. static score + bucket (DESIGN §6.1 phase 1).
        let (w_like, w_reply, w_rt, w_quote) = self.cfg.engagement_weights;
        let engagement = w_like * t.metrics.likes as f64
            + w_reply * t.metrics.replies as f64
            + w_rt * t.metrics.retweets as f64
            + w_quote * t.metrics.quotes as f64;
        let static_score = engagement.ln_1p() + recency_score(t.created_at);
        let score_bucket = quantize(static_score, self.cfg.bucket_count);
        // 4. postings = unique terms + aspect tokens; df[term] += 1 each.
        //    BTreeMap iteration keeps posting order deterministic across runs.
        let mut terms: BTreeMap<String, u32> = BTreeMap::new();
        for (term, tf) in &tok.counts {
            terms.insert(term.clone(), *tf);
        }
        for aspect in aspects {
            terms.entry(aspect).or_insert(1);
        }
        let mut postings = Vec::with_capacity(terms.len());
        for (term, tf) in terms {
            *self.df.entry(term.clone()).or_insert(0) += 1;
            postings.push(PostingOut { term, tf });
        }
        // 5. push TweetOut. media_type is the FIRST media item's type (collector
        //    order); tweets never mix types in practice and one enum value per
        //    tweet is the schema's contract.
        let media_type = t.media.first().map_or(MediaType::None, |m| m.r#type);
        // Orphan fallback matches INGRESS §3.3's stub rule: handle = id.
        let author_handle = self
            .handles
            .get(&t.author_id)
            .cloned()
            .unwrap_or_else(|| t.author_id.clone());
        self.tweets.push(TweetOut {
            tweet_id: t.id,
            author_id: t.author_id,
            author_handle,
            text: t.text,
            created_at: t.created_at,
            metrics: t.metrics,
            metrics_at: t.metrics_at,
            quoted_tweet_id: t.quoted_tweet_id,
            retweet_of_tweet_id: t.retweet_of_tweet_id,
            in_reply_to_tweet_id: t.in_reply_to_tweet_id,
            lang: t.lang,
            media_type,
            media_urls: t.media.into_iter().map(|m| m.url).collect(),
            has_link: tok.has_link,
            token_count: tok.tokens.len() as u32,
            static_score,
            score_bucket,
            postings,
        });
        Ok(())
    }

    pub fn push_author(&mut self, a: AuthorIn) -> Result<()> {
        let name_tokens = tokenize(&a.display_name, &self.cfg.stopwords).tokens;
        self.handles.insert(a.id.clone(), a.handle.clone());
        self.authors.push(AuthorOut {
            author_id: a.id,
            handle: a.handle,
            display_name: a.display_name,
            name_tokens,
            follower_count: a.follower_count,
            following_count: a.following_count,
            verified: a.verified,
            is_stub: false,
        });
        Ok(())
    }

    pub fn is_full(&self) -> bool {
        // ~100 tweets per batch (ingest.ts header), AND a df-term budget: ingestBatch
        // does one indexed read per df delta and Convex caps a mutation at 4096
        // reads, so dense/unique-vocab stretches flush early.
        self.tweets.len() >= 100 || self.df.len() >= 1500
    }

    pub fn is_empty(&self) -> bool {
        self.tweets.is_empty() && self.authors.is_empty()
    }

    /// Drain the pending batch; the builder (and its handle cache) lives on.
    pub fn take_batch(&mut self) -> IngestBatch {
        let mut df: Vec<DfDelta> = std::mem::take(&mut self.df)
            .into_iter()
            .map(|(term, delta)| DfDelta { term, delta })
            .collect();
        df.sort_by(|a, b| a.term.cmp(&b.term)); // deterministic wire payloads
        IngestBatch {
            tweets: std::mem::take(&mut self.tweets),
            authors: std::mem::take(&mut self.authors),
            df_deltas: df,
            config_hash: self.cfg.config_hash.clone(),
        }
    }
}

/// Deterministic recency (see RECENCY_* constants above).
pub fn recency_score(created_at_ms: i64) -> f64 {
    let days = (created_at_ms - RECENCY_EPOCH_MS) as f64 / 86_400_000.0;
    days.clamp(0.0, RECENCY_MAX_DAYS) * RECENCY_PER_DAY
}

/// Aspect mapping — mirrors convex/engine/parse.ts::mapAspects exactly: strong
/// patterns match as phrases over the token stream; weak single words need >=1
/// co-occurring non-aspect content token beyond the weak hits (ASPECTS G5);
/// "$"+digit in the ORIGINAL text is a ~price signal (RISKS T4).
pub fn map_aspects(tokens: &[String], raw_text: &str, lexicon: &AspectLexicon) -> Vec<String> {
    let joined = format!(" {} ", tokens.join(" "));
    let mut found: Vec<String> = Vec::new();
    for (aspect, (strong, weak)) in &lexicon.aspects {
        if strong.iter().any(|p| joined.contains(&format!(" {p} "))) {
            found.push(aspect.clone());
            continue;
        }
        let weak_hits = weak
            .iter()
            .filter(|w| joined.contains(&format!(" {w} ")))
            .count();
        let has_content = tokens.iter().any(|t| !t.starts_with('~') && !weak.contains(t));
        if weak_hits > 0 && has_content {
            found.push(aspect.clone());
        }
    }
    let dollar_digit = raw_text
        .as_bytes()
        .windows(2)
        .any(|w| w[0] == b'$' && w[1].is_ascii_digit());
    if dollar_digit && !found.iter().any(|a| a == "~price") {
        found.push("~price".to_string());
    }
    found.sort();
    found
}

/// Bucket quantization: monotone map of static score into 0..=255. Bucket
/// boundaries are log-spaced so viral-range scores don't crowd the top bucket
/// (the score is already log-compressed; the extra ln keeps mid-range spread).
pub fn quantize(static_score: f64, buckets: u16) -> u8 {
    let max_bucket = (buckets - 1) as f64;
    let s = static_score.clamp(0.0, SCORE_MAX);
    let b = (max_bucket * s.ln_1p() / SCORE_MAX.ln_1p()).floor();
    b.clamp(0.0, max_bucket) as u8
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_is_monotone_and_stable() {
        let mut prev = 0u8;
        for i in 0..=4200 {
            let s = i as f64 / 100.0;
            let b = quantize(s, 256);
            assert!(b >= prev, "bucket must be monotone at score {s}");
            assert_eq!(b, quantize(s, 256), "bucket must be stable at score {s}");
            prev = b;
        }
        assert_eq!(quantize(-1.0, 256), 0);
        assert_eq!(quantize(0.0, 256), 0);
        assert_eq!(quantize(SCORE_MAX, 256), 255);
        assert_eq!(quantize(SCORE_MAX + 100.0, 256), 255);
    }

    #[test]
    fn recency_is_a_pure_function_of_created_at() {
        assert_eq!(recency_score(RECENCY_EPOCH_MS), 0.0);
        assert_eq!(recency_score(RECENCY_EPOCH_MS - 86_400_000), 0.0); // clamped below
        let one_month = recency_score(RECENCY_EPOCH_MS + 30 * 86_400_000);
        assert!((one_month - 1.0).abs() < 1e-9);
    }

    fn lexicon() -> AspectLexicon {
        // Matches shared/lexicons/aspects.json rows used below.
        let mut aspects = HashMap::new();
        aspects.insert(
            "~price".to_string(),
            (
                vec!["pricing".to_string(), "too expensive".to_string()],
                vec!["cheap".to_string(), "expensive".to_string()],
            ),
        );
        AspectLexicon { aspects }
    }

    #[test]
    fn aspects_mirror_ts_semantics() {
        let lex = lexicon();
        let toks = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        // strong phrase always fires
        assert_eq!(map_aspects(&toks("pricing linux boxes"), "", &lex), vec!["~price"]);
        // weak word needs a co-occurring content token
        assert_eq!(map_aspects(&toks("cheap laptop"), "", &lex), vec!["~price"]);
        assert!(map_aspects(&toks("cheap"), "", &lex).is_empty());
        assert!(map_aspects(&toks("cheap cheap expensive"), "", &lex).is_empty());
        // $+digit in the raw text is a ~price signal on its own
        assert_eq!(map_aspects(&toks("99 sale"), "only $99 sale", &lex), vec!["~price"]);
    }
}

//! Record -> batch transformation.
//!
//! Pure: no I/O in this module (main.rs owns files and HTTP). One tweet in
//! produces a tweet row, postings, and df deltas.

use crate::ids::{AuthorId, Handle, Term, TweetId};
use crate::model::{
    AuthorIn, AuthorKind, AuthorOut, DfDelta, IngestBatch, MediaType, Metrics, PostingOut, TweetIn,
    TweetOut,
};
use crate::num::u64_as_f64;
use crate::tokenizer::tokenize;
use std::collections::{BTreeMap, HashMap, HashSet};

fn timestamp_delta_as_f64(value: i64) -> f64 {
    let magnitude = u64_as_f64(value.unsigned_abs());
    if value.is_negative() {
        -magnitude
    } else {
        magnitude
    }
}

/// Recency term (DESIGN §6.1 phase 1).
///
/// A function of createdAt ONLY, so re-ingesting a tweet always produces the
/// same scoreBucket (idempotence, O1). One month of recency is worth one
/// log-unit of engagement.
pub const RECENCY_EPOCH_MS: i64 = 1_735_689_600_000; // 2025-01-01T00:00:00Z
pub const RECENCY_PER_DAY: f64 = 1.0 / 30.0;
pub const RECENCY_MAX_DAYS: f64 = 730.0;

/// Upper clamp for quantization: ln(1+4e7 engagement) ≈ 17.5 plus max recency ≈ 24.3.
pub const SCORE_MAX: f64 = 42.0;

/// Aspect token for `$` + digit / price lexicon hits (RISKS T4).
pub const ASPECT_PRICE: &str = "~price";

#[derive(Clone, Copy, Debug)]
pub struct EngagementWeights {
    pub like: f64,
    pub reply: f64,
    pub retweet: f64,
    pub quote: f64,
}

/// Weighted engagement as `ln(1 + …)` — shared by static scoring and boost propagation.
#[must_use]
pub fn engagement_ln1p(metrics: &Metrics, w: &EngagementWeights) -> f64 {
    let engagement = f64::mul_add(
        w.quote,
        u64_as_f64(metrics.quotes),
        f64::mul_add(
            w.retweet,
            u64_as_f64(metrics.retweets),
            f64::mul_add(
                w.reply,
                u64_as_f64(metrics.replies),
                w.like * u64_as_f64(metrics.likes),
            ),
        ),
    );
    engagement.ln_1p()
}

#[derive(Clone)]
pub struct Config {
    pub stopwords: HashSet<String>,
    pub aspects: AspectLexicon, // parsed from shared/lexicons/aspects.json
    pub engagement_weights: EngagementWeights, // like, reply, rt, quote = 1,2,3,4
    pub bucket_count: u16,      // 256
    pub config_hash: String,    // hash of all of the above (RISKS O4)
}

#[derive(Clone)]
pub struct AspectPatterns {
    pub strong: Vec<String>,
    pub weak: Vec<String>,
}

#[derive(Clone)]
pub struct AspectLexicon {
    /// aspect -> strong phrase patterns / weak single words. Same semantics as
    /// `convex/engine/parse.ts::mapAspects` — weak needs content co-occurrence (G5).
    /// Keys are aspect terms (`~price`, …); patterns stay raw strings.
    pub aspects: HashMap<Term, AspectPatterns>,
}

pub struct BatchBuilder {
    cfg: Config,
    tweets: Vec<TweetOut>,
    authors: Vec<AuthorOut>,
    df: HashMap<Term, i64>, // aggregated per batch — the OCC mitigation (O2)
    /// authorId -> handle, fed by `push_author` and kept across `take_batch` calls.
    /// A read-through denorm cache, not batch state: authors precede their tweets
    /// in file order (INGRESS §3.3); main.rs re-warms it on checkpoint resume.
    handles: HashMap<AuthorId, Handle>,
}

impl BatchBuilder {
    #[must_use]
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
    pub fn learn_handle(&mut self, author_id: &AuthorId, handle: &Handle) {
        self.handles.insert(author_id.clone(), handle.clone());
    }

    /// Idempotence note: dedupe-by-id happens Convex-side (ingestBatch semantics);
    /// the builder itself is deliberately stateless across batches.
    pub fn push_tweet(&mut self, t: TweetIn) {
        // 1. tokenize(text) -> tokens, counts, has_link.
        let tok = tokenize(&t.text, &self.cfg.stopwords);
        // 2. aspects = map_aspects(tokens, raw_text) -> extra postings, tf = 1.
        let aspects = map_aspects(&tok.tokens, &t.text, &self.cfg.aspects);
        // 3. static score + bucket (DESIGN §6.1 phase 1).
        let static_score =
            engagement_ln1p(&t.metrics, &self.cfg.engagement_weights) + recency_score(t.created_at);
        let score_bucket = quantize(static_score, self.cfg.bucket_count);
        // 4. postings = unique terms + aspect tokens; df[term] += 1 each.
        //    BTreeMap iteration keeps posting order deterministic across runs.
        let mut terms: BTreeMap<Term, u32> = BTreeMap::new();
        for (term, tf) in &tok.counts {
            terms.insert(term.clone(), *tf);
        }
        for aspect in aspects {
            terms.entry(aspect).or_insert(1);
        }
        let mut postings = Vec::with_capacity(terms.len());
        for (term, tf) in terms {
            let count = self.df.entry(term.clone()).or_insert(0);
            *count = count.saturating_add(1);
            postings.push(PostingOut { term, tf });
        }
        // 5. push TweetOut. media_type is the FIRST media item's type (collector
        //    order); tweets never mix types in practice and one enum value per
        //    tweet is the schema's contract.
        let media_type = t
            .media
            .first()
            .map_or(MediaType::None, |m| MediaType::from(m.r#type));
        // Orphan fallback matches INGRESS §3.3's stub rule: handle = id. The
        // brand conversion is explicit because it crosses identity spaces.
        let author_handle = self
            .handles
            .get(&t.author_id)
            .cloned()
            .unwrap_or_else(|| Handle(t.author_id.0.clone()));
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
            token_count: u32::try_from(tok.tokens.len()).unwrap_or(u32::MAX),
            static_score,
            score_bucket,
            postings,
        });
    }

    pub fn push_author(&mut self, a: AuthorIn) {
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
            is_stub: AuthorKind::Full,
        });
    }

    #[must_use]
    pub fn is_full(&self) -> bool {
        // ~100 tweets per batch (ingest.ts header), AND a df-term budget: ingestBatch
        // does one indexed read per df delta and Convex caps a mutation at 4096
        // reads, so dense/unique-vocab stretches flush early.
        self.tweets.len() >= 100 || self.authors.len() >= 100 || self.df.len() >= 1500
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
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
#[must_use]
pub fn recency_score(created_at_ms: i64) -> f64 {
    let days =
        timestamp_delta_as_f64(created_at_ms.saturating_sub(RECENCY_EPOCH_MS)) / 86_400_000.0;
    days.clamp(0.0, RECENCY_MAX_DAYS) * RECENCY_PER_DAY
}

/// Aspect mapping, mirroring `convex/engine/parse.ts::mapAspects`.
///
/// Strong patterns match as phrases; weak single words need a co-occurring
/// non-aspect content token (ASPECTS G5). `$` + digit in the original text is
/// a `~price` signal (RISKS T4).
#[must_use]
pub fn map_aspects(tokens: &[Term], raw_text: &str, lexicon: &AspectLexicon) -> Vec<Term> {
    let joined = format!(" {} ", tokens.join(" "));
    let mut found: Vec<Term> = Vec::new();
    for (aspect, patterns) in &lexicon.aspects {
        if patterns
            .strong
            .iter()
            .any(|p| joined.contains(&format!(" {p} ")))
        {
            found.push(aspect.clone());
            continue;
        }
        let weak_hits = patterns
            .weak
            .iter()
            .filter(|w| joined.contains(&format!(" {w} ")))
            .count();
        let has_content = tokens
            .iter()
            .any(|t| !t.starts_with('~') && !patterns.weak.iter().any(|w| w == t.as_str()));
        if weak_hits > 0 && has_content {
            found.push(aspect.clone());
        }
    }
    let dollar_digit = raw_text
        .as_bytes()
        .windows(2)
        .any(|w| w.first() == Some(&b'$') && w.get(1).is_some_and(u8::is_ascii_digit));
    if dollar_digit && !found.iter().any(|a| a.as_str() == ASPECT_PRICE) {
        found.push(Term(ASPECT_PRICE.to_string()));
    }
    found.sort();
    found
}

/// Bucket quantization, mapping static score monotonically into 0..=255.
///
/// Boundaries are log-spaced so viral-range scores do not crowd the top
/// bucket.
#[must_use]
pub fn quantize(static_score: f64, buckets: u16) -> u8 {
    let max_bucket = f64::from(buckets.saturating_sub(1));
    let s = static_score.clamp(0.0, SCORE_MAX);
    let b = (max_bucket * s.ln_1p() / SCORE_MAX.ln_1p()).floor();
    let bounded = b.clamp(0.0, max_bucket);
    (0..=u8::MAX)
        .find(|candidate| f64::from(*candidate) > bounded)
        .map_or(u8::MAX, |candidate| candidate.saturating_sub(1))
}

/// Boost propagation (DESIGN §6.1, refresh mode): one hop at 0.5x.
///
/// Uses quotedTweetId / retweetOfTweetId edges and returns per-target
/// `propagated_boost` values for `ingest::applyMetrics`.
#[must_use]
pub fn propagate_boosts<S: std::hash::BuildHasher>(
    edges: &[(TweetId, Option<TweetId>, Option<TweetId>)],
    metrics: &HashMap<TweetId, Metrics, S>,
    weights: &EngagementWeights,
) -> HashMap<TweetId, f64> {
    let mut boosts = HashMap::new();
    for (tweet_id, quoted_id, retweeted_id) in edges {
        let Some(source) = metrics.get(tweet_id) else {
            continue;
        };
        let boost = 0.5 * engagement_ln1p(source, weights);
        for target in [quoted_id.as_ref(), retweeted_id.as_ref()]
            .into_iter()
            .flatten()
        {
            boosts
                .entry(target.clone())
                .and_modify(|value| *value += boost)
                .or_insert(boost);
        }
    }
    boosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_is_monotone_and_stable() {
        let mut prev = 0u8;
        for i in 0..=4200 {
            let s = f64::from(i) / 100.0;
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
            Term(ASPECT_PRICE.to_string()),
            AspectPatterns {
                strong: vec!["pricing".to_string(), "too expensive".to_string()],
                weak: vec!["cheap".to_string(), "expensive".to_string()],
            },
        );
        AspectLexicon { aspects }
    }

    fn toks(s: &str) -> Vec<Term> {
        s.split_whitespace().map(|w| Term(w.to_string())).collect()
    }

    #[test]
    fn aspects_mirror_ts_semantics() {
        let lex = lexicon();
        // strong phrase always fires
        assert_eq!(
            map_aspects(&toks("pricing linux boxes"), "", &lex),
            vec![Term(ASPECT_PRICE.to_string())]
        );
        // weak word needs a co-occurring content token
        assert_eq!(
            map_aspects(&toks("cheap laptop"), "", &lex),
            vec![Term(ASPECT_PRICE.to_string())]
        );
        assert_eq!(map_aspects(&toks("cheap"), "", &lex), Vec::<Term>::new());
        assert_eq!(
            map_aspects(&toks("cheap cheap expensive"), "", &lex),
            Vec::<Term>::new()
        );
        // $+digit in the raw text is a ~price signal on its own
        assert_eq!(
            map_aspects(&toks("99 sale"), "only $99 sale", &lex),
            vec![Term(ASPECT_PRICE.to_string())]
        );
    }
}

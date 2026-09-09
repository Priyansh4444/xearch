//! End-to-end `push_tweet` throughput: tokenize plus aspect mapping plus static
//! scoring plus postings against the real stopwords and aspects lexicons. This
//! is the number the backfill mode reports as tweets per second (the backfill
//! target is at least 500/s), and the baseline any bounded-concurrent pipeline
//! work must beat without changing the batch bytes (goldens pin those).
use criterion::{Criterion, Throughput};
use serde::Deserialize;
use std::collections::HashMap;
use std::hint::black_box;
use std::time::Duration;
use xearch_indexer::ids::{AuthorId, Handle, Term, TweetId};
use xearch_indexer::model::{Metrics, TweetIn};
use xearch_indexer::pipeline::{
    AspectLexicon, AspectPatterns, BatchBuilder, Config, EngagementWeights,
};

// Representative shape mix: short, long, CJK, emoji-heavy, link + $cashtag.
const CORPUS: &[&str] = &[
    "Just shipped convex search Phase 2: tier A+B ladder with rerank. p50 12ms.",
    "Long thread on why pagerank on the interaction graph beats raw follower counts for authority: 1/ like velocity decays fast 2/ quote tweets carry 4x the signal of likes 3/ replies are gamed by rage bait so weight them 2x not 5x. Full writeup with the math and the ablation numbers on 165k posts below.",
    "日本語のテスト投稿です検索エンジンのトークナイザーが正しくバイグラムを生成するか確認します",
    "🚀🚀🚀 shipping day!!! 🔥 new embeddings dropped 🎉🎉 vector search wen??? 🤣",
    "Read https://example.com/blog/rerank-guide and $TSLA earnings — only $99 for the full report www.example.com/pay",
    "cheap laptop pricing too expensive? comparing boxes for the homelab",
    "@nasa photo of the day: deep field images from the latest drop",
    "gm",
];

#[derive(Deserialize)]
struct StopwordsFile {
    stopwords: Vec<String>,
}

#[derive(Deserialize)]
struct AspectSlot {
    strong: Vec<String>,
    weak: Vec<String>,
}

#[derive(Deserialize)]
struct AspectsFile {
    aspects: HashMap<String, AspectSlot>,
}

fn load_config() -> color_eyre::Result<Config> {
    let stopwords_file: StopwordsFile =
        serde_json::from_str(include_str!("../../shared/lexicons/stopwords.json"))?;
    let aspects_file: AspectsFile =
        serde_json::from_str(include_str!("../../shared/lexicons/aspects.json"))?;
    let mut aspects = HashMap::new();
    for (name, slot) in aspects_file.aspects {
        aspects.insert(
            Term(name),
            AspectPatterns {
                strong: slot.strong,
                weak: slot.weak,
            },
        );
    }
    Ok(Config {
        stopwords: stopwords_file.stopwords.into_iter().collect(),
        aspects: AspectLexicon { aspects },
        engagement_weights: EngagementWeights {
            like: 1.0,
            reply: 2.0,
            retweet: 3.0,
            quote: 4.0,
        },
        bucket_count: 256,
        config_hash: String::from("bench"),
    })
}

fn tweet(n: usize, text: &str) -> TweetIn {
    TweetIn {
        id: TweetId(format!("bench-tweet-{n}")),
        text: text.to_string(),
        author_id: AuthorId(String::from("bench-author")),
        created_at: 1_750_000_000_000,
        metrics: Metrics {
            likes: 100,
            retweets: 10,
            quotes: 2,
            replies: 5,
        },
        metrics_at: 1_750_000_000_000,
        media: Vec::new(),
        quoted_tweet_id: None,
        retweet_of_tweet_id: None,
        in_reply_to_tweet_id: None,
        lang: Some(String::from("en")),
        entities: None,
    }
}

fn main() -> color_eyre::Result<()> {
    let mut criterion = Criterion::default()
        .sample_size(30)
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(2))
        .configure_from_args();
    {
        // The builder lives across batches in production (handle cache, df
        // aggregation), so reuse it here and drain with take_batch per iter.
        let mut builder = BatchBuilder::new(load_config()?);
        builder.learn_handle(
            &AuthorId(String::from("bench-author")),
            &Handle(String::from("bench-author")),
        );
        let mut group = criterion.benchmark_group("pipeline");
        group.throughput(Throughput::Elements(u64::try_from(CORPUS.len())?));
        group.bench_function("push_tweet_mixed_corpus", |b| {
            b.iter(|| {
                for (n, text) in CORPUS.iter().enumerate() {
                    builder.push_tweet(tweet(n, text));
                }
                black_box(builder.take_batch());
            });
        });
        group.finish();
    }
    criterion.final_summary();
    drop(criterion);
    Ok(())
}

//! CLI shell — all I/O lives here (files, HTTP, clock); logic in lib modules.
//! Three modes per DESIGN §12.2. Failure policy: malformed line -> quarantine file
//! + counter, never crash the loop, never drop silently.

use clap::{Parser, Subcommand};
use color_eyre::eyre::{bail, Context, ContextCompat, Result};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use xearch_indexer::checkpoint::Checkpoint;
use xearch_indexer::convex_api::ConvexClient;
use xearch_indexer::ids::Term;
use xearch_indexer::model::IngressRecord;
use xearch_indexer::num::u64_as_f64;
use xearch_indexer::pipeline::{
    AspectLexicon, AspectPatterns, BatchBuilder, Config, EngagementWeights, RECENCY_EPOCH_MS,
    RECENCY_MAX_DAYS, RECENCY_PER_DAY, SCORE_MAX,
};
use xearch_indexer::tokenizer::TOKENIZER_VERSION;

#[derive(Parser)]
#[command(name = "xearch-indexer")]
struct Cli {
    #[command(subcommand)]
    mode: Mode,
    /// Directory of JSONL ingress files (INGRESS.md); watched in tail mode.
    #[arg(long, default_value = "./data")]
    data_dir: std::path::PathBuf,
    #[arg(long, default_value = "./checkpoint.json")]
    checkpoint: std::path::PathBuf,
    /// Directory holding stopwords.json + aspects.json (single sources of truth).
    #[arg(long, default_value = "./shared/lexicons")]
    lexicons: std::path::PathBuf,
    /// Directory that receives malformed/rejected lines, one file per source.
    #[arg(long, default_value = "./quarantine")]
    quarantine: std::path::PathBuf,
    /// Stop after ingesting this many tweets (slice loads for inspection).
    #[arg(long)]
    limit: Option<u64>,
}

#[derive(Subcommand)]
enum Mode {
    /// Bulk-load a corpus directory (throughput target: >=500 tweets/s).
    Backfill,
    /// Follow new files 24/7 (lag target: <5s from append to searchable).
    Tail,
    /// Re-bucket scores, apply metric re-crawls + boost propagation, run
    /// Tweepcred, backfill embeddings.
    Refresh,
}

fn main() -> Result<()> {
    color_eyre::install()?;
    let cli = Cli::parse();
    match cli.mode {
        Mode::Backfill => backfill(&cli),
        Mode::Tail => Err(color_eyre::eyre::eyre!("tail mode is not implemented yet")),
        Mode::Refresh => Err(color_eyre::eyre::eyre!(
            "refresh mode is not implemented yet"
        )),
    }
}

/// Bulk-load every *.jsonl under `data_dir`, checkpointing AFTER each Convex ack
/// (O1 ordering is the whole point). Malformed or gate-failing lines land in
/// quarantine files + counters — never crash the loop, never drop silently.
fn backfill(cli: &Cli) -> Result<()> {
    let cfg = load_config(&cli.lexicons)?;
    let client = ConvexClient::from_env()?;
    let mut checkpoint = Checkpoint::load(&cli.checkpoint)?;
    if !checkpoint.config_hash.is_empty() && checkpoint.config_hash != cfg.config_hash {
        bail!(
            "checkpoint {} was written under config {} but the current config hashes to {}.\n\
             A config change invalidates progress (RISKS O4): either restore the old\n\
             config or delete the checkpoint and reindex deliberately.",
            cli.checkpoint.display(),
            checkpoint.config_hash,
            cfg.config_hash
        );
    }
    checkpoint.config_hash.clone_from(&cfg.config_hash);

    let mut files: Vec<PathBuf> = std::fs::read_dir(&cli.data_dir)
        .with_context(|| format!("reading data dir {}", cli.data_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    if files.is_empty() {
        bail!("no .jsonl files under {}", cli.data_dir.display());
    }

    let mut builder = BatchBuilder::new(cfg);
    let mut stats = Stats::default();
    let started = std::time::Instant::now();

    for file in &files {
        let name = file_name(file);
        let offset = *checkpoint.offsets.get(&name).unwrap_or(&0);
        let reader = std::io::BufReader::new(
            std::fs::File::open(file).with_context(|| format!("opening {name}"))?,
        );
        let mut next_offset = offset;
        let mut flush_ctx = FlushContext {
            client: &client,
            builder: &mut builder,
            checkpoint: &mut checkpoint,
            cli,
            stats: &mut stats,
        };
        for (idx, line) in reader.lines().enumerate() {
            let idx = u64::try_from(idx).unwrap_or(u64::MAX);
            let line = line.with_context(|| format!("reading {name}:{idx}"))?;
            if idx < offset {
                // Already acked in a previous run — re-warm the handle cache only
                // (authors precede their tweets; a resume must not forget them).
                if let Ok(IngressRecord::Author(a)) = serde_json::from_str(&line) {
                    flush_ctx.builder.learn_handle(&a.id, &a.handle);
                }
                continue;
            }
            if line.trim().is_empty() {
                next_offset = idx.saturating_add(1);
                continue;
            }
            match parse_and_gate(&line) {
                Ok(IngressRecord::Tweet(t)) => {
                    flush_ctx.builder.push_tweet(t);
                    flush_ctx.stats.tweets = flush_ctx.stats.tweets.saturating_add(1);
                }
                Ok(IngressRecord::Author(a)) => {
                    flush_ctx.builder.push_author(a);
                    flush_ctx.stats.authors = flush_ctx.stats.authors.saturating_add(1);
                }
                Err(reason) => {
                    quarantine(&cli.quarantine, &name, &line, &reason)?;
                    flush_ctx.stats.quarantined = flush_ctx.stats.quarantined.saturating_add(1);
                }
            }
            next_offset = idx.saturating_add(1);
            if flush_ctx.builder.is_full() {
                flush_ctx.flush(&name, next_offset)?;
            }
            if cli
                .limit
                .is_some_and(|limit| flush_ctx.stats.tweets >= limit)
            {
                break;
            }
        }
        // Flush at the file boundary so offsets never describe a half-acked file.
        if !flush_ctx.builder.is_empty() {
            flush_ctx.flush(&name, next_offset)?;
        }
        // All pending records have been acknowledged. Persist progress even if
        // the suffix contained only blank or quarantined lines.
        flush_ctx
            .checkpoint
            .offsets
            .insert(name.clone(), next_offset);
        flush_ctx.checkpoint.store(&cli.checkpoint)?;
        if limit_reached(cli, flush_ctx.stats) {
            report_limit(cli);
            break;
        }
    }

    report_summary(&stats, started);
    Ok(())
}

#[derive(Default)]
struct Stats {
    tweets: u64,
    authors: u64,
    batches: u64,
    quarantined: u64,
}

fn limit_reached(cli: &Cli, stats: &Stats) -> bool {
    cli.limit.is_some_and(|limit| stats.tweets >= limit)
}

fn report_limit(cli: &Cli) {
    eprintln!(
        "limit {} reached; stopping (checkpoint resumes here)",
        cli.limit.unwrap_or_default()
    );
}

fn report_summary(stats: &Stats, started: std::time::Instant) {
    let secs = started.elapsed().as_secs_f64().max(1e-9);
    eprintln!(
        "backfill done: {} tweets, {} authors, {} batches, {} quarantined, {:.0} tweets/s",
        stats.tweets,
        stats.authors,
        stats.batches,
        stats.quarantined,
        u64_as_f64(stats.tweets) / secs
    );
}

struct FlushContext<'a> {
    client: &'a ConvexClient,
    builder: &'a mut BatchBuilder,
    checkpoint: &'a mut Checkpoint,
    cli: &'a Cli,
    stats: &'a mut Stats,
}

impl FlushContext<'_> {
    fn flush(&mut self, file: &str, next_offset: u64) -> Result<()> {
        let batch = self.builder.take_batch();
        let ack = self.client.ingest_batch(&batch)?;
        self.stats.batches = self.stats.batches.saturating_add(1);
        self.checkpoint
            .offsets
            .insert(file.to_string(), next_offset);
        self.checkpoint.store(&self.cli.checkpoint)?; // AFTER the ack — crash-resume without dupes/gaps
        eprintln!(
            "batch {}: {} tweets ({} inserted, {} updated, {} skipped), {} authors, {} df terms — {file}:{next_offset}",
            self.stats.batches,
            batch.tweets.len(),
            ack.inserted,
            ack.updated,
            ack.skipped,
            batch.authors.len(),
            batch.df_deltas.len()
        );
        Ok(())
    }
}

/// serde is the parser; the INGRESS §5 sanity gates run on top of it.
fn parse_and_gate(line: &str) -> std::result::Result<IngressRecord, String> {
    let record: IngressRecord = serde_json::from_str(line).map_err(|e| format!("parse: {e}"))?;
    if let IngressRecord::Tweet(t) = &record {
        if t.text.trim().is_empty() {
            return Err("gate: empty text".to_string());
        }
        let now_plus = now_ms().saturating_add(5 * 60 * 1000);
        let floor = 1_136_073_600_000; // 2006-01-01: before Twitter existed
        for (label, ts) in [("createdAt", t.created_at), ("metricsAt", t.metrics_at)] {
            if ts <= floor || ts > now_plus {
                return Err(format!("gate: {label} {ts} outside (2006, now+5m]"));
            }
        }
    }
    Ok(record)
}

fn quarantine(dir: &Path, source: &str, line: &str, reason: &str) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(source))?;
    writeln!(
        f,
        "{}",
        serde_json::json!({ "reason": reason, "line": line })
    )?;
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Load the shared lexicons and derive the config hash (RISKS O4): any change to
/// stopwords, aspects, scoring weights, bucketing, or the tokenizer version yields
/// a different hash and forces a deliberate reindex decision.
fn load_config(lexicons: &Path) -> Result<Config> {
    let stopwords_raw = std::fs::read_to_string(lexicons.join("stopwords.json"))
        .with_context(|| format!("reading {}/stopwords.json", lexicons.display()))?;
    let aspects_raw = std::fs::read_to_string(lexicons.join("aspects.json"))
        .with_context(|| format!("reading {}/aspects.json", lexicons.display()))?;

    let stopwords_json: serde_json::Value = serde_json::from_str(&stopwords_raw)?;
    let stopwords: HashSet<String> = stopwords_json
        .get("stopwords")
        .context("stopwords.json: missing stopwords array")?
        .as_array()
        .context("stopwords.json: missing stopwords array")?
        .iter()
        .filter_map(|s| s.as_str().map(String::from))
        .collect();

    let aspects_json: serde_json::Value = serde_json::from_str(&aspects_raw)?;
    let mut aspects = std::collections::HashMap::new();
    for (name, entry) in aspects_json
        .get("aspects")
        .context("aspects.json: missing aspects object")?
        .as_object()
        .context("aspects.json: missing aspects object")?
    {
        let list = |key: &str| -> Vec<String> {
            entry
                .get(key)
                .and_then(serde_json::Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        aspects.insert(
            Term(name.clone()),
            AspectPatterns {
                strong: list("strong"),
                weak: list("weak"),
            },
        );
    }

    let engagement_weights = EngagementWeights {
        like: 1.0,
        reply: 2.0,
        retweet: 3.0,
        quote: 4.0,
    }; // like, reply, rt, quote (DESIGN §6.1)
    let bucket_count: u16 = 256;
    // Debug of the old `(f64,f64,f64,f64)` tuple — keep byte-identical for config_hash.
    let weights_dbg = format!(
        "{:?}",
        (
            engagement_weights.like,
            engagement_weights.reply,
            engagement_weights.retweet,
            engagement_weights.quote
        )
    );
    let params = format!(
        "tokenizerVersion={TOKENIZER_VERSION};aspectMapping=2;weights={weights_dbg};buckets={bucket_count};recency={RECENCY_EPOCH_MS},{RECENCY_PER_DAY},{RECENCY_MAX_DAYS};scoreMax={SCORE_MAX}"
    );
    let config_hash = format!(
        "fnv1a64:{:016x}",
        fnv1a64(&[
            params.as_bytes(),
            stopwords_raw.as_bytes(),
            aspects_raw.as_bytes()
        ])
    );

    Ok(Config {
        stopwords,
        aspects: AspectLexicon { aspects },
        engagement_weights,
        bucket_count,
        config_hash,
    })
}

/// FNV-1a 64-bit — stability is the requirement here, not crypto.
fn fnv1a64(parts: &[&[u8]]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for &byte in *part {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

//! CLI shell — all I/O lives here (files, HTTP, clock); logic in lib modules.
//! Three modes per DESIGN §12.2. Failure policy: malformed line -> quarantine file
//! + counter, never crash the loop, never drop silently.

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use xearch_indexer::checkpoint::Checkpoint;
use xearch_indexer::convex_api::ConvexClient;
use xearch_indexer::model::IngressRecord;
use xearch_indexer::pipeline::{AspectLexicon, BatchBuilder, Config, RECENCY_EPOCH_MS, RECENCY_MAX_DAYS, RECENCY_PER_DAY, SCORE_MAX};
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

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.mode {
        Mode::Backfill => backfill(&cli),
        Mode::Tail => todo!("tail loop"),
        Mode::Refresh => todo!("refresh jobs"),
    }
}

/// Bulk-load every *.jsonl under data_dir, checkpointing AFTER each Convex ack
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
    checkpoint.config_hash = cfg.config_hash.clone();

    let mut files: Vec<PathBuf> = std::fs::read_dir(&cli.data_dir)
        .with_context(|| format!("reading data dir {}", cli.data_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    if files.is_empty() {
        bail!("no .jsonl files under {}", cli.data_dir.display());
    }

    let mut builder = BatchBuilder::new(cfg.clone());
    let mut stats = Stats::default();
    let started = std::time::Instant::now();

    for file in &files {
        let name = file_name(file);
        let offset = *checkpoint.offsets.get(&name).unwrap_or(&0);
        let reader = std::io::BufReader::new(
            std::fs::File::open(file).with_context(|| format!("opening {name}"))?,
        );
        let mut next_offset = offset;
        for (idx, line) in reader.lines().enumerate() {
            let idx = idx as u64;
            let line = line.with_context(|| format!("reading {name}:{idx}"))?;
            if line.trim().is_empty() {
                next_offset = idx + 1;
                continue;
            }
            if idx < offset {
                // Already acked in a previous run — re-warm the handle cache only
                // (authors precede their tweets; a resume must not forget them).
                if let Ok(IngressRecord::Author(a)) = serde_json::from_str(&line) {
                    builder.learn_handle(&a.id, &a.handle);
                }
                continue;
            }
            match parse_and_gate(&line) {
                Ok(IngressRecord::Tweet(t)) => {
                    builder.push_tweet(t)?;
                    stats.tweets += 1;
                }
                Ok(IngressRecord::Author(a)) => {
                    builder.push_author(a)?;
                    stats.authors += 1;
                }
                Err(reason) => {
                    quarantine(&cli.quarantine, &name, &line, &reason)?;
                    stats.quarantined += 1;
                }
            }
            next_offset = idx + 1;
            if builder.is_full() {
                flush(&client, &mut builder, &mut checkpoint, cli, &name, next_offset, &mut stats)?;
            }
            if cli.limit.is_some_and(|limit| stats.tweets >= limit) {
                break;
            }
        }
        // Flush at the file boundary so offsets never describe a half-acked file.
        if !builder.is_empty() {
            flush(&client, &mut builder, &mut checkpoint, cli, &name, next_offset, &mut stats)?;
        }
        if cli.limit.is_some_and(|limit| stats.tweets >= limit) {
            eprintln!("limit {} reached; stopping (checkpoint resumes here)", cli.limit.unwrap());
            break;
        }
    }

    let secs = started.elapsed().as_secs_f64().max(1e-9);
    eprintln!(
        "backfill done: {} tweets, {} authors, {} batches, {} quarantined, {:.0} tweets/s",
        stats.tweets, stats.authors, stats.batches, stats.quarantined, stats.tweets as f64 / secs
    );
    Ok(())
}

#[derive(Default)]
struct Stats {
    tweets: u64,
    authors: u64,
    batches: u64,
    quarantined: u64,
}

#[allow(clippy::too_many_arguments)]
fn flush(
    client: &ConvexClient,
    builder: &mut BatchBuilder,
    checkpoint: &mut Checkpoint,
    cli: &Cli,
    file: &str,
    next_offset: u64,
    stats: &mut Stats,
) -> Result<()> {
    let batch = builder.take_batch();
    let ack = client.ingest_batch(&batch)?;
    stats.batches += 1;
    checkpoint.offsets.insert(file.to_string(), next_offset);
    checkpoint.store(&cli.checkpoint)?; // AFTER the ack — crash-resume without dupes/gaps
    eprintln!(
        "batch {}: {} tweets ({} inserted, {} updated, {} skipped), {} authors, {} df terms — {file}:{next_offset}",
        stats.batches,
        batch.tweets.len(),
        ack.inserted,
        ack.updated,
        ack.skipped,
        batch.authors.len(),
        batch.df_deltas.len()
    );
    Ok(())
}

/// serde is the parser; the INGRESS §5 sanity gates run on top of it.
fn parse_and_gate(line: &str) -> std::result::Result<IngressRecord, String> {
    let record: IngressRecord =
        serde_json::from_str(line).map_err(|e| format!("parse: {e}"))?;
    if let IngressRecord::Tweet(t) = &record {
        if t.text.trim().is_empty() {
            return Err("gate: empty text".to_string());
        }
        let now_plus = now_ms() + 5 * 60 * 1000;
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
    writeln!(f, "{}", serde_json::json!({ "reason": reason, "line": line }))?;
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
    let stopwords: HashSet<String> = stopwords_json["stopwords"]
        .as_array()
        .context("stopwords.json: missing stopwords array")?
        .iter()
        .filter_map(|s| s.as_str().map(String::from))
        .collect();

    let aspects_json: serde_json::Value = serde_json::from_str(&aspects_raw)?;
    let mut aspects = std::collections::HashMap::new();
    for (name, entry) in aspects_json["aspects"]
        .as_object()
        .context("aspects.json: missing aspects object")?
    {
        let list = |key: &str| -> Vec<String> {
            entry[key]
                .as_array()
                .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        aspects.insert(name.clone(), (list("strong"), list("weak")));
    }

    let engagement_weights = (1.0, 2.0, 3.0, 4.0); // like, reply, rt, quote (DESIGN §6.1)
    let bucket_count: u16 = 256;
    let params = format!(
        "tokenizerVersion={TOKENIZER_VERSION};weights={engagement_weights:?};buckets={bucket_count};recency={RECENCY_EPOCH_MS},{RECENCY_PER_DAY},{RECENCY_MAX_DAYS};scoreMax={SCORE_MAX}"
    );
    let config_hash = format!(
        "fnv1a64:{:016x}",
        fnv1a64(&[params.as_bytes(), stopwords_raw.as_bytes(), aspects_raw.as_bytes()])
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
    let mut hash: u64 = 0xcbf29ce484222325;
    for part in parts {
        for &byte in *part {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

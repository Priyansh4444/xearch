//! CLI shell — all I/O lives here (files, HTTP, clock); logic in lib modules.
//! Three modes per DESIGN §12.2. Failure policy: malformed line -> quarantine file
//! + counter, never crash the loop, never drop silently.

use clap::{Parser, Subcommand};

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
    // Shared setup: load config (lexicons + weights), compute config_hash,
    // ConvexClient::from_env(), Checkpoint::load().
    //
    // Backfill/Tail loop sketch (O1 ordering is the whole point):
    //   for each file, from checkpointed offset:
    //     parse line -> IngressRecord (fail -> quarantine + counter)
    //     BatchBuilder::push_*
    //     when builder.is_full():
    //       ack = client.ingest_batch(&builder.finish())   // atomic server-side
    //       checkpoint.offsets[file] = line_no + 1; checkpoint.store()  // AFTER ack
    //       log counters: tweets/s, postings/s, retries, checkpoint age, quarantined
    //
    // Refresh sketch: scan corpus snapshot -> propagate_boosts + tweepcred ->
    //   client.apply_metrics / client.upsert_authority in bounded chunks.
    match cli.mode {
        Mode::Backfill => todo!("backfill loop"),
        Mode::Tail => todo!("tail loop"),
        Mode::Refresh => todo!("refresh jobs"),
    }
}

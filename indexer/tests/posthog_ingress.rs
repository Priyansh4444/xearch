//! Offline cross-runtime contract checks. No database or HTTP server.
#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use xearch_indexer::model::IngressRecord;

static NEXT_STATE: AtomicU64 = AtomicU64::new(0);

fn stage_fixture(fixture: &str) -> Vec<IngressRecord> {
    let version = Command::new("node")
        .arg("--version")
        .output()
        .expect("Node must be installed");
    let version_text = String::from_utf8_lossy(&version.stdout);
    assert!(
        version.status.success() && node_major(&version_text) >= 24,
        "Node >= 24 required; got {version_text}"
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("indexer package has a parent directory");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after unix epoch")
        .as_nanos();
    let state = std::env::temp_dir().join(format!(
        "xearch-posthog-{}-{}-{}",
        std::process::id(),
        nanos,
        NEXT_STATE.fetch_add(1, Ordering::Relaxed)
    ));
    let output = Command::new("node")
        .current_dir(root)
        .args(["apps/posthog-export/cli.mjs", "stage", fixture])
        .arg(&state)
        .output()
        .expect("Node must be installed");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stage CLI prints JSON");
    assert_eq!(report["quarantineCount"], 0);
    let batch = report["batch"]
        .as_str()
        .expect("stage report includes batch id");
    let directory = report["directory"]
        .as_str()
        .expect("stage report includes directory");
    let file = Path::new(directory)
        .join("ingress")
        .join(format!("{batch}.jsonl"));
    let data = fs::read_to_string(file).expect("staged ingress jsonl exists");
    assert!(!data.contains("distinct_id"));
    assert!(!data.contains("phc_fixture"));
    let records = data
        .lines()
        .map(|line| serde_json::from_str(line).expect("ingress line is valid JSON"))
        .collect();
    fs::remove_dir_all(state).expect("temporary stage directory is removable");
    records
}

fn node_major(version: &str) -> u32 {
    version
        .trim()
        .strip_prefix('v')
        .and_then(|rest| rest.split('.').next())
        .and_then(|major| major.parse().ok())
        .unwrap_or(0)
}

#[test]
fn staged_posthog_records_deserialize_with_real_ingress_model() {
    let records = stage_fixture("apps/posthog-export/fixtures/capture-v1.jsonl");
    assert_eq!(records.len(), 2);
    assert!(matches!(records[0], IngressRecord::Author(_)));
    match &records[1] {
        IngressRecord::Tweet(tweet) => {
            assert_eq!(tweet.created_at, 1_700_000_000_000);
            assert_eq!(tweet.author_id, "42");
        }
        IngressRecord::Author(_) => panic!("expected tweet"),
    }
}

#[test]
fn native_xmd_producer_fixture_maps_media_metrics_authors_and_quotes() {
    let records = stage_fixture("apps/posthog-export/fixtures/producer-v1-full.jsonl");
    assert_eq!(records.len(), 4);
    for (record, id, handle, name, followers, following) in [
        (&records[0], "12345", "example", "Example", 120, 25),
        (&records[1], "54321", "quoted", "Quoted Author", 55, 15),
    ] {
        match record {
            IngressRecord::Author(author) => {
                assert_eq!(author.id, id);
                assert_eq!(author.handle, handle);
                assert_eq!(author.display_name, name);
                assert_eq!(author.follower_count, followers);
                assert_eq!(author.following_count, following);
                assert!(!author.verified);
                assert_eq!(author.created_at, 1_704_067_200_000);
            }
            IngressRecord::Tweet(_) => panic!("expected author"),
        }
    }
    let post = records
        .iter()
        .find_map(|r| match r {
            IngressRecord::Tweet(t) if t.id == "1234567890123456789" => Some(t),
            IngressRecord::Tweet(_) | IngressRecord::Author(_) => None,
        })
        .expect("producer fixture includes the primary tweet");
    assert_eq!(post.author_id, "12345");
    assert_eq!(post.created_at, 1_788_739_200_000);
    assert_eq!(post.metrics_at, 1_788_739_200_000);
    assert_eq!(post.metrics.likes, 10);
    assert_eq!(post.metrics.quotes, 1);
    assert_eq!(post.media.len(), 1);
    assert_eq!(post.media[0].url, "https://pbs.twimg.com/media/example.jpg");
    assert_eq!(post.quoted_tweet_id.as_deref(), Some("1234567890123456788"));
}

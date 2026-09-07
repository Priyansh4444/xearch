//! Offline cross-runtime contract checks. No database or HTTP server.
use std::{fs, path::Path, process::Command, time::{SystemTime, UNIX_EPOCH}};
use xearch_indexer::model::IngressRecord;

fn stage_fixture(fixture: &str) -> Vec<IngressRecord> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let state = std::env::temp_dir().join(format!("xearch-posthog-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let output = Command::new("node")
        .current_dir(root)
        .args(["apps/posthog-export/cli.mjs", "stage", fixture])
        .arg(&state).output().expect("Node 24 must be installed");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["quarantineCount"], 0);
    let file = Path::new(report["directory"].as_str().unwrap()).join("ingress").join(format!("{}.jsonl", report["batch"].as_str().unwrap()));
    let data = fs::read_to_string(file).unwrap();
    assert!(!data.contains("distinct_id"));
    assert!(!data.contains("phc_fixture"));
    let records = data.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    fs::remove_dir_all(state).unwrap();
    records
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
        _ => panic!("expected tweet"),
    }
}

#[test]
fn native_xmd_producer_fixture_maps_media_metrics_authors_and_quotes() {
    let records = stage_fixture("apps/posthog-export/fixtures/producer-v1-full.jsonl");
    assert_eq!(records.len(), 4);
    assert!(matches!(records[0], IngressRecord::Author(_)));
    assert!(matches!(records[1], IngressRecord::Author(_)));
    let post = records.iter().find_map(|r| match r {
        IngressRecord::Tweet(t) if t.id == "1234567890123456789" => Some(t),
        _ => None,
    }).unwrap();
    assert_eq!(post.author_id, "12345");
    assert_eq!(post.created_at, 1_788_739_200_000);
    assert_eq!(post.metrics_at, 1_788_739_200_000);
    assert_eq!(post.metrics.likes, 10);
    assert_eq!(post.metrics.quotes, 1);
    assert_eq!(post.media.len(), 1);
    assert_eq!(post.media[0].url, "https://pbs.twimg.com/media/example.jpg");
    assert_eq!(post.quoted_tweet_id.as_deref(), Some("1234567890123456788"));
}

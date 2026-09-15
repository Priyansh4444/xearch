use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn ingest_tweets_offline_accepts_loose_json_and_emits_bigrams() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let fixture = Fixture(
        manifest
            .join("target")
            .join(format!("ingest-tweets-{nonce}")),
    );
    let data = fixture.0.join("data");
    let out = fixture.0.join("batches");
    let quarantine = fixture.0.join("quarantine");
    let checkpoint = fixture.0.join("checkpoint.json");
    fs::create_dir_all(&data).unwrap();
    fs::write(
        data.join("tweets.jsonl"),
        r#"{"kind":"author","id":"100","handle":"seed","displayName":"Seed","followerCount":1,"followingCount":1,"verified":false,"createdAt":1476321484000}
{"kind":"tweet","id":"1001","text":"apple tree","authorId":"100","createdAt":1700090000000,"metrics":{"likes":1,"retweets":0,"quotes":0,"replies":0},"metricsAt":1700090000000,"media":[],"quotedTweetId":null,"retweetOfTweetId":null,"inReplyToTweetId":null}
{"type":"status","id":"1002","text":"loose pear tree","created_timestamp":1700090000,"likes":0,"author":{"id":"100","screen_name":"seed","name":"Seed"}}
"#,
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_xearch-indexer"))
        .args(["--lexicons"])
        .arg(manifest.join("../shared/lexicons"))
        .args(["--checkpoint"])
        .arg(&checkpoint)
        .args(["--quarantine"])
        .arg(&quarantine)
        .arg("ingest-tweets")
        .arg("--out-dir")
        .arg(&out)
        .arg(data.join("tweets.jsonl"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut files: Vec<_> = fs::read_dir(&out)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    files.sort();
    assert_eq!(files.len(), 1);
    let batch: Value = serde_json::from_str(&fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert_eq!(batch["tweets"].as_array().unwrap().len(), 2);
    let terms: Vec<&str> = batch["tweets"][0]["postings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["term"].as_str())
        .collect();
    assert!(terms.contains(&"apple"));
    assert!(terms.contains(&"tree"));
    assert!(terms.contains(&"\u{0002}apple\u{0002}tree"));
}

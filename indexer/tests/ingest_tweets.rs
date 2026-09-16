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

#[test]
fn ingest_tweets_checkpoints_same_basename_files_separately() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let fixture = Fixture(
        manifest
            .join("target")
            .join(format!("ingest-tweets-basename-{nonce}")),
    );
    let dir_a = fixture.0.join("a");
    let dir_b = fixture.0.join("b");
    fs::create_dir_all(&dir_a).unwrap();
    fs::create_dir_all(&dir_b).unwrap();
    let record = |id: &str, text: &str| {
        format!(
            r#"{{"kind":"author","id":"200","handle":"seed","displayName":"Seed","followerCount":1,"followingCount":1,"verified":false,"createdAt":1476321484000}}
{{"kind":"tweet","id":"{id}","text":"{text}","authorId":"200","createdAt":1700090000000,"metrics":{{"likes":0,"retweets":0,"quotes":0,"replies":0}},"metricsAt":1700090000000,"media":[],"quotedTweetId":null,"retweetOfTweetId":null,"inReplyToTweetId":null}}
"#
        )
    };
    fs::write(dir_a.join("tweets.jsonl"), record("3001", "alpha")).unwrap();
    fs::write(dir_b.join("tweets.jsonl"), record("3002", "beta")).unwrap();
    let checkpoint = fixture.0.join("checkpoint.json");

    let run = |out: &std::path::Path| {
        Command::new(env!("CARGO_BIN_EXE_xearch-indexer"))
            .args(["--lexicons"])
            .arg(manifest.join("../shared/lexicons"))
            .args(["--checkpoint"])
            .arg(&checkpoint)
            .args(["--quarantine"])
            .arg(fixture.0.join("q"))
            .arg("ingest-tweets")
            .arg("--out-dir")
            .arg(out)
            .arg(dir_a.join("tweets.jsonl"))
            .arg(dir_b.join("tweets.jsonl"))
            .output()
            .unwrap()
    };

    let first = run(&fixture.0.join("first"));
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let count = |dir: &std::path::Path| -> usize {
        fs::read_dir(dir).map_or(0, |entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .map(|path| {
                    let batch: Value =
                        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
                    batch["tweets"].as_array().unwrap().len()
                })
                .sum()
        })
    };
    // Both files were read: the basename key used to make the second one resume
    // from the first file's offset and skip its only record.
    assert_eq!(count(&fixture.0.join("first")), 2);

    // Resume with the same checkpoint: both files are fully acked, nothing new.
    let second = run(&fixture.0.join("second"));
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(count(&fixture.0.join("second")), 0);
}

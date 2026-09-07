use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use xearch_indexer::checkpoint::Checkpoint;

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rejected_and_blank_suffix_is_checkpointed_without_a_batch() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let fixture = Fixture(manifest.join("target").join(format!("backfill-{nonce}")));
    let data = fixture.0.join("data");
    let quarantine = fixture.0.join("quarantine");
    let checkpoint = fixture.0.join("checkpoint.json");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("rows.jsonl"), "malformed\n\n").unwrap();

    let run = || {
        Command::new(env!("CARGO_BIN_EXE_xearch-indexer"))
            .args(["--data-dir"]).arg(&data)
            .args(["--checkpoint"]).arg(&checkpoint)
            .args(["--quarantine"]).arg(&quarantine)
            .args(["--lexicons"]).arg(manifest.join("../shared/lexicons"))
            .arg("backfill")
            // No valid records means no network requests should be made.
            .env("CONVEX_URL", "http://127.0.0.1:9")
            .env("CONVEX_DEPLOY_KEY", "unused-test-value")
            .output()
            .unwrap()
    };
    let first = run();
    assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));
    assert_eq!(Checkpoint::load(&checkpoint).unwrap().offsets["rows.jsonl"], 2);
    let rejected = fs::read(quarantine.join("rows.jsonl")).unwrap();
    let second = run();
    assert!(second.status.success(), "{}", String::from_utf8_lossy(&second.stderr));
    assert_eq!(fs::read(quarantine.join("rows.jsonl")).unwrap(), rejected);
    assert_eq!(Checkpoint::load(&checkpoint).unwrap().offsets["rows.jsonl"], 2);
}

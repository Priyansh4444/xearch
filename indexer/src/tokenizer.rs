//! Tokenizer twin A (Rust). Twin B: convex/engine/tokenize.ts. The rules are the
//! spec (DESIGN §12.2, tokenizerVersion 1); shared/fixtures/tokenizer-golden.jsonl
//! is the judge — `cargo test golden` must pass whenever the TS suite passes.
//! Any divergence is a red test, never a silent recall bug (RISKS T1).

use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

pub const TOKENIZER_VERSION: u32 = 1;

#[derive(Debug, Default)]
pub struct Tokenized {
    pub tokens: Vec<String>,
    pub counts: HashMap<String, u32>,
    pub has_link: bool,
}

pub fn tokenize(raw: &str, stopwords: &std::collections::HashSet<String>) -> Tokenized {
    // Mirrors tokenize.ts step-for-step:
    // 1. NFKC + lowercase.
    let text: String = raw.nfkc().collect::<String>().to_lowercase();
    // 2. URL strip -> has_link.
    let (text, has_link) = strip_urls(&text);
    // 3. Scan runs: prefix tokens (#,@,$ + dual emit), CJK bigrams, emoji runs,
    //    word runs (letters/digits/_/inner apostrophe).
    // 4. Stopword drop; counts.
    // TODO(implement): port the scanner loop from tokenize.ts. Keep the branch
    // ORDER identical — it is observable behavior ("$99" vs "$tsla").
    let _ = (text, has_link, stopwords);
    todo!("port scanner loop from convex/engine/tokenize.ts");
}

fn strip_urls(text: &str) -> (String, bool) {
    // (?:https?://|www\.)\S+  — keep regex-free: scan for the two prefixes and
    // consume to whitespace, replacing with a single space. Same observable
    // behavior as the TS regex against the golden fixture.
    // TODO(implement)
    todo!("strip_urls")
}

/// CJK run -> overlapping bigrams (RISKS T2). Exposed for unit tests.
pub fn cjk_bigrams(run: &[char]) -> Vec<String> {
    if run.len() == 1 {
        return vec![run[0].to_string()];
    }
    run.windows(2).map(|w| w.iter().collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct GoldenCase {
        text: String,
        tokens: Vec<String>,
        #[serde(rename = "hasLink")]
        has_link: bool,
    }

    /// The parity gate. Loads the shared fixture; every case must match exactly.
    #[test]
    fn golden() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/fixtures/tokenizer-golden.jsonl"
        );
        let data = std::fs::read_to_string(path).expect("fixture exists");
        let stop: std::collections::HashSet<String> = load_stopwords();
        for line in data.lines().filter(|l| !l.trim().is_empty()) {
            let case: GoldenCase = serde_json::from_str(line).expect("valid fixture line");
            let got = tokenize(&case.text, &stop);
            assert_eq!(got.tokens, case.tokens, "text: {}", case.text);
            assert_eq!(got.has_link, case.has_link, "text: {}", case.text);
        }
    }

    fn load_stopwords() -> std::collections::HashSet<String> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/lexicons/stopwords.json"
        );
        let data = std::fs::read_to_string(path).expect("stopwords exist");
        let v: serde_json::Value = serde_json::from_str(&data).unwrap();
        v["stopwords"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    }
}

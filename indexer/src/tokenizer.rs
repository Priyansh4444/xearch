//! Tokenizer twin A (Rust). Twin B: convex/engine/tokenize.ts. The rules are the
//! spec (DESIGN §12.2, tokenizerVersion 1); shared/fixtures/tokenizer-golden.jsonl
//! is the judge — `cargo test golden` must pass whenever the TS suite passes.
//! Any divergence is a red test, never a silent recall bug (RISKS T1).

use crate::extended_pictographic::EXTENDED_PICTOGRAPHIC;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

pub const TOKENIZER_VERSION: u32 = 1;

// Regenerate extended_pictographic.rs (when Node's Unicode tables move) with:
//   node -e 'const re=/\p{Extended_Pictographic}/u; const r=[]; let s=-1;
//     for (let cp=0; cp<=0x10FFFF; cp++){const m=re.test(String.fromCodePoint(cp));
//       if(m&&s<0)s=cp; if(!m&&s>=0){r.push([s,cp-1]);s=-1;}}
//     if(s>=0)r.push([s,0x10FFFF]);
//     console.log(r.map(([a,b])=>`(0x${a.toString(16)}, 0x${b.toString(16)}),`).join("\n"))'
// Generating from Node keeps twin A byte-identical to the regex twin B runs.

fn is_emoji(c: char) -> bool {
    let cp = c as u32;
    EXTENDED_PICTOGRAPHIC
        .binary_search_by(|&(lo, hi)| {
            if cp < lo {
                std::cmp::Ordering::Greater
            } else if cp > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_cjk(c: char) -> bool {
    // Mirrors CJK_RE in tokenize.ts (Hiragana/Katakana, Han ext-A, Han, compat, Hangul).
    matches!(c as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af)
}

fn is_word(c: char) -> bool {
    // Mirrors WORD_RE [\p{L}\p{N}_]: Rust's is_alphabetic/is_numeric are exactly
    // the L* / N* general categories.
    c.is_alphabetic() || c.is_numeric() || c == '_'
}

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
    //    word runs (letters/digits/_/inner apostrophe). Branch ORDER matches
    //    tokenize.ts — it is observable behavior ("$99" vs "$tsla").
    // 4. Stopword drop; counts.
    let chars: Vec<char> = text.chars().collect();
    let mut tokens: Vec<String> = Vec::new();
    let mut push = |t: String| {
        if !t.is_empty() && !stopwords.contains(&t) {
            tokens.push(t);
        }
    };

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '#' || c == '@' || c == '$' {
            let (run, next) = take_word_run(&chars, i + 1);
            if run.is_empty() {
                i += 1;
                continue;
            }
            let is_numeric = run.chars().all(|ch| ch.is_numeric());
            if c == '$' && is_numeric {
                push(run); // "$99" -> "99"; the ~price aspect is the aspect emitter's job
            } else {
                push(format!("{c}{run}"));
                push(run);
            }
            i = next;
        } else if is_cjk(c) {
            let (run, next) = take_run(&chars, i, is_cjk);
            for bg in cjk_bigrams(&run) {
                push(bg);
            }
            i = next;
        } else if is_emoji(c) {
            let (run, next) = take_run(&chars, i, is_emoji);
            for e in dedupe_preserving_order(&run) {
                push(e.to_string());
            }
            i = next;
        } else if is_word(c) {
            let (run, next) = take_word_run(&chars, i);
            push(run);
            i = next;
        } else {
            i += 1;
        }
    }

    let mut counts: HashMap<String, u32> = HashMap::new();
    for t in &tokens {
        *counts.entry(t.clone()).or_insert(0) += 1;
    }
    Tokenized { tokens, counts, has_link }
}

/// Word run: letters/digits/underscore plus apostrophe when flanked by word chars.
/// Mirrors takeWordRun in tokenize.ts, including the CJK exclusion and the
/// "next char is any word char (CJK included)" apostrophe look-ahead.
fn take_word_run(chars: &[char], start: usize) -> (String, usize) {
    let mut i = start;
    let mut out = String::new();
    while i < chars.len() {
        let c = chars[i];
        if is_word(c) && !is_cjk(c) {
            out.push(c);
            i += 1;
        } else if (c == '\'' || c == '\u{2019}')
            && !out.is_empty()
            && i + 1 < chars.len()
            && is_word(chars[i + 1])
        {
            out.push('\''); // normalize curly apostrophe
            i += 1;
        } else {
            break;
        }
    }
    (out, i)
}

fn take_run(chars: &[char], start: usize, pred: fn(char) -> bool) -> (Vec<char>, usize) {
    let mut i = start;
    let mut out = Vec::new();
    while i < chars.len() && pred(chars[i]) {
        out.push(chars[i]);
        i += 1;
    }
    (out, i)
}

fn dedupe_preserving_order(run: &[char]) -> Vec<char> {
    let mut seen = std::collections::HashSet::new();
    run.iter().copied().filter(|c| seen.insert(*c)).collect()
}

/// (?:https?://|www\.)\S+ replaced by a single space — regex-free scan with the
/// same observable behavior as the TS regex: a prefix match can start mid-token
/// ("foohttps://x" strips from the prefix on) and consumes to whitespace.
fn strip_urls(text: &str) -> (String, bool) {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut has_link = false;
    let mut i = 0;
    while i < chars.len() {
        let m = ["https://", "http://", "www."]
            .iter()
            .any(|p| chars[i..].starts_with(&p.chars().collect::<Vec<_>>()[..]));
        if m {
            has_link = true;
            while i < chars.len() && !chars[i].is_whitespace() {
                i += 1;
            }
            out.push(' ');
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    (out, has_link)
}

/// CJK run -> overlapping bigrams (RISKS T2). Exposed for unit tests.
pub fn cjk_bigrams(run: &[char]) -> Vec<String> {
    if run.is_empty() {
        return Vec::new();
    }
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

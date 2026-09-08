//! Tokenizer twin A (Rust).
//!
//! Twin B: convex/engine/tokenize.ts. The rules are the
//! spec (DESIGN §12.2, tokenizerVersion 1); shared/fixtures/tokenizer-golden.jsonl
//! is the judge — `cargo test golden` must pass whenever the TS suite passes.
//! Any divergence is a red test, never a silent recall bug (RISKS T1).

use crate::extended_pictographic::EXTENDED_PICTOGRAPHIC;
use std::collections::HashMap;
use unicode_general_category::{get_general_category, GeneralCategory};
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
    let cp = u32::from(c);
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

const fn is_cjk(c: char) -> bool {
    // Mirrors CJK_RE in tokenize.ts (Hiragana/Katakana, Han ext-A, Han, compat, Hangul).
    matches!(c,
        '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}' | '\u{ac00}'..='\u{d7af}')
}

fn is_word(c: char) -> bool {
    // Mirrors WORD_RE [\p{L}\p{N}_]. `is_alphabetic` includes Other_Alphabetic
    // marks that JavaScript's Unicode general-category `L` does not include.
    let category = get_general_category(c);
    matches!(
        category,
        GeneralCategory::UppercaseLetter
            | GeneralCategory::LowercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
    ) || c.is_numeric()
        || c == '_'
}

#[derive(Debug, Default)]
pub struct Tokenized {
    pub tokens: Vec<String>,
    pub counts: HashMap<String, u32>,
    pub has_link: bool,
}

pub fn tokenize<S: std::hash::BuildHasher>(
    raw: &str,
    stopwords: &std::collections::HashSet<String, S>,
) -> Tokenized {
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

    let mut i = 0_usize;
    while let Some(&c) = chars.get(i) {
        if c == '#' || c == '@' || c == '$' {
            let (run, next) = take_word_run(&chars, i.saturating_add(1));
            if run.is_empty() {
                i = i.saturating_add(1);
                continue;
            }
            let is_numeric = run.chars().all(char::is_numeric);
            if c != '$' || !is_numeric {
                push(format!("{c}{run}"));
            }
            push(run); // "$99" -> "99"; other prefixes also emit the bare term.
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
            i = i.saturating_add(1);
        }
    }

    let mut counts: HashMap<String, u32> = HashMap::new();
    for t in &tokens {
        let count = counts.entry(t.clone()).or_insert(0);
        *count = count.saturating_add(1);
    }
    Tokenized {
        tokens,
        counts,
        has_link,
    }
}

/// Word run: letters/digits/underscore plus apostrophe when flanked by word chars.
/// Mirrors takeWordRun in tokenize.ts, including the CJK exclusion and the
/// "next char is any word char (CJK included)" apostrophe look-ahead.
fn take_word_run(chars: &[char], start: usize) -> (String, usize) {
    let mut i = start;
    let mut out = String::new();
    while let Some(&c) = chars.get(i) {
        if is_word(c) && !is_cjk(c) {
            out.push(c);
            i = i.saturating_add(1);
        } else if (c == '\'' || c == '\u{2019}')
            && !out.is_empty()
            && chars
                .get(i.saturating_add(1))
                .is_some_and(|&next| is_word(next))
        {
            out.push('\''); // normalize curly apostrophe
            i = i.saturating_add(1);
        } else {
            break;
        }
    }
    (out, i)
}

fn take_run(chars: &[char], start: usize, pred: fn(char) -> bool) -> (Vec<char>, usize) {
    let mut i = start;
    let mut out = Vec::new();
    while let Some(&c) = chars.get(i).filter(|&&c| pred(c)) {
        out.push(c);
        i = i.saturating_add(1);
    }
    (out, i)
}

fn dedupe_preserving_order(run: &[char]) -> Vec<char> {
    let mut seen = std::collections::HashSet::new();
    run.iter().copied().filter(|c| seen.insert(*c)).collect()
}

/// (?:https?://|www\.)\S+ replaced by a single space — regex-free scan with the
/// same observable behavior as the TS regex: a prefix match can start mid-token
/// ("<foohttps://x>" strips from the prefix on) and consumes to whitespace.
fn strip_urls(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let mut has_link = false;
    let mut chars = text.char_indices().peekable();
    while let Some((offset, ch)) = chars.next() {
        // char_indices produces UTF-8 boundaries. Borrow the suffix instead of
        // allocating three prefix vectors for every character in the input.
        let suffix = text.get(offset..).unwrap_or_default();
        let is_url = suffix.starts_with("https://")
            || suffix.starts_with("http://")
            || suffix.starts_with("www.");
        if is_url {
            has_link = true;
            while chars.peek().is_some_and(|(_, next)| !next.is_whitespace()) {
                chars.next();
            }
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    (out, has_link)
}

/// CJK run -> overlapping bigrams (RISKS T2). Exposed for unit tests.
#[must_use]
pub fn cjk_bigrams(run: &[char]) -> Vec<String> {
    if let [single] = run {
        return vec![single.to_string()];
    }
    run.windows(2).map(|w| w.iter().collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_scan_preserves_boundaries_and_unicode() {
        for (input, expected, has_link) in [
            ("caféhttps://x.test/path fin", "café  fin", true),
            ("https://x.test\nwww.example.test", " \n ", true),
            ("日本語 🚀 https://x.test", "日本語 🚀  ", true),
            ("http:// www. https://", "     ", true),
            ("no links here", "no links here", false),
        ] {
            assert_eq!(strip_urls(input), (expected.to_owned(), has_link));
        }
    }

    #[test]
    fn word_predicate_matches_unicode_general_category_l() {
        let stopwords = std::collections::HashSet::new();
        assert_eq!(tokenize("का", &stopwords).tokens, vec!["क"]);
    }

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

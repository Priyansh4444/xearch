// Tokenizer twin B (TypeScript). Twin A lives in indexer/src/tokenizer.rs.
// THE RULES ARE THE SPEC (DESIGN §12.2) and the fixture is the judge:
// shared/fixtures/tokenizer-golden.jsonl runs against BOTH twins in CI.
// Change behavior here => update the fixture => fix the Rust twin. Never skip a leg.
//
// Rules (tokenizerVersion = 1):
//   1. NFKC normalize, then lowercase.
//   2. Strip URLs (https?://\S+ | www.\S+) => hasLink flag, never tokens.
//   3. Scan tokens:
//      - word chars: Unicode letters/digits, underscore, inner apostrophe.
//      - prefixes # @ $ bind to a following letter-run: emit prefixed token AND
//        bare word ("#convex" -> "#convex","convex"). "$"+digits: bare number
//        only (the ~price aspect is the aspect emitter's job, not ours).
//      - CJK runs (Han/Hiragana/Katakana/Hangul): overlapping bigrams (RISKS T2).
//      - extended-pictographic runs: one token per emoji sequence, deduped per run.
//      - everything else splits.
//   4. Drop stopwords (shared/lexicons/stopwords.json).

import stopwordsFile from "../../shared/lexicons/stopwords.json";
import type { Term } from "../contracts/ids";

export const TOKENIZER_VERSION = 1;

const STOP = new Set<string>(stopwordsFile.stopwords);
const URL_RE = /(?:https?:\/\/|www\.)\S+/g;
const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const WORD_RE = /[\p{L}\p{N}_]/u;

export interface Tokenized {
  /** Index-order tokens, stopwords removed, duals expanded. */
  tokens: Term[];
  /** term -> tf over `tokens`. */
  counts: Map<Term, number>;
  hasLink: boolean;
}

export function tokenize(raw: string, keepStopwords = false): Tokenized {
  const lowered = raw.normalize("NFKC").toLowerCase();
  // String replacement, not a replacer closure: one fewer function object per
  // call, and no captured `hasLink` cell. Every URL match is ≥4 chars
  // (`www.` is the shortest prefix) collapsing to one space, so a shorter
  // result means exactly "at least one link was stripped" — no second scan.
  const text = lowered.replace(URL_RE, " ");
  const hasLink = text.length !== lowered.length;

  const tokens: Term[] = [];
  const chars = Array.from(text); // code points, not UTF-16 units
  let i = 0;

  while (i < chars.length) {
    const c = chars[i]!;
    if (c === "#" || c === "@" || c === "$") {
      const [run, next] = takeWordRun(chars, i + 1);
      if (run.length === 0) {
        i += 1;
        continue;
      }
      const isNumeric = /^\p{N}+$/u.test(run);
      if (c === "$" && isNumeric) {
        pushToken(tokens, keepStopwords, run); // "$99" -> "99"; aspect emitter sees the "$"+digits pattern itself
      } else {
        pushToken(tokens, keepStopwords, c + run);
        pushToken(tokens, keepStopwords, run);
      }
      i = next;
    } else if (CJK_RE.test(c)) {
      const [run, next] = takeRun(chars, i, isCjkChar);
      for (const bg of cjkBigrams(run)) pushToken(tokens, keepStopwords, bg);
      i = next;
    } else if (EMOJI_RE.test(c)) {
      const [run, next] = takeRun(chars, i, isEmojiChar);
      for (const e of dedupePreservingOrder(Array.from(run))) pushToken(tokens, keepStopwords, e);
      i = next;
    } else if (WORD_RE.test(c)) {
      const [run, next] = takeWordRun(chars, i);
      pushToken(tokens, keepStopwords, run);
      i = next;
    } else {
      i += 1;
    }
  }

  const counts = new Map<Term, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { tokens, counts, hasLink };
}

/** Module-level emitter: the per-call `push` closure it replaces allocated a
 * function object plus context on every tokenize() call (~220/query through
 * constraint checks and PRF mining). Plain calls monomorphize and inline. */
function pushToken(tokens: Term[], keepStopwords: boolean, t: string): void {
  // The tokenizer is THE producer of the Term space: this cast seals it.
  if (t.length > 0 && (keepStopwords || !STOP.has(t))) tokens.push(t as Term);
}

function isCjkChar(c: string): boolean {
  return CJK_RE.test(c);
}

function isEmojiChar(c: string): boolean {
  return EMOJI_RE.test(c);
}

/** Word run: letters/digits/underscore plus apostrophe when flanked by word chars. */
function takeWordRun(chars: string[], start: number): [string, number] {
  let i = start;
  let out = "";
  while (i < chars.length) {
    const c = chars[i]!;
    if (WORD_RE.test(c) && !CJK_RE.test(c)) {
      out += c;
      i += 1;
    } else if (
      (c === "'" || c === "\u2019") &&
      out.length > 0 &&
      i + 1 < chars.length &&
      WORD_RE.test(chars[i + 1]!)
    ) {
      out += "'"; // normalize curly apostrophe
      i += 1;
    } else break;
  }
  return [out, i];
}

function takeRun(
  chars: string[],
  start: number,
  pred: (c: string) => boolean,
): [string, number] {
  let i = start;
  let out = "";
  while (i < chars.length && pred(chars[i]!)) {
    out += chars[i]!;
    i += 1;
  }
  return [out, i];
}

function cjkBigrams(run: string): string[] {
  const cs = Array.from(run);
  if (cs.length === 1) return [cs[0]!];
  const out: string[] = [];
  for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i]! + cs[i + 1]!);
  return out;
}

function dedupePreservingOrder(xs: string[]): string[] {
  return [...new Set(xs)];
}

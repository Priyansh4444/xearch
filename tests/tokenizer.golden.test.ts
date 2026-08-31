// Parity gate, TS leg (Rust leg: indexer/src/tokenizer.rs `golden` test).
// Both suites read the same fixture; a divergence anywhere is a red test (RISKS T1).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "../convex/engine/tokenize";

interface GoldenCase {
  text: string;
  tokens: string[];
  hasLink: boolean;
  note: string;
}

const fixture = readFileSync(
  join(__dirname, "../shared/fixtures/tokenizer-golden.jsonl"),
  "utf8",
);

describe("tokenizer golden parity", () => {
  for (const line of fixture.split("\n").filter((l) => l.trim().length > 0)) {
    const c = JSON.parse(line) as GoldenCase;
    it(c.note, () => {
      const got = tokenize(c.text);
      expect(got.tokens).toEqual(c.tokens);
      expect(got.hasLink).toBe(c.hasLink);
    });
  }
});

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = readFileSync("apps/collector/scripts/pull-run.sh", "utf8");
const verifier = script.split("<<'VERIFY'\n")[1]!.split("\nVERIFY")[0]!;

const GOOD = "{}\n";

function digestOf(content: string): { bytes: number; sha256: string } {
  return {
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function writeDir(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "xearch-pull-"));
  mkdirSync(join(dir, "ingress"), { recursive: true });
  setup(dir);
  return dir;
}

function verify(dir: string): number {
  return spawnSync(process.execPath, ["-", dir], { input: verifier, encoding: "utf8" }).status ?? 1;
}

function manifest(files: Array<{ path: string; bytes: number; sha256: string }>): string {
  return JSON.stringify({ runId: "test", archive: { files } });
}

describe("pull verification", () => {
  it.each([
    { name: "manifest order", files: ["report.json", "ingress/records.jsonl"] },
    { name: "reversed manifest order", files: ["ingress/records.jsonl", "report.json"] },
  ])("accepts an intact pull ($name)", ({ files }) => {
    const dir = writeDir((d) => {
      writeFileSync(
        join(d, "manifest.json"),
        manifest(files.map((path) => ({ path, ...digestOf(GOOD) }))),
      );
      writeFileSync(join(d, "report.json"), GOOD);
      writeFileSync(join(d, "ingress/records.jsonl"), GOOD);
    });
    try {
      expect(verify(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "missing ingress file on disk",
      setup: (d: string) => {
        writeFileSync(
          join(d, "manifest.json"),
          manifest([
            { path: "report.json", ...digestOf(GOOD) },
            { path: "ingress/records.jsonl", ...digestOf(GOOD) },
          ]),
        );
        writeFileSync(join(d, "report.json"), GOOD);
      },
    },
    {
      name: "corrupt ingress content",
      setup: (d: string) => {
        writeFileSync(
          join(d, "manifest.json"),
          manifest([
            { path: "report.json", ...digestOf(GOOD) },
            { path: "ingress/records.jsonl", ...digestOf(GOOD) },
          ]),
        );
        writeFileSync(join(d, "report.json"), GOOD);
        writeFileSync(join(d, "ingress/records.jsonl"), "corrupt");
      },
    },
    {
      name: "same-length corrupt content (sha mismatch, bytes match)",
      setup: (d: string) => {
        writeFileSync(
          join(d, "manifest.json"),
          manifest([
            { path: "report.json", ...digestOf(GOOD) },
            { path: "ingress/records.jsonl", ...digestOf(GOOD) },
          ]),
        );
        writeFileSync(join(d, "report.json"), GOOD);
        writeFileSync(join(d, "ingress/records.jsonl"), "abc\n");
      },
    },
    {
      name: "manifest missing the required ingress digest",
      setup: (d: string) => {
        writeFileSync(
          join(d, "manifest.json"),
          manifest([{ path: "report.json", ...digestOf(GOOD) }]),
        );
        writeFileSync(join(d, "report.json"), GOOD);
        writeFileSync(join(d, "ingress/records.jsonl"), GOOD);
      },
    },
    {
      name: "manifest with no archive digests",
      setup: (d: string) => {
        writeFileSync(join(d, "manifest.json"), JSON.stringify({ runId: "test" }));
        writeFileSync(join(d, "report.json"), GOOD);
        writeFileSync(join(d, "ingress/records.jsonl"), GOOD);
      },
    },
  ])("rejects $name", ({ setup }) => {
    const dir = writeDir(setup);
    try {
      expect(verify(dir)).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates manifest entries for unpulled extra files (partial pulls)", () => {
    // Partial pulls are the point of the script: listed files with nothing on
    // disk are skipped, not failed.
    const dir = writeDir((d) => {
      writeFileSync(
        join(d, "manifest.json"),
        manifest([
          { path: "report.json", ...digestOf(GOOD) },
          { path: "ingress/records.jsonl", ...digestOf(GOOD) },
          { path: "raw/1/000001.json", ...digestOf(GOOD) },
        ]),
      );
      writeFileSync(join(d, "report.json"), GOOD);
      writeFileSync(join(d, "ingress/records.jsonl"), GOOD);
    });
    try {
      expect(verify(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

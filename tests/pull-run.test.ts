import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const script = readFileSync("apps/collector/scripts/pull-run.sh", "utf8");
const verifier = script.split("<<'VERIFY'\n")[1]!.split("\nVERIFY")[0]!;

test("pull verification requires ingress and rejects corrupt data", () => {
  const dir = mkdtempSync(join(tmpdir(), "xearch-pull-"));
  try {
    mkdirSync(join(dir, "ingress"));
    const files = ["report.json", "ingress/records.jsonl"].map((path) => ({
      path, bytes: 3, sha256: createHash("sha256").update("{}\n").digest("hex"),
    }));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ runId: "test", archive: { files } }));
    writeFileSync(join(dir, "report.json"), "{}\n");
    function verify() {
      return spawnSync(process.execPath, ["-", dir], { input: verifier, encoding: "utf8" });
    }
    expect(verify().status).not.toBe(0);
    writeFileSync(join(dir, "ingress/records.jsonl"), "{}\n");
    expect(verify().status).toBe(0);
    writeFileSync(join(dir, "ingress/records.jsonl"), "corrupt");
    expect(verify().status).not.toBe(0);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      runId: "test", archive: { files: files.filter((file) => file.path === "report.json") },
    }));
    expect(verify().status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

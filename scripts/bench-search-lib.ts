export function positiveInteger(text: string): number {
  if (!/^[1-9]\d*$/.test(text)) throw new Error("Expected a positive integer.");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error("Expected a safe integer.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return Object.fromEntries(Object.entries(value));
}

export function parseQueries(value: unknown) {
  const fixture = record(value);
  if (!Array.isArray(fixture["queries"]) || fixture["queries"].length === 0)
    throw new Error("Expected nonempty queries.");
  return fixture["queries"].map((item: unknown) => {
    const query = record(item);
    const raw = query["raw"];
    const minResults = query["minResults"] ?? 0;
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      typeof minResults !== "number" ||
      !Number.isInteger(minResults) ||
      minResults < 0
    )
      throw new Error("Invalid query fixture.");
    return { raw, minResults };
  });
}

export function validateResponse(value: unknown) {
  const envelope = record(value);
  if (envelope["status"] !== "success") throw new Error("Convex query failed.");
  const response = record(envelope["value"]);
  const error = response["error"];
  const ladder = response["ladder"];
  const queryKey = response["queryKey"];
  if (
    (error !== null && typeof error !== "string") ||
    typeof ladder !== "string" ||
    typeof queryKey !== "string" ||
    !Array.isArray(response["results"])
  )
    throw new Error("Invalid search response.");
  const ids = response["results"].map((item: unknown) => {
    const result = record(item);
    const id = result["tweetId"];
    if (typeof id !== "string") throw new Error("Missing source tweet ID.");
    return id;
  });
  return { error, ladder, queryKey, ids, refined: response["refined"] ?? null };
}

// Nearest-rank percentiles of observed samples, not a population estimate.
export function summarize(samples: number[]) {
  if (samples.length === 0) return null;
  if (samples.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid latency.");
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), minMs: sorted[0], maxMs: at(1) };
}

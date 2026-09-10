import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { Option } from "effect";
import * as Schema from "effect/Schema";
import { queryInputError } from "./engine/constraints";
import { tierA } from "./engine/parse";

const UNAVAILABLE =
  "AI interpretation is not enabled. The deployment needs an approved provider, sign-in and request quotas. Literal search is available without AI.";

export type Interpretation =
  | { status: "ready"; query: string }
  | { status: "unavailable" | "error"; message: string };

const ModelOutputSchema = Schema.Struct({
  query: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(240),
    Schema.isPattern(/^[\p{L}\p{N}_\s]+$/u),
  ),
});

const ProviderResponseSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
    }),
  ).check(Schema.isMinLength(1)),
});

/** Only explicit UI requests reach this boundary. No provider calls or writes. */
export const request = action({
  args: { raw: v.string() },
  handler: async (_ctx, { raw }): Promise<Interpretation> => ({
    status: "unavailable" as const,
    message: queryInputError(raw) ?? UNAVAILABLE,
  }),
});

/**
 * Treat model output as plain search words, never executable query syntax.
 * Original phrases, negations and operators survive verbatim. Tier A alone is
 * deliberate: no entity linking, spelling repair or natural-language heuristics.
 */
export function safeInterpretedQuery(raw: string, output: unknown): string | null {
  const decoded = Schema.decodeUnknownOption(ModelOutputSchema)(output);
  if (Option.isNone(decoded) || decoded.value.query.trim() === "") return null;
  const words = decoded.value.query;
  const preserved = Object.keys(tierA(raw).trace.consumed);
  const query = [words.trim(), ...preserved].join(" ");
  return queryInputError(query) === null ? query : null;
}

/** Trusted operator only until the public authorization/quota policy is approved. */
export const preview = internalAction({
  args: { raw: v.string() },
  handler: async (_ctx, { raw }) => {
    const invalid = queryInputError(raw);
    if (invalid !== null || raw.trim() === "") {
      return { status: "error" as const, message: invalid ?? "Enter a query." };
    }
    const url = process.env["TIERC_LLM_URL"];
    const model = process.env["TIERC_LLM_MODEL"];
    const key = process.env["TIERC_LLM_KEY"];
    if (
      url === undefined ||
      url === "" ||
      model === undefined ||
      model === "" ||
      key === undefined ||
      key === ""
    ) {
      return { status: "unavailable" as const, message: UNAVAILABLE };
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 120,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                'Interpret a post-search request as a concise literal keyword query. Return only {"query":"words"}. Never answer the question. Use only letters, digits, underscores and spaces. No operators, filters or invented facts. Keep names as written. Correct only unmistakable typos; leave ambiguous words unchanged. Explicit operators are preserved separately by the caller.',
            },
            { role: "user", content: raw },
          ],
        }),
      });
      if (!response.ok)
        return { status: "error" as const, message: "Interpretation provider failed." };
      const body = Schema.decodeUnknownOption(ProviderResponseSchema)(await response.json());
      if (Option.isNone(body)) {
        return { status: "error" as const, message: "Invalid interpretation response." };
      }
      const parsed = JSON.parse(body.value.choices[0]!.message.content);
      const query = safeInterpretedQuery(raw, parsed);
      return query === null
        ? {
            status: "error" as const,
            message: "The model proposed an unsafe or empty query. Keep the original search.",
          }
        : { status: "ready" as const, query };
    } catch {
      return {
        status: "error" as const,
        message: "Interpretation failed or timed out. Keep the original search.",
      };
    }
  },
});

// Tier C: the LLM semantic layer (DESIGN §4.4, docs/PARSER.md §3–4).
// An action (network I/O), table-mediated: writes queryCache; the reactive search
// query picks the refinement up automatically. Single writer per normalizedRaw.

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { tierA, tierB } from "./engine/parse";
import { tokenize } from "./engine/tokenize";
import {
  canonicalJson,
  isEpochMs,
  mergeRefinement,
  normalizeRaw,
  parseXQueryJson,
  XQUERY_VERSION,
  type XQuery,
} from "./engine/xquery";
import { queryInputError } from "./engine/constraints";
import { tierBDeps } from "./search";
import type { Term } from "./contracts/ids";
import aspectsFile from "../shared/lexicons/aspects.json";

// Provider: any OpenAI-compatible chat-completions endpoint, selected by env vars
// on the DEPLOYMENT (never in the repo — set via `npx convex env set`):
//   TIERC_LLM_URL    e.g. https://api.openai.com/v1/chat/completions
//   TIERC_LLM_MODEL  e.g. gpt-4o-mini (any JSON-schema-mode small model)
//   TIERC_LLM_KEY    bearer token
// Hosted model now, llama.cpp+GBNF later — same schema (DESIGN §4.4).

const ASPECT_ENUM = Object.keys(aspectsFile.aspects);
const INTENT_ENUM = ["topic", "person", "person_topic", "media", "question", "compare", "event"];

/** PARSER §3.2, verbatim starting point. Versioned: bump with any behavior change. */
export const TIERC_PROMPT_VERSION = 1;
const SYSTEM_PROMPT = `You convert ONE tweet-search request into the XQuery JSON schema provided.
Rules, in priority order:
1. NEVER change slots already present in \`parsedSoFar\` — they came from explicit
   operators. You only fill empty slots.
2. Terms in \`must\` gate results. Put a term there only if a tweet NOT containing
   it (or a synonym) is useless to this user. Everything else → \`should\`.
3. Strip glue ("tweets about", "show me", "that thread where"). Glue words never
   appear in must/should.
4. People: if the request names an account, put the LITERAL name in
   \`entityCandidates\` — you never emit authorId numbers; the caller resolves ids.
5. Dates: resolve relative expressions against \`now\` (provided), as epoch
   milliseconds. Event names you recognize with high confidence (e.g. "openai
   board drama") → date window; if unsure, leave null and put the event words in must.
6. \`paraphrases\`: 2–5 alternative phrasings a DIFFERENT person would tweet-search;
   vary vocabulary, not word order.
7. \`hyde\`: write the single most plausible tweet that would satisfy the request.
   No hashtag spam, ≤280 chars.
8. Unknown attribute words (cheap-like, fast-like…) → \`newAspectWords\` with the
   closest aspect from the enum.
Output ONLY the JSON object.`;

/** PARSER §3.3 few-shots (two shipped; grow toward 6–8 with the eval set). */
const FEW_SHOTS: { role: "user" | "assistant"; content: string }[] = [
  {
    role: "user",
    content: JSON.stringify({
      raw: "that girl who reviews mechanical keyboards and hates loud switches",
      parsedSoFar: {
        must: ["girl", "reviews", "mechanical", "keyboards", "hates", "loud", "switches"],
      },
    }),
  },
  {
    role: "assistant",
    content: JSON.stringify({
      xq: {
        intent: "person_topic",
        must: ["mechanical", "keyboards"],
        should: ["switches", "clicky", "review", "quiet"],
        phrases: [],
        exclude: [],
        aspects: ["~opinion"],
        filters: { since: null, until: null, media: null, minLikes: null, lang: null },
      },
      entityCandidates: [],
      paraphrases: [
        "mechanical keyboard reviewer quiet switches",
        "keyboard reviews loud clicky switches bad",
      ],
      hyde: "hot take after a week with these blues: if your switches wake the baby, they're not a personality",
      newAspectWords: [{ word: "loud", aspect: "~spec" }],
    }),
  },
  {
    role: "user",
    content: JSON.stringify({
      raw: "what did karpathy say about llm agents",
      parsedSoFar: { must: ["karpathy", "llm", "agents"], intent: "question" },
    }),
  },
  {
    role: "assistant",
    content: JSON.stringify({
      xq: {
        intent: "question",
        must: ["llm", "agents"],
        should: ["agentic", "autonomy", "eval"],
        phrases: [],
        exclude: [],
        aspects: ["~opinion"],
        filters: { since: null, until: null, media: null, minLikes: null, lang: null },
      },
      entityCandidates: ["karpathy"],
      paraphrases: ["karpathy on llm agents", "karpathy take on ai agents"],
      hyde: "LLM agents are autocomplete with a todo list — the interesting part is the feedback loop, not the loop",
      newAspectWords: [],
    }),
  },
];

/** PARSER §3.1 structured-output schema — closed enums make invalid values unrepresentable. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["xq", "entityCandidates", "paraphrases", "hyde", "newAspectWords"],
  properties: {
    xq: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "must", "should", "phrases", "exclude", "aspects", "filters"],
      properties: {
        intent: { type: "string", enum: INTENT_ENUM },
        must: { type: "array", items: { type: "string" } },
        should: { type: "array", items: { type: "string" } },
        phrases: { type: "array", items: { type: "array", items: { type: "string" } } },
        exclude: { type: "array", items: { type: "string" } },
        aspects: { type: "array", items: { type: "string", enum: ASPECT_ENUM } },
        filters: {
          type: "object",
          additionalProperties: false,
          required: ["since", "until", "media", "minLikes", "lang"],
          properties: {
            since: { type: ["integer", "null"] },
            until: { type: ["integer", "null"] },
            media: { type: ["string", "null"], enum: ["image", "video", "gif", null] },
            minLikes: { type: ["integer", "null"] },
            lang: { type: ["string", "null"] },
          },
        },
      },
    },
    entityCandidates: { type: "array", items: { type: "string" } },
    paraphrases: { type: "array", items: { type: "string" } },
    hyde: { type: "string" },
    newAspectWords: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["word", "aspect"],
        properties: {
          word: { type: "string" },
          aspect: { type: "string", enum: ASPECT_ENUM },
        },
      },
    },
  },
} as const;

interface TierCOutput {
  xq: {
    intent: string;
    must: string[];
    should: string[];
    phrases: string[][];
    exclude: string[];
    aspects: string[];
    filters: {
      since: number | null;
      until: number | null;
      media: string | null;
      minLikes: number | null;
      lang: string | null;
    };
  };
  entityCandidates: string[];
  paraphrases: string[];
  hyde: string;
  newAspectWords: { word: string; aspect: string }[];
}

/** Model words → tokenizer-normalized terms (the IR invariant — PARSER §1). */
function termsOf(words: unknown, max: number): Term[] {
  if (!Array.isArray(words)) return [];
  const out: Term[] = [];
  for (const word of words) {
    if (typeof word !== "string") continue;
    for (const token of tokenize(word).tokens) {
      if (!out.includes(token) && out.length < max) out.push(token);
    }
  }
  return out;
}

/**
 * Trigger contract (PARSER §4): run after a search whose trace shows non-glue
 * leftovers AND prose shape, or explicitly via "didn't find it?". Internal-only
 * until production auth/quotas exist (TODO P0) — invoke via CLI/dashboard or a
 * trusted scheduler, never straight from anonymous clients.
 * Idempotent: a cache hit returns immediately without calling the model.
 * On ANY failure: write nothing — A+B results stand (PARSER §5, P5/P2).
 */
export const refine = internalAction({
  args: { raw: v.string() },
  handler: async (ctx, { raw }) => {
    const inputError = queryInputError(raw);
    if (inputError !== null) return { status: "invalid" as const, error: inputError };
    const normalized = normalizeRaw(raw);
    if (normalized.length === 0) return { status: "invalid" as const, error: "Empty query." };

    // 1. Cache check — each phrasing pays the LLM cost once ever (DESIGN §4.4).
    const cached = await ctx.runQuery(internal.tierC.getCache, { normalizedRaw: normalized });
    if (cached !== null && cached.lexiconVersion === aspectsFile.version) {
      return { status: "cached" as const };
    }

    const url = process.env["TIERC_LLM_URL"];
    const model = process.env["TIERC_LLM_MODEL"];
    const key = process.env["TIERC_LLM_KEY"];
    if (url === undefined || model === undefined || key === undefined) {
      return {
        status: "skipped" as const,
        reason: "Set TIERC_LLM_URL, TIERC_LLM_MODEL and TIERC_LLM_KEY on the deployment.",
      };
    }

    // 2. A+B parse — the slots the model may only fill, never override.
    const parsedSoFar = await ctx.runQuery(internal.tierC.parseAB, { raw });
    const base = parseXQueryJson(parsedSoFar.xqueryJson);
    if (base === null) throw new Error("A+B parse failed canonical validation");
    const now = Date.now();

    // 3. Provider call, JSON-schema constrained (PARSER §3.1–3.3).
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...FEW_SHOTS,
          {
            role: "user",
            content: JSON.stringify({
              raw,
              parsedSoFar: base,
              now,
              lexiconVersion: aspectsFile.version,
              aspects: ASPECT_ENUM,
            }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "xearch_tierc", strict: true, schema: OUTPUT_SCHEMA },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Tier C provider error ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Tier C provider returned no content");
    const out = JSON.parse(content) as TierCOutput;

    // 4. Entity strings → authorId, resolved locally with the dominance rule
    //    (PARSER §3.2 rule 4) — only when A+B left the slot empty.
    let authorId: string | null = null;
    if (base.filters.authorId === null && Array.isArray(out.entityCandidates)) {
      authorId = await ctx.runQuery(internal.tierC.resolveEntityCandidates, {
        candidates: out.entityCandidates.filter((c) => typeof c === "string").slice(0, 3),
      });
    }

    // 5. Rebuild + validate through the same codec cache rows pass at read time.
    //    Terms are re-normalized through the tokenizer twin; a slot the model got
    //    wrong degrades to unset instead of poisoning the whole refinement.
    const f = out.xq?.filters;
    const candidate: XQuery = {
      v: XQUERY_VERSION,
      intent: (INTENT_ENUM.includes(out.xq?.intent)
        ? out.xq.intent
        : base.intent) as XQuery["intent"],
      must: termsOf(out.xq?.must, 12),
      should: termsOf(out.xq?.should, 12),
      phrases: (Array.isArray(out.xq?.phrases) ? out.xq.phrases : [])
        .filter((p): p is string[] => Array.isArray(p))
        .map((p) => tokenize(p.join(" "), true).tokens)
        .filter((p) => p.length > 0)
        .slice(0, 4),
      exclude: termsOf(out.xq?.exclude, 12),
      aspects: (Array.isArray(out.xq?.aspects) ? out.xq.aspects : []).filter((a) =>
        ASPECT_ENUM.includes(a),
      ) as XQuery["aspects"],
      filters: {
        authorId: authorId as XQuery["filters"]["authorId"],
        since: isEpochMs(f?.since) ? f.since : null,
        until: isEpochMs(f?.until) ? f.until : null,
        media: (["image", "video", "gif"] as const).find((m) => m === f?.media) ?? null,
        minLikes:
          typeof f?.minLikes === "number" && Number.isSafeInteger(f.minLikes) && f.minLikes > 0
            ? f.minLikes
            : null,
        lang: typeof f?.lang === "string" && /^[a-z]{2}$/.test(f.lang) ? f.lang : null,
      },
      sort: base.sort, // sort is user-owned; the model never sets it
    };
    const refined = parseXQueryJson(JSON.stringify(candidate));
    if (refined === null) throw new Error("Tier C output failed validation; wrote nothing");
    const merge = mergeRefinement(base, refined);

    // 6. Aspect-lexicon harvest (DESIGN §4.6): logged for review, merged into
    //    shared/lexicons/aspects.json by humans — never applied live.
    const aspectWords = (Array.isArray(out.newAspectWords) ? out.newAspectWords : []).filter(
      (w) => typeof w?.word === "string" && ASPECT_ENUM.includes(w?.aspect),
    );
    if (aspectWords.length > 0) {
      console.log(`[tierC] aspect harvest ${JSON.stringify({ raw: normalized, aspectWords })}`);
    }

    await ctx.runMutation(internal.tierC.putCache, {
      normalizedRaw: normalized,
      xqueryJson: canonicalJson(refined),
      paraphrases: (Array.isArray(out.paraphrases) ? out.paraphrases : [])
        .filter((p) => typeof p === "string")
        .slice(0, 5)
        .map((p) => p.slice(0, 120)),
      ...(typeof out.hyde === "string" && out.hyde.length > 0
        ? { hyde: out.hyde.slice(0, 280) }
        : {}),
      source: "llm" as const,
      lexiconVersion: aspectsFile.version,
    });
    return { status: "written" as const, filled: merge.filled, overridden: merge.overridden };
  },
});

/** "Report bad parse": busts the cache row and logs the case for the eval set
 * (harvest `[tierC] bad parse` log lines into shared/fixtures/parser-golden.jsonl). */
export const reportBadParse = internalAction({
  args: { raw: v.string() },
  handler: async (ctx, { raw }): Promise<{ deleted: boolean }> => {
    const normalized = normalizeRaw(raw);
    const deleted: boolean = await ctx.runMutation(internal.tierC.deleteCache, {
      normalizedRaw: normalized,
    });
    console.warn(`[tierC] bad parse reported ${JSON.stringify({ raw: normalized, deleted })}`);
    return { deleted };
  },
});

// ——— table plumbing (single writer per normalizedRaw: this module) ———

export const getCache = internalQuery({
  args: { normalizedRaw: v.string() },
  handler: (ctx, { normalizedRaw }) =>
    ctx.db
      .query("queryCache")
      .withIndex("by_raw", (q) => q.eq("normalizedRaw", normalizedRaw))
      .unique(),
});

/** A+B parse behind a query so the action shares search's exact deps (ctx.db). */
export const parseAB = internalQuery({
  args: { raw: v.string() },
  handler: async (ctx, { raw }) => {
    const parsed = await tierB(tierA(raw), tierBDeps(ctx));
    return { xqueryJson: canonicalJson(parsed.xq), leftover: parsed.trace.leftover };
  },
});

/** First candidate that resolves under the dominance rule wins (≤6 point reads). */
export const resolveEntityCandidates = internalQuery({
  args: { candidates: v.array(v.string()) },
  handler: async (ctx, { candidates }) => {
    const deps = tierBDeps(ctx);
    for (const candidate of candidates.slice(0, 3)) {
      const tokens = tokenize(candidate).tokens;
      // Joined form first ("Theo Browne" → theobrowne), then single tokens.
      const probes = tokens.length > 1 ? [tokens, ...tokens.map((t) => [t])] : [tokens];
      for (const ngram of probes.slice(0, 2)) {
        const hit = await deps.resolveEntity(ngram);
        if (hit !== null) return hit.authorId as string;
      }
    }
    return null;
  },
});

export const putCache = internalMutation({
  args: {
    normalizedRaw: v.string(),
    xqueryJson: v.string(),
    paraphrases: v.array(v.string()),
    hyde: v.optional(v.string()),
    source: v.union(v.literal("llm"), v.literal("human-correction")),
    lexiconVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("queryCache")
      .withIndex("by_raw", (q) => q.eq("normalizedRaw", args.normalizedRaw))
      .unique();
    // A human correction outranks the model; only a newer correction replaces it.
    if (existing !== null && existing.source === "human-correction" && args.source === "llm") {
      return;
    }
    if (existing === null) await ctx.db.insert("queryCache", args);
    else await ctx.db.replace(existing._id, args);
  },
});

export const deleteCache = internalMutation({
  args: { normalizedRaw: v.string() },
  handler: async (ctx, { normalizedRaw }) => {
    const existing = await ctx.db
      .query("queryCache")
      .withIndex("by_raw", (q) => q.eq("normalizedRaw", normalizedRaw))
      .unique();
    if (existing === null) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});

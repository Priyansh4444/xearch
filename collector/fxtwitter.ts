const DEFAULT_BASE_URL = "https://api.fxtwitter.com";

export interface FxTwitterCursor {
  top: string | null;
  bottom: string | null;
}

export interface FxTwitterTimelinePage {
  code: number;
  results: unknown[];
  cursor: FxTwitterCursor;
}

export interface TimelineRequest {
  handle: string;
  count: number;
  cursor: string | null;
  withReplies: boolean;
}

export interface TimelineResponse {
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  raw: unknown;
  page: FxTwitterTimelinePage | null;
}

export interface TimelineClient {
  fetchTimelinePage(request: TimelineRequest): Promise<TimelineResponse>;
}

export interface FxTwitterClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export class FxTwitterError extends Error {
  readonly status: number | null;
  readonly responseBody: string | null;

  constructor(
    message: string,
    status: number | null,
    responseBody: string | null,
  ) {
    super(message);
    this.name = "FxTwitterError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class FxTwitterClient implements TimelineClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: FxTwitterClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async fetchTimelinePage(request: TimelineRequest): Promise<TimelineResponse> {
    const url = new URL(
      `${this.baseUrl}/2/profile/${encodeURIComponent(request.handle)}/statuses`,
    );
    url.searchParams.set("count", String(request.count));
    if (request.cursor !== null) url.searchParams.set("cursor", request.cursor);
    if (request.withReplies) url.searchParams.set("with_replies", "true");

    const startedAt = performance.now();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            accept: "application/json",
            "user-agent": "xearch-collection-probe/0.1",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 204) {
          return {
            httpStatus: response.status,
            latencyMs: performance.now() - startedAt,
            attempts: attempt,
            raw: null,
            page: null,
          };
        }

        const bodyText = await response.text();
        if (!response.ok) {
          const error = new FxTwitterError(
            `FxTwitter returned HTTP ${response.status}`,
            response.status,
            bodyText,
          );
          if (isRetryableStatus(response.status) && attempt <= this.retries) {
            await this.sleep(retryDelayMs(response, attempt, this.retryBaseDelayMs));
            lastError = error;
            continue;
          }
          throw error;
        }
        const parsed = parseJson(bodyText);

        return {
          httpStatus: response.status,
          latencyMs: performance.now() - startedAt,
          attempts: attempt,
          raw: parsed,
          page: parseTimelinePage(parsed),
        };
      } catch (error) {
        if (error instanceof FxTwitterError) throw error;
        lastError = error;
        if (attempt > this.retries) break;
        await this.sleep(exponentialDelayMs(attempt, this.retryBaseDelayMs));
      }
    }

    throw new FxTwitterError(
      `FxTwitter request failed after ${this.retries + 1} attempts: ${errorMessage(lastError)}`,
      null,
      null,
    );
  }
}

function parseTimelinePage(value: unknown): FxTwitterTimelinePage {
  if (!isRecord(value)) {
    throw new FxTwitterError("FxTwitter timeline response is not an object", 200, null);
  }
  if (!Number.isFinite(value.code) || !Array.isArray(value.results) || !isRecord(value.cursor)) {
    throw new FxTwitterError(
      "FxTwitter timeline response does not match the documented envelope",
      200,
      JSON.stringify(value),
    );
  }

  return {
    code: value.code as number,
    results: value.results,
    cursor: {
      top: nullableString(value.cursor.top, "cursor.top"),
      bottom: nullableString(value.cursor.bottom, "cursor.bottom"),
    },
  };
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new FxTwitterError(`FxTwitter ${field} is not a string or null`, 200, null);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FxTwitterError("FxTwitter returned invalid JSON", 200, body);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return exponentialDelayMs(attempt, baseDelayMs);
}

function exponentialDelayMs(attempt: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

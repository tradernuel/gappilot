/**
 * Minimal OpenAI Responses API client (POST /v1/responses), fetch-based.
 * Request/response field names checked against openai@7.23.0's type definitions.
 */
export class OpenAiError extends Error {
  constructor(
    readonly kind: "http" | "timeout" | "network" | "empty" | "parse",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

interface ResponsesApiOutputItem {
  type?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

export async function createResponse(args: {
  apiKey: string;
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Structured output: the model must return JSON matching this schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}): Promise<{ text: string; model: string }> {
  const f = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({
        model: args.model,
        instructions: args.instructions,
        input: args.input,
        max_output_tokens: args.maxOutputTokens,
        store: false,
        ...(args.jsonSchema
          ? { text: { format: { type: "json_schema", name: args.jsonSchema.name, schema: args.jsonSchema.schema, strict: true } } }
          : {}),
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new OpenAiError(timeout ? "timeout" : "network", timeout ? `OpenAI timed out after ${args.timeoutMs} ms` : "OpenAI request failed");
  }

  const bodyText = await res.text();
  if (!res.ok) {
    let msg = `OpenAI returned HTTP ${res.status}`;
    try {
      const err = JSON.parse(bodyText) as { error?: { message?: string } };
      if (err.error?.message) msg += `: ${err.error.message.slice(0, 200)}`;
    } catch {
      /* not JSON */
    }
    throw new OpenAiError("http", msg, res.status);
  }

  let json: { model?: string; output?: ResponsesApiOutputItem[] };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new OpenAiError("parse", "OpenAI returned non-JSON");
  }
  const parts = (json.output ?? [])
    .filter((i) => i.type === "message")
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text!);
  const text = parts.join("").trim();
  if (!text) throw new OpenAiError("empty", "OpenAI returned no text (refusal or token limit)");
  return { text, model: json.model ?? args.model };
}

import Anthropic from "@anthropic-ai/sdk";
import { COMPACTOR_MODEL } from "./constants.ts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string | any[];
}

/** One compactor call. `content` is the assistant turn, to echo back unchanged. */
export interface Model {
  ask(system: string, turns: ChatTurn[]): Promise<{ text: string; content: any[] }>;
}

/** A failure that will repeat identically on every retry (a refusal, a 400, max_tokens, an empty reply). */
export class PermanentError extends Error {
  readonly permanent = true;
}

/** Running totals of compactor token use, for `optchat status`. */
export const usage = {
  calls: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  add(u: any) {
    if (!u) return;
    this.calls++;
    this.input += u.input_tokens ?? 0;
    this.cacheRead += u.cache_read_input_tokens ?? 0;
    this.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.output += u.output_tokens ?? 0;
  },
};

/**
 * Claude Sonnet 5.5, medium effort, through the API key (not the subscription:
 * the compactor needs exact cache control and must not stop at a usage limit).
 * Thinking is left at its default (adaptive); thinking blocks are echoed back
 * unchanged in retries, and are never logged.
 */
export class AnthropicModel implements Model {
  /** Server-side refusal fallbacks. Turned off for good if the API rejects them. */
  fallbacks = process.env.OPTCHAT_FALLBACKS !== "0";

  constructor(
    private client: Anthropic,
    private model = COMPACTOR_MODEL,
    private effort: "low" | "medium" | "high" = "medium",
  ) {}

  async ask(system: string, turns: ChatTurn[]): Promise<{ text: string; content: any[] }> {
    const params: any = {
      model: this.model,
      max_tokens: 16_000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: turns,
      output_config: { effort: this.effort },
    };
    // Decide by what THIS request was sent with, not by the live flag: 8 calls run at once,
    // and a sibling may already have turned fallbacks off.
    const used = this.fallbacks;
    let res: any;
    try {
      res = used
        ? await this.client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as any)
        : await this.client.messages.create(params);
    } catch (e: any) {
      if (e instanceof Anthropic.BadRequestError) {
        if (used && /fallback/i.test(e.message)) {
          if (this.fallbacks) {
            this.fallbacks = false;
            console.error(`compactor: API rejected fallbacks (${e.message}); continuing without`);
          }
          return this.ask(system, turns);
        }
        throw Object.assign(new PermanentError(`API rejected the request: ${e.message}`), { cause: e });
      }
      throw e;
    }
    usage.add(res.usage); // refused and truncated calls are billed too
    switch (res.stop_reason) {
      case "refusal":
        throw new PermanentError(`refused (${res.stop_details?.category ?? "unknown"})`);
      case "max_tokens":
        throw new PermanentError("compactor hit max_tokens");
      case "model_context_window_exceeded":
        throw new PermanentError("the context is too long for the compactor model");
      case "pause_turn":
        throw new Error("the API paused the turn");
    }
    // Text before a fallback block is the declining model's partial output: only what follows is the answer.
    const blocks: any[] = res.content;
    let from = 0;
    blocks.forEach((b, k) => b.type === "fallback" && (from = k + 1));
    const text = blocks
      .slice(from)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, content: res.content };
  }
}

/**
 * Development stand-in for the compactor: no API calls. Its "summary" is the
 * start of the text it was asked to compress. Never use it on a real chat:
 * the lines are far worse than a model's.
 */
export class TruncModel implements Model {
  async ask(_system: string, turns: ChatTurn[]): Promise<{ text: string; content: any[] }> {
    const first = turns[0].content;
    const all = typeof first === "string" ? first : first.map((b: any) => b.text ?? "").join("");
    const body = all.split(/in at most \d+ bytes:\n/).pop() ?? all;
    const text = body.replace(/\s+/g, " ").trim().slice(0, 200) || "(empty)";
    return { text, content: [{ type: "text", text }] };
  }
}

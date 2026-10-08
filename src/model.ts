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
 * The compactor's model, through the API key (not the subscription: a compaction must not stop at a usage
 * limit). The system prompt is cached; the context and the task are the user turn.
 */
export class AnthropicModel implements Model {
  constructor(
    private client: Anthropic,
    private model = COMPACTOR_MODEL,
  ) {}

  async ask(system: string, turns: ChatTurn[]): Promise<{ text: string; content: any[] }> {
    let res: any;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: 16_000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: turns,
      } as any);
    } catch (e: any) {
      if (e instanceof Anthropic.BadRequestError) throw Object.assign(new PermanentError(`API rejected the request: ${e.message}`), { cause: e });
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
    const text = (res.content as any[])
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
    const input = /<input>\n([^]*?)\n<\/input>/.exec(all)?.[1] ?? all; // the task's <input> block
    const text = input.replace(/\s+/g, " ").trim().slice(0, 200) || "(empty)";
    return { text, content: [{ type: "text", text }] };
  }
}

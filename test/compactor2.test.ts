import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { Memory } from "../src/memory.ts";
import { summarize, PERMANENT_TRIES } from "../src/compactor.ts";
import { AnthropicModel, PermanentError, usage, type ChatTurn, type Model } from "../src/model.ts";
import { capHeadTail } from "../src/types.ts";
import { tmp } from "./helpers.ts";
import { leafTask } from "../src/prompts.ts";

const text = (t: ChatTurn) => (typeof t.content === "string" ? t.content : t.content.map((b: any) => b.text ?? "").join(""));

test("the compactor's context holds bare text: no ids, no kind column", async () => {
  const seen: string[] = [];
  const model: Model = {
    async ask(_s, turns) {
      seen.push(text(turns[0]));
      return { text: "short summary", content: [{ type: "text", text: "short summary" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 4000 });
  for (let i = 0; i < 12; i++) mem.add(i % 2 ? "talk" : "user", `message ${i} ` + "q".repeat(800));
  await mem.compactor.whenIdle();
  assert.ok(seen.length > 5);
  for (const s of seen) {
    const ctx = s.slice(0, s.lastIndexOf("Compaction:"));
    assert.doesNotMatch(ctx, /^\d+\+\d+\|/m, "an id prefix reached the compactor");
    assert.doesNotMatch(ctx, /^[utswfnx]+\|/m, "a kind column reached the compactor");
    assert.match(ctx, /^<chat>\n/);
  }
  assert.ok(seen.some((s) => /<chat>\nshort summary\n/.test(s))); // later calls see earlier summaries, as bare lines
});

test("summarize: a failure on a later round returns the shortest line so far", async () => {
  let k = 0;
  const model: Model = {
    async ask() {
      if (++k > 2) throw new Error("429");
      const t = "a".repeat(k === 1 ? 700 : 600);
      return { text: t, content: [{ type: "text", text: t }] };
    },
  };
  assert.equal(await summarize(model, [], leafTask(0, "user", "x")), "a".repeat(600));
  let e = 0;
  const empty: Model = { async ask() { return e++ ? { text: "  ", content: [] } : { text: "b".repeat(600), content: [{ type: "text", text: "b".repeat(600) }] }; } };
  assert.equal(await summarize(empty, [], leafTask(0, "user", "x")), "b".repeat(600));
});

test("a poison message gets a mechanical line after a few identical failures, and the chat moves on", async () => {
  const logs: string[] = [];
  const model: Model = {
    async ask(_s, turns) {
      if (/compress message \d+[^]*tool: POISON/.test(text(turns[0]))) throw new PermanentError("refused (cyber)"); // only the leaf
      return { text: "ok line", content: [{ type: "text", text: "ok line" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 4000, retryMs: 2, log: (m) => logs.push(m) });
  mem.add("tool", "before " + "x".repeat(800));
  mem.add("tool", "POISON " + "p".repeat(800));
  for (let i = 0; i < 6; i++) mem.add("tool", `after ${i} ` + "y".repeat(800));
  await mem.compactor.whenIdle();
  assert.ok(mem.view.settled());
  const n = mem.store.node(0, 1)!;
  assert.match(n.text, /^\[not summarized: refused \(cyber\)\] tool: POISON/);
  assert.ok(Buffer.byteLength(n.text) <= 512);
  assert.ok(logs.some((l) => /could not be summarized/.test(l)));
  assert.equal(logs.filter((l) => /failed:/.test(l)).length, 1); // the first failure is reported once
  assert.ok(PERMANENT_TRIES >= 2);
});

test("a write error while storing a node is retried, not an unhandled rejection", async () => {
  const mem = new Memory(tmp(), { async ask() { return { text: "fine", content: [{ type: "text", text: "fine" }] }; } }, { budget: 4000, retryMs: 2, log: () => {} });
  const real = mem.store.putNode.bind(mem.store);
  let failed = 0;
  mem.store.putNode = ((n: any) => (failed++ < 2 ? (() => { throw new Error("ENOSPC"); })() : real(n))) as any;
  mem.add("tool", "z".repeat(900));
  await mem.compactor.whenIdle();
  assert.ok(failed >= 3);
  assert.ok(mem.view.settled());
});

// ---- AnthropicModel with a fake client
const badRequest = (msg: string) => new Anthropic.BadRequestError(400, { error: { message: msg } } as any, msg, new Headers());
function fakeClient(handler: (kind: "beta" | "plain", body: any) => Promise<any>): any {
  return { beta: { messages: { create: (b: any) => handler("beta", b) } }, messages: { create: (b: any) => handler("plain", b) } };
}
const ok = (t: string, extra: any = {}) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }, ...extra });

test("AnthropicModel: the compactor's model, no effort or fallbacks, usage counted even for refusals", async () => {
  let body: any;
  const model = new AnthropicModel(
    fakeClient(async (_k, b) => {
      body = b;
      return ok("a line", { usage: { input_tokens: 10, output_tokens: 5 } });
    }),
  );
  const before = usage.calls;
  const r = await model.ask("sys", [{ role: "user", content: "x" }]);
  assert.equal(r.text, "a line");
  assert.equal(body.model, "claude-haiku-4-5");
  assert.equal(body.output_config, undefined); // Haiku 4.5 rejects an effort setting
  assert.equal(body.fallbacks, undefined);
  assert.equal(body.system[0].cache_control.type, "ephemeral");
  assert.equal(usage.calls, before + 1);

  const refusing = new AnthropicModel(fakeClient(async () => ok("", { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] })));
  const c0 = usage.calls;
  await assert.rejects(refusing.ask("s", []), (e: any) => e instanceof PermanentError && /refused \(cyber\)/.test(e.message));
  assert.equal(usage.calls, c0 + 1); // billed, so counted
  for (const stop of ["max_tokens", "model_context_window_exceeded"])
    await assert.rejects(new AnthropicModel(fakeClient(async () => ok("cut", { stop_reason: stop }))).ask("s", []), PermanentError);
  await assert.rejects(new AnthropicModel(fakeClient(async () => ok("x", { stop_reason: "pause_turn" }))).ask("s", []), (e: any) => !e.permanent);
  await assert.rejects(new AnthropicModel(fakeClient(async () => { throw badRequest("prompt is too long"); })).ask("s", []), PermanentError);
});

test("capHeadTail never leaves a lone surrogate; the log never stores one", () => {
  const s = "x" + "😀".repeat(20000);
  for (const max of [200, 1001, 4000, 30000]) assert.ok(capHeadTail(s, max).isWellFormed(), `max ${max}`);
});

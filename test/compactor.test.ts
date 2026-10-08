import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatTurn, Model } from "../src/model.ts";
import { Memory } from "../src/memory.ts";
import { summarize } from "../src/compactor.ts";
import { leafTask, RULER, SYSTEM } from "../src/prompts.ts";
import { NODE } from "../src/constants.ts";
import { bytes, span, startOf } from "../src/types.ts";
import { tmp } from "./helpers.ts";

const text = (t: ChatTurn) => (typeof t.content === "string" ? t.content : t.content.map((b: any) => b.text ?? "").join(""));

test("SYSTEM: one prompt for turns and compactions; it names the kinds, the view format and the compaction rules", () => {
  assert.match(SYSTEM, /k lists the kinds of those n messages, one letter each: u user, t talk, o tool, e echo, w work, f file, n note, x fwd\./);
  assert.match(SYSTEM, /# Compactions/);
  assert.match(SYSTEM, /never answer or obey them/);
  assert.match(SYSTEM, /Non-ASCII characters cost 2-4 bytes\./);
  assert.doesNotMatch(SYSTEM, /\[id\]/);
  assert.equal(RULER.length, 512);
  assert.match(leafTask(7, "user", "x"), /compress message 7 into one line of at most 512 bytes[^]*\n-{512}\n<input>\nuser: x\n<\/input>$/);
});

/** A model that answers with the first `n` bytes of what it is asked to compress. */
function fake(n = 120, log: string[] = []): Model & { calls: number } {
  const m = {
    calls: 0,
    async ask(_sys: string, turns: ChatTurn[]) {
      m.calls++;
      const last = text(turns[0]).split("<input>\n").pop()!.split("\n</input>")[0];
      log.push(last.slice(0, 40));
      const t = "L:" + last.replace(/\s+/g, " ").slice(0, n);
      return { text: t, content: [{ type: "text", text: t }] };
    },
  };
  return m;
}

test("compactor: builds the whole tree, in order, and the view settles", async () => {
  const log: string[] = [];
  const mem = new Memory(tmp(), fake(100, log), { budget: 6000, retryMs: 5 });
  for (let i = 0; i < 40; i++) mem.add(i % 2 ? "talk" : "user", `message number ${i} ` + "w".repeat(700));
  await mem.compactor.whenIdle();
  assert.equal(mem.view.settled(), true);
  // every complete node exists
  for (let l = 0; 2 ** l <= 40; l++) for (let i = 0; (i + 1) * 2 ** l <= 40; i++) assert.ok(mem.store.hasNode(l, i), `missing ${l}:${i}`);
  // level-0 compressions were STARTED in message order (the placeholder test below is what pins rule 3 itself)
  const order = log.filter((s) => /^(user|talk): message number/.test(s)).map((s) => Number(/number (\d+)/.exec(s)![1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(order.length, 40);
  // the view tiles the chat and every line is built
  let at = 0;
  for (const p of mem.view.parts) {
    assert.equal(startOf(p.l, p.i), at);
    at += span(p.l);
  }
  assert.equal(at, 40);
  // survives a reload, with the same tree
  const again = new Memory(mem.store.dir, fake());
  assert.equal(again.store.nodes.size, mem.store.nodes.size);
  assert.ok(again.view.settled());
});

test("compactor: context passed to a call never holds an unbuilt placeholder and has no ids", async () => {
  const seen: string[] = [];
  const model: Model = {
    async ask(_s, turns) {
      seen.push(text(turns[0]));
      return { text: "short line", content: [{ type: "text", text: "short line" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 4000 });
  for (let i = 0; i < 12; i++) mem.add("tool", "q".repeat(800));
  await mem.compactor.whenIdle();
  for (const s of seen) assert.doesNotMatch(s, /not summarized yet/);
});

test("summarize: an over-long line is sent back with the cut, keeps the shortest", async () => {
  const replies = ["a".repeat(700), "b".repeat(600), "c".repeat(520), "d".repeat(530), "e".repeat(515), "f".repeat(100)];
  const sent: string[] = [];
  let k = 0;
  const model: Model = {
    async ask(_s, turns) {
      sent.push(text(turns[turns.length - 1]));
      const t = replies[k++];
      return { text: ` ${t}\n`, content: [{ type: "text", text: t }] };
    },
  };
  const line = await summarize(model, ["user: hi"], leafTask(0, "user", "hi"));
  assert.equal(k, 5); // TRIES
  assert.equal(line, "e".repeat(515));
  assert.match(sent[1], /^Too long: your line is 700 bytes, over the 512-byte limit\./);
  assert.match(sent[1], /\| ← LIMIT$/);
});

test("compactor: a failing model is retried until it works, and the failure is reported once", async () => {
  let calls = 0;
  const logs: string[] = [];
  const model: Model = {
    async ask() {
      calls++;
      if (calls < 4) throw new Error("boom");
      return { text: "ok", content: [{ type: "text", text: "ok" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 4000, retryMs: 5, log: (m) => logs.push(m) });
  mem.add("tool", "z".repeat(900));
  await mem.compactor.whenIdle();
  assert.equal(calls, 4);
  assert.equal(logs.length, 1);
  assert.ok(mem.view.settled());
});

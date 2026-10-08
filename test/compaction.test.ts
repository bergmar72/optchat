// The compactor's order and protocol (optchat.md section 4).
import test from "node:test";
import assert from "node:assert/strict";
import { Memory } from "../src/memory.ts";
import type { ChatTurn, Model } from "../src/model.ts";
import { tmp } from "./helpers.ts";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.ts";

const text = (t: ChatTurn) => (typeof t.content === "string" ? t.content : t.content.map((b: any) => b.text ?? "").join(""));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (n: number) => `message ${n} ` + "x".repeat(700); // over 512 bytes: a real call, not a free node

test("at most 8 messages ahead of the first unbuilt one start a call (the unbuilt-ahead limit)", async () => {
  const started: string[] = [];
  const release: Array<() => void> = [];
  const model: Model = {
    ask(_s, turns) {
      started.push(text(turns[0]).match(/compress message (\d+)/)?.[1] ?? "merge");
      return new Promise((r) => release.push(() => r({ text: "line", content: [{ type: "text", text: "line" }] })));
    },
  };
  const mem = new Memory(tmp(), model, { budget: 100_000, jobs: 100, retryMs: 60_000, log: () => {} });
  for (let i = 0; i < 20; i++) mem.add("talk", big(i));
  await sleep(30);
  assert.equal(started.length, 8, `started ${started.join(",")}`);
  assert.deepEqual(started, ["0", "1", "2", "3", "4", "5", "6", "7"]);
  // as calls finish, more messages may start; keep releasing until the compactor is idle
  let idle = false;
  void mem.compactor.whenIdle().then(() => (idle = true));
  for (let k = 0; k < 400 && !idle; k++) {
    if (release.length) release.shift()!();
    await sleep(5);
  }
  assert.equal(idle, true);
  const total: number = started.length;
  assert.ok(total === 20, `started ${total}`);
  assert.ok(mem.view.settled());
});

test("a failed call is tried again at the next message, not only after the retry delay", async () => {
  let calls = 0;
  const model: Model = {
    async ask() {
      calls++;
      if (calls === 1) throw new Error("transient");
      return { text: "ok", content: [{ type: "text", text: "ok" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 100_000, retryMs: 60_000, log: () => {} });
  mem.add("talk", big(0));
  await sleep(20);
  assert.equal(calls, 1);
  mem.add("talk", big(1)); // the next message retries the failed node at once (the retry delay is a minute)
  await sleep(20);
  assert.ok(calls >= 2);
  assert.ok(mem.store.hasNode(0, 0));
  void mem;
});

test("the compaction view stays between 16 and 32 KB, and the chat's view is left alone (its own sawtooth)", async () => {
  const mem = new Memory(tmp(), { async ask() { return { text: "y".repeat(300), content: [{ type: "text", text: "y".repeat(300) }] }; } }, { budget: 128_000, low: 64_000, retryMs: 5, log: () => {} });
  for (let i = 0; i < 400; i++) mem.add(i % 2 ? "talk" : "user", big(i));
  await mem.compactor.whenIdle();
  const ctx = mem.ctxView.bytes();
  assert.ok(ctx <= 32_000 + 700, `compaction view ${ctx} bytes`);
  assert.ok(ctx >= 16_000 - 700 || mem.ctxView.parts.length < 40, `compaction view ${ctx} bytes`);
  assert.equal(mem.ctxView.parts.reduce((n, p) => n + 2 ** p.l, 0), 400); // it tiles the chat, like the view
});

test("a merge's task names its two lines and the messages they cover; its context is the compaction view up to the merge", async () => {
  const asked: ChatTurn[][] = [];
  const model: Model = {
    async ask(_s, turns) {
      asked.push(turns);
      const t = "m".repeat(300); // long enough that a merge is a real call, not a free node
      return { text: t, content: [{ type: "text", text: t }] };
    },
  };
  const mem = new Memory(tmp(), { async ask(s, t) { return model.ask(s, t); } }, { budget: 100_000, retryMs: 5, log: () => {} });
  for (let i = 0; i < 2; i++) mem.add("talk", big(i));
  await mem.compactor.whenIdle();
  // the task is the second block of the first user turn
  const task = asked.map((t) => (t[0].content as any[]).at(-1)?.text).find((x) => /merge lines/.test(x ?? ""));
  assert.ok(task, "a merge was asked");
  assert.match(task!, /merge lines 0\+1 and 1\+1, adjacent,/);
  assert.match(task!, /<chat> may hold their messages, 0 to 1,/);
  const blocks = asked.find((t) => (t[0].content as any[]).at(-1)?.text === task)![0].content as any[];
  assert.equal(blocks.at(-1).text, task);
  const context = blocks.slice(0, -1).map((b: any) => b.text).join("");
  assert.ok(context.startsWith("<chat>\n") && context.endsWith("\n</chat>"), context);
});

test("a failed node is not retried by other completions before its retry time; a new message retries it at once", async () => {
  let fails = 0;
  const model: Model = {
    async ask(_s, turns) {
      const t = text(turns[0]);
      if (/compress message 0 /.test(t) && ++fails <= 2) throw new Error("transient"); // the third try works
      return { text: "ok", content: [{ type: "text", text: "ok" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 100_000, retryMs: 300, log: () => {} });
  mem.add("talk", big(0));
  for (let i = 1; i < 6; i++) mem.add("talk", big(i)); // siblings complete and call pump() while 0 is cooling down
  await sleep(150);
  assert.equal(fails, 1, `node 0 was retried before its retry time: ${fails} calls`);
  mem.add("talk", big(6)); // a new message retries it now
  await sleep(40);
  assert.equal(fails, 2);
  await mem.compactor.whenIdle(); // the retry timer (300 ms) tries again if nothing else does
  assert.ok(mem.store.hasNode(0, 0));
});

test("legacy step lines load as tool: a chat written before tool and echo were split still loads", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "hi");
  const file = path.join(s.mainDir, fs.readdirSync(s.mainDir)[0]);
  fs.appendFileSync(file, JSON.stringify({ i: 1, kind: "step", text: "Read {}\n→ ok", size: 20, date: "2026-01-01T00:00:00.000Z" }) + "\n");
  assert.deepEqual(Store.open(dir).msgs.map((m) => m.kind), ["user", "tool"]);
});

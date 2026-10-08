// The view's batch sawtooth and its saved state (optchat.md section 3).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Memory } from "../src/memory.ts";
import { TruncModel } from "../src/model.ts";
import { Store } from "../src/store.ts";
import { View } from "../src/view.ts";
import { freeMerge, leafNode, mergeNode } from "../src/tree.ts";
import { tmp } from "./helpers.ts";

test("the view grows from 64 KB to 128 KB, drops back to 64 KB in one batch, and never goes over 128 KB", () => {
  const s = Store.open(tmp());
  const v = new View(s, 128_000, 64_000);
  const sizes: number[] = [];
  let drops = 0;
  let prev = 0;
  for (let i = 0; i < 1500; i++) {
    const m = s.appendMsg(i % 2 ? "talk" : "user", `message ${i} ` + "w".repeat(180));
    s.putNode(leafNode(m, `S${i} ` + "y".repeat(120)));
    // parents appear as soon as their halves do, as in the live system
    for (let l = 1; 2 ** l <= s.total; l++) {
      const k = s.total % 2 ** l === 0 ? s.total / 2 ** l - 1 : -1;
      if (k >= 0 && !s.hasNode(l, k)) s.putNode(mergeNode(l, k, `M${l}.${k} ` + "z".repeat(150), s.node(l - 1, 2 * k)!, s.node(l - 1, 2 * k + 1)!));
    }
    v.append(i, i + 1);
    v.nodeBuilt(i + 1);
    sizes.push(v.bytes());
    if (v.bytes() < prev) drops++;
    prev = v.bytes();
    assert.ok(v.bytes() <= 128_000 + 700, `${v.bytes()} at ${i}`); // at most one line over, before the batch
  }
  assert.ok(drops >= 2, `expected batches, saw ${drops}`);
  const late = sizes.slice(500);
  assert.ok(Math.min(...late) <= 64_000 + 700, "a batch reaches the low mark");
  assert.ok(Math.max(...late) >= 120_000, "the view grows to the high mark");
  const avg = late.reduce((a, b) => a + b, 0) / late.length;
  assert.ok(avg > 80_000 && avg < 110_000, `average ${Math.round(avg)} (the sawtooth averages about 96 KB)`);
});

test("view.json: a restart restores the saved view without rebuilding it, and then keeps going", async () => {
  const dir = tmp();
  const mem = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  for (let i = 0; i < 60; i++) mem.add(i % 2 ? "talk" : "user", `message ${i} ` + "q".repeat(300));
  await mem.compactor.whenIdle();
  mem.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "view.json"), "utf8"));
  assert.deepEqual(saved.parts, mem.view.parts.map((p) => [p.l, p.i]));
  const again = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  assert.deepEqual(again.view.parts, mem.view.parts);
  again.add("user", "after the restart " + "r".repeat(300));
  await again.compactor.whenIdle();
  assert.equal(again.view.parts.at(-1)!.i, 60);
  assert.equal(again.view.parts.reduce((n, p) => n + 2 ** p.l, 0), 61); // still tiles the whole chat
});

test("view.json damaged or out of step with the log: it is ignored and the view is folded again", () => {
  const dir = tmp();
  const mem = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  for (let i = 0; i < 8; i++) mem.add("user", `m${i} ` + "q".repeat(200));
  fs.writeFileSync(path.join(dir, "view.json"), "{ not json");
  const broken = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  assert.equal(broken.view.parts.reduce((n, p) => n + 2 ** p.l, 0), 8); // tiles the chat
  fs.writeFileSync(path.join(dir, "view.json"), JSON.stringify([[0, 0], [0, 99]]));
  const wrong = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  assert.equal(wrong.view.parts.reduce((n, p) => n + 2 ** p.l, 0), 8);
  // entries that are not pairs, or not numbers, fall back too (this used to throw out of the constructor)
  for (const bad of [[null], [1], [[0]], [["a", 0]], { parts: [null] }]) {
    fs.writeFileSync(path.join(dir, "view.json"), JSON.stringify(bad));
    const m = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
    assert.equal(m.view.parts.reduce((n, p) => n + 2 ** p.l, 0), 8, JSON.stringify(bad));
  }
});

test("a batch that was waiting when the service stopped resumes as draining", () => {
  const s = Store.open(tmp());
  const v = new View(s, 500, 250);
  for (let i = 0; i < 4; i++) {
    const m = s.appendMsg("user", `m${i}`);
    s.putNode(leafNode(m, "x".repeat(200)));
    v.append(i, i + 1); // no parents yet: the batch waits
  }
  assert.equal((v as any).draining, true);
  const file = path.join(tmp(), "view.json");
  v.save(file);
  const back = View.load(s, file, 500, 250).view;
  assert.equal((back as any).draining, true);
  assert.deepEqual(back.parts, v.parts);
});

test("the compaction view is saved and restored too, and is not refolded", async () => {
  const dir = tmp();
  const mem = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  for (let i = 0; i < 30; i++) mem.add("user", `m${i} ` + "q".repeat(300));
  await mem.compactor.whenIdle();
  mem.flush();
  const again = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: () => {} });
  assert.deepEqual(again.ctxView.parts, mem.ctxView.parts);
  assert.ok(fs.existsSync(path.join(dir, "compaction-view.json")));
});

test("a view file that cannot be written does not fail add(): the message is kept, the save is retried later", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "view.json")); // a directory where the file should be: every save fails
  const logs: string[] = [];
  const mem = new Memory(dir, new TruncModel(), { budget: 5000, low: 2500, retryMs: 5, log: (m) => logs.push(m) });
  for (let i = 0; i < 20; i++) assert.doesNotThrow(() => mem.add("user", `m${i} ` + "q".repeat(300)));
  assert.equal(mem.store.total, 20);
  assert.equal(mem.ctxView.parts.reduce((n, p) => n + 2 ** p.l, 0), 20); // the compaction view still tiles the chat
  mem.flush();
  assert.ok(logs.some((l) => /could not save/.test(l)));
  await mem.compactor.whenIdle();
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { View, cutPieces } from "../src/view.ts";
import { freeLeaf, freeMerge, leafNode, mergeNode } from "../src/tree.ts";
import { bytes, startOf, span } from "../src/types.ts";
import { tmp } from "./helpers.ts";


// Build a complete tree over n messages with fake (model-free) summaries.
function buildAll(store: Store, n: number, lineLen = 200) {
  for (let i = 0; i < n; i++) {
    const m = store.appendMsg(i % 3 === 0 ? "user" : i % 3 === 1 ? "talk" : "tool", `message ${i} ` + "x".repeat(300));
    store.putNode(freeLeaf(m) ?? leafNode(m, `S${i} ` + "y".repeat(lineLen)));
  }
  for (let l = 1; 2 ** l <= n; l++)
    for (let i = 0; (i + 1) * 2 ** l <= n; i++) {
      const a = store.node(l - 1, 2 * i)!;
      const b = store.node(l - 1, 2 * i + 1)!;
      store.putNode(freeMerge(l, i, a, b) ?? mergeNode(l, i, `M${l}.${i} ` + "z".repeat(lineLen), a, b));
    }
}

test("store: append is durable and reload gives the same log", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "hello");
  s.appendMsg("talk", "hi\nthere");
  const s2 = Store.open(dir);
  assert.equal(s2.total, 2);
  assert.equal(s2.msgs[1].text, "hi\nthere");
  assert.equal(s2.msgs[0].size, bytes("user: hello"));
});

test("store: torn last line is skipped and the next write starts on its own line", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "one");
  const f = fs.readdirSync(s.mainDir)[0];
  fs.appendFileSync(path.join(s.mainDir, f), '{"i":1,"kind":"us'); // crash mid-write
  const s2 = Store.open(dir);
  assert.equal(s2.total, 1);
  assert.equal(s2.warnings.length, 1);
  s2.appendMsg("user", "two");
  const s3 = Store.open(dir);
  assert.deepEqual(s3.msgs.map((m) => m.text), ["one", "two"]);
  assert.equal(s3.warnings.length, 0); // the fragment was cut off the file at the first load
});

test("tree: free leaf and free merge need no model", () => {
  const s = Store.open(tmp());
  const a = s.appendMsg("user", "short");
  const b = s.appendMsg("talk", "also short");
  const na = freeLeaf(a)!;
  const nb = freeLeaf(b)!;
  assert.equal(na.text, "user: short");
  const p = freeMerge(1, 0, na, nb)!;
  assert.equal(p.text, "user: short\ntalk: also short");
  assert.equal(p.kinds, "ut");
  assert.equal(freeLeaf(s.appendMsg("tool", "x".repeat(600))), null);
});

test("view: tiles the chat, stays under budget, and the start is stable across appends", () => {
  const s = Store.open(tmp());
  const N = 1024;
  buildAll(s, N);
  const budget = 20_000;
  const v = new View(s, budget);
  let prev: string[] = [];
  let sharedSum = 0;
  let steps = 0;
  for (let i = 0; i < N; i++) {
    v.append(i, i + 1);
    // tiles [0, i+1) exactly, in order
    let at = 0;
    for (const p of v.parts) {
      assert.equal(startOf(p.l, p.i), at);
      at += span(p.l);
    }
    assert.equal(at, i + 1);
    assert.ok(v.bytes() <= budget + 700, `view ${v.bytes()} over budget at ${i}`);
    const cur = v.lines();
    if (i > 600) {
      let k = 0;
      while (k < prev.length && k < cur.length && prev[k] === cur[k]) k++;
      sharedSum += cur.slice(0, k).join("\n").length / cur.join("\n").length;
      steps++;
    }
    prev = cur;
  }
  assert.ok(sharedSum / steps > 0.5, `consecutive views share only ${(sharedSum / steps).toFixed(2)}`);
});

test("view: fold at load equals the live view when all nodes exist", () => {
  const s = Store.open(tmp());
  buildAll(s, 300);
  const live = new View(s, 8000);
  for (let i = 0; i < 300; i++) live.append(i, i + 1);
  const folded = View.fold(s, 8000);
  assert.deepEqual(folded.lines(), live.lines());
});

test("view: an unbuilt part renders a placeholder, and settle waits for it", async () => {
  const s = Store.open(tmp());
  const m = s.appendMsg("tool", "x".repeat(900));
  const v = new View(s);
  v.append(0);
  assert.match(v.lines()[0], /^0\+1\|o\|\(not summarized yet/);
  assert.equal(v.settled(), false);
  let done = false;
  const p = v.settle().then((r) => ((done = true), r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false);
  s.putNode(leafNode(m, "step: summary"));
  v.nodeBuilt();
  assert.equal(await p, true);
  const ac = new AbortController();
  s.appendMsg("tool", "y".repeat(900));
  v.append(1);
  const q = v.settle(ac.signal);
  ac.abort();
  assert.equal(await q, false);
});

test("cutPieces: pieces concatenate to the whole view and cut at line ends", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `${i}+1|u|` + "a".repeat(90));
  const pieces = cutPieces(lines, [3000, 8000, 100_000]);
  assert.equal(pieces.length, 3); // third mark is past the end: skipped
  assert.equal(pieces.join(""), "<chat>\n" + lines.join("\n") + "\n</chat>");
  assert.ok(pieces[0].endsWith("\n") && pieces[0].length <= 3000);
  assert.ok(pieces[1].length > 0);
});

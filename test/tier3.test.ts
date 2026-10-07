// Tests aimed at the mutants that survived the first suites: each assertion fails if the behaviour it names is removed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Compactor, summarize } from "../src/compactor.ts";
import { Memory } from "../src/memory.ts";
import { PermanentError, type ChatTurn, type Model } from "../src/model.ts";
import { Store } from "../src/store.ts";
import { freeLeaf, freeMerge, leafNode, mergeNode } from "../src/tree.ts";
import { bytes, cutBytes, flat, type Part } from "../src/types.ts";
import { cutPieces, View } from "../src/view.ts";
import { tmp } from "./helpers.ts";

const text = (t: ChatTurn) => (typeof t.content === "string" ? t.content : t.content.map((b: any) => b.text ?? "").join(""));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** n short messages with a COMPLETE tree of free nodes. */
function shortTree(n: number, kinds: Array<"user" | "talk" | "step"> = ["user", "talk", "step"]): Store {
  const s = Store.open(tmp());
  for (let i = 0; i < n; i++) s.appendMsg(kinds[i % kinds.length], `m${i}`);
  for (let i = 0; i < n; i++) s.putNode(freeLeaf(s.msgs[i])!);
  for (let l = 1; 2 ** l <= n; l++) for (let i = 0; (i + 1) * 2 ** l <= n; i++) s.putNode(freeMerge(l, i, s.node(l - 1, 2 * i)!, s.node(l - 1, 2 * i + 1)!)!);
  return s;
}
const view = (s: Store, parts: Part[], budget = 1e9, T = s.total) => {
  const v = new View(s, budget);
  v.parts = parts.map((p) => ({ ...p })); // fit() splices this array: never share it between views
  v.nodeBuilt(T);
  return v;
};
const lvl0 = (...is: number[]): Part[] => is.map((i) => ({ l: 0, i }));

// ---------------------------------------------------------------- view

test("linesUpTo / textLinesUpTo: the context of leaf i ends with message i-1; a part that crosses `end` is left out", () => {
  const s = shortTree(8);
  const v = view(s, lvl0(0, 1, 2, 3, 4, 5, 6, 7));
  assert.equal(v.linesUpTo(3).length, 3);
  assert.match(v.linesUpTo(3).at(-1)!, /^2\+1\|/);
  assert.deepEqual(v.linesUpTo(0), []);
  assert.deepEqual(v.textLinesUpTo(3), ["user: m0", "talk: m1", "step: m2"]);
  const mixed = view(s, [{ l: 1, i: 0 }, { l: 0, i: 2 }, { l: 0, i: 3 }]);
  assert.equal(mixed.linesUpTo(3).length, 2); // (1,0) ends at 2, (0,2) at 3, (0,3) at 4: not included
  assert.deepEqual(view(s, [{ l: 2, i: 0 }]).linesUpTo(3), []); // a part past `end` is never partly shown
  assert.deepEqual(view(s, [{ l: 1, i: 0 }]).textLinesUpTo(2), ["user: m0 talk: m1"]); // newline flattened
});

test("fit: the age rule uses T (the number of messages): the same view merges a different pair at a different T", () => {
  const s = shortTree(8);
  const parts = [{ l: 1, i: 0 }, { l: 1, i: 1 }, ...lvl0(4, 5, 6, 7)];
  const size = view(s, parts).bytes();
  // T = 8: due(1,0)+(1,1) = 8/8 = 1, due(4,5) = 4/4 = 1, due(6,7) = 2/4: a tie goes to the OLDEST
  const a = view(s, parts, size - 1, 8);
  assert.deepEqual(a.parts, [{ l: 2, i: 0 }, ...lvl0(4, 5, 6, 7)]);
  // T = 100: due(1,0)+(1,1) = 100/8 = 12.5, due(4,5) = 96/4 = 24, due(6,7) = 94/4 = 23.5: the level-0 pair at 4 wins
  const b = view(s, parts, size - 1, 100);
  assert.deepEqual(b.parts, [{ l: 1, i: 0 }, { l: 1, i: 1 }, { l: 1, i: 2 }, ...lvl0(6, 7)]);
});

test("fit: a pair whose parent is not built is passed over, and the view stays over budget until it arrives", () => {
  const s = Store.open(tmp());
  for (let i = 0; i < 4; i++) s.appendMsg("user", `m${i}`);
  for (let i = 0; i < 4; i++) s.putNode(freeLeaf(s.msgs[i])!);
  s.putNode(freeMerge(1, 1, s.node(0, 2)!, s.node(0, 3)!)!); // only (1,1): the OLDER pair (0,1) has no parent yet
  const v = view(s, lvl0(0, 1, 2, 3), 1);
  assert.deepEqual(v.parts, [...lvl0(0, 1), { l: 1, i: 1 }]); // merged the younger pair, then stopped: still over budget
  assert.ok(v.bytes() > 1);
  s.putNode(freeMerge(1, 0, s.node(0, 0)!, s.node(0, 1)!)!);
  s.putNode(freeMerge(2, 0, s.node(1, 0)!, s.node(1, 1)!)!);
  v.nodeBuilt(4);
  assert.deepEqual(v.parts, [{ l: 2, i: 0 }]);
});

test("fit: the budget is a limit, not a target: a view exactly at the budget is left alone", () => {
  const s = shortTree(4);
  const size = view(s, lvl0(0, 1, 2, 3)).bytes();
  assert.equal(view(s, lvl0(0, 1, 2, 3), size).parts.length, 4);
  assert.equal(view(s, lvl0(0, 1, 2, 3), size - 1).parts.length, 3);
});

test("rendering: exact lines and byte counts, wide characters included; the unbuilt placeholder is anchored", () => {
  const s = Store.open(tmp());
  s.appendMsg("user", "日本語 🎉");
  s.putNode(freeLeaf(s.msgs[0])!);
  s.appendMsg("step", "x".repeat(900));
  const v = view(s, lvl0(0, 1));
  const first = "0+1|u|user: 日本語 🎉";
  assert.equal(v.lines()[0], first);
  assert.match(v.lines()[1], /^1\+1\|s\|\(not summarized yet: zoom it\)$/);
  assert.equal(v.bytes(), bytes(first) + 1 + bytes(v.lines()[1]) + 1); // bytes, not characters, plus one newline each
  assert.ok(bytes(first) > first.length);
  s.putNode(leafNode(s.msgs[1], "step: line one\nline two"));
  v.nodeBuilt();
  assert.equal(v.lines()[1], "1+1|s|step: line one line two");
  assert.equal(v.bytes(), bytes(v.lines()[0]) + 1 + bytes(v.lines()[1]) + 1); // the size is recomputed when a node arrives
});

test("free nodes: exactly 512 bytes is free, 513 is not; bytes count, not characters; and a merge of exactly 512", () => {
  const mk = (kind: "user", t: string) => ({ i: 0, kind, text: t, size: bytes(`${kind}: ${t}`), date: "d" });
  assert.ok(freeLeaf(mk("user", "x".repeat(506))), "6 + 506 = 512");
  assert.equal(freeLeaf(mk("user", "x".repeat(507))), null);
  const wide = mk("user", "日".repeat(170)); // 176 characters, 516 bytes
  assert.equal(freeLeaf(wide), null);
  const a = { l: 0, i: 0, text: "a".repeat(255), size: 255, kinds: "u" };
  const b = { l: 0, i: 1, text: "b".repeat(256), size: 256, kinds: "t" };
  assert.equal(bytes(freeMerge(1, 0, a, b)!.text), 512);
  assert.equal(freeMerge(1, 0, a, { ...b, text: "b".repeat(257) }), null);
  assert.equal(freeMerge(1, 0, a, b)!.kinds, "ut");
  assert.equal(mergeNode(1, 0, "x", a, b).kinds, "ut");
});

test("flat: any run of newlines and blanks around them becomes one space", () => {
  assert.equal(flat("a\n\n   b \n c"), "a b c");
  assert.equal(flat("no newline  keeps  spaces"), "no newline  keeps  spaces");
});

test("cutPieces: a piece ends at the LAST line that fits before the mark; unsorted marks give the same cuts as sorted", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}-aaaaa`); // 8 chars + newline
  const [p0, p1] = cutPieces(lines, [50, 5000]);
  assert.equal(p0, "<chat>\n" + lines.slice(0, 4).join("\n") + "\n"); // 7 + 4*9 = 43 <= 50; a fifth line would make 52
  assert.ok(p1.startsWith(lines[4]));
  assert.equal(cutPieces(lines, [120, 50, 200]).length, cutPieces(lines, [50, 120, 200]).length);
  assert.deepEqual(cutPieces(lines, [200, 50]), cutPieces(lines, [50, 200]));
  assert.equal(cutPieces(lines, [100000]).length, 1); // a mark past the end is skipped
});

test("settle: an already-aborted signal returns false at once and leaves no waiter behind", async () => {
  const s = Store.open(tmp());
  s.appendMsg("step", "y".repeat(900));
  const v = view(s, lvl0(0));
  const ac = new AbortController();
  ac.abort();
  assert.equal(await v.settle(ac.signal), false);
  assert.equal((v as any).waiters.size, 0);
});

test("a live view with LATE builds keeps its invariants: tiles the chat, only coarsens, size = sum of lines", () => {
  const s = Store.open(tmp());
  const v = new View(s, 6000);
  const N = 300;
  let prev: Part[] = [];
  const buildUpTo = (done: number) => {
    for (let l = 1; 2 ** l <= done; l++)
      for (let i = 0; (i + 1) * 2 ** l <= done; i++)
        if (!s.hasNode(l, i)) s.putNode(mergeNode(l, i, `M${l}.${i} ` + "z".repeat(180), s.node(l - 1, 2 * i)!, s.node(l - 1, 2 * i + 1)!));
  };
  for (let i = 0; i < N; i++) {
    const m = s.appendMsg("talk", `message ${i} ` + "w".repeat(300));
    s.putNode(leafNode(m, `S${i} ` + "y".repeat(180)));
    v.append(i, i + 1);
    if (i % 5 === 4) {
      buildUpTo(Math.max(0, i + 1 - 40)); // parents arrive 40 messages late
      v.nodeBuilt(i + 1);
    }
    let at = 0;
    for (const p of v.parts) {
      assert.equal(p.i * 2 ** p.l, at);
      at += 2 ** p.l;
    }
    assert.equal(at, i + 1);
    assert.equal(v.bytes(), v.lines().reduce((n, l) => n + bytes(l) + 1, 0));
    // every previous part is inside exactly one current part: the view never splits
    for (const p of prev) assert.ok(v.parts.some((q) => q.l >= p.l && Math.floor((p.i * 2 ** p.l) / 2 ** q.l) === q.i), `part ${p.l}:${p.i} was split`);
    prev = v.parts.map((p) => ({ ...p }));
  }
});

test("store: replacing a node in place survives a reload; rewrite() across the log and tree files is complete", () => {
  const dir = tmp();
  const s = Store.open(dir);
  const m0 = s.appendMsg("user", "zero " + "a".repeat(600));
  s.appendMsg("talk", "one");
  s.putNode(leafNode(m0, "first summary"));
  s.putNode(leafNode(m0, "second summary"));
  s.rewrite(new Map([[1, { ...s.msgs[1], text: "ONE", size: 9 }]]), new Map([["0:0", { ...s.node(0, 0)!, text: "third summary" }]]));
  const again = Store.open(dir);
  assert.equal(again.node(0, 0)!.text, "third summary");
  assert.equal(again.msgs[1].text, "ONE");
  assert.equal(fs.readFileSync(path.join(dir, "tree", fs.readdirSync(path.join(dir, "tree"))[0]), "utf8").trim().split("\n").length, 1); // replaced, not appended
});

test("cutBytes never splits a character", () => {
  assert.equal(cutBytes("日本語", 4), "日");
  assert.equal(cutBytes("日本語", 6), "日本");
  assert.equal(cutBytes("a日", 2), "a");
  assert.equal(cutBytes("🎉x", 3), "");
  assert.equal(cutBytes("abc", 3), "abc");
  assert.equal(cutBytes("abc", 99), "abc");
});

// ---------------------------------------------------------------- compactor

test("summarize: keeps the SHORTEST try (not the first, not the last); a byte count, not a character count, decides", async () => {
  const lens = [700, 515, 600, 530, 700];
  let k = 0;
  const model: Model = { async ask() { const t = "a".repeat(lens[k++]); return { text: t, content: [{ type: "text", text: t }] }; } };
  assert.equal((await summarize(model, [], "Compress")).length, 515);
  assert.equal(k, 5);
  const sent: string[] = [];
  const wide: Model = {
    async ask(_s, turns) {
      sent.push(text(turns.at(-1)!));
      const t = "日".repeat(300); // 300 characters, 900 bytes
      return { text: t, content: [{ type: "text", text: t }] };
    },
  };
  await summarize(wide, [], "Compress");
  assert.match(sent[1], /That line is 900 bytes; the limit is 512/);
});

test("summarize: an empty first reply is a permanent failure; the assistant turn is echoed back UNCHANGED on a retry", async () => {
  await assert.rejects(summarize({ async ask() { return { text: "  \n", content: [] }; } }, [], "Compress"), (e: any) => e instanceof PermanentError && /empty reply/.test(e.message));
  const first = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "a".repeat(600) }];
  const seen: ChatTurn[][] = [];
  let k = 0;
  const model: Model = {
    async ask(_s, turns) {
      seen.push(turns.map((t) => ({ ...t })));
      return k++ ? { text: "short", content: [{ type: "text", text: "short" }] } : { text: "a".repeat(600), content: first };
    },
  };
  await summarize(model, [], "Compress");
  assert.equal(seen[1][1].role, "assistant");
  assert.equal(seen[1][1].content, first); // the very same blocks, thinking signature and all
});

test("summarize: cache marks sit on every piece but the last, at most 3, and none for a short context", async () => {
  const blocks: any[][] = [];
  const model: Model = { async ask(_s, turns) { blocks.push(turns[0].content as any[]); return { text: "ok", content: [{ type: "text", text: "ok" }] }; } };
  await summarize(model, ["short line"], "Compress");
  await summarize(model, Array.from({ length: 2000 }, (_, i) => `${i}-` + "c".repeat(100)), "Compress"); // ~200k chars
  assert.equal(blocks[0].filter((b) => b.cache_control).length, 0);
  const marked = blocks[1].filter((b) => b.cache_control);
  assert.equal(marked.length, 3);
  assert.deepEqual(marked[0].cache_control, { type: "ephemeral" });
  assert.ok(!blocks[1].at(-1).cache_control && !blocks[1].at(-2).cache_control); // the tail of the context and the step carry none
  assert.ok(blocks[1].at(-1).text === "Compress");
});

/** A model whose merge calls wait for a gate: leaves answer at once. */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const st = { inflight: 0, max: 0, calls: 0 };
  const model: Model = {
    async ask(_s, turns) {
      st.calls++;
      st.inflight++;
      st.max = Math.max(st.max, st.inflight);
      if (/Merge these two lines/.test(text(turns[0]))) await gate;
      st.inflight--;
      const t = "L".repeat(300); // two of these do not fit in 512 bytes: merges are real calls, not free nodes
      return { text: t, content: [{ type: "text", text: t }] };
    },
  };
  return { model, st, release };
}

test("compactor: never more than `jobs` calls at once, and it does use them", async () => {
  const { model, st, release } = gated();
  const mem = new Memory(tmp(), model, { budget: 100_000, jobs: 2, retryMs: 5, log: () => {} });
  for (let i = 0; i < 16; i++) mem.add("talk", `m${i} ` + "x".repeat(700));
  await sleep(250);
  assert.equal(st.max, 2);
  release();
  await mem.compactor.whenIdle();
  assert.ok(st.max <= 2);
  assert.ok(mem.view.settled());
});

test("compactor: a result that arrives after halt() is discarded; resume() asks again", async () => {
  let resolve!: (v: any) => void;
  let calls = 0;
  const model: Model = {
    ask() {
      calls++;
      return calls === 1 ? new Promise((r) => (resolve = r)) : Promise.resolve({ text: "second", content: [{ type: "text", text: "second" }] });
    },
  };
  const mem = new Memory(tmp(), model, { budget: 100_000, retryMs: 5, log: () => {} });
  mem.add("step", "q".repeat(900));
  assert.equal(calls, 1);
  mem.compactor.halt();
  resolve({ text: "STALE", content: [{ type: "text", text: "STALE" }] });
  await sleep(30);
  assert.equal(mem.store.hasNode(0, 0), false, "a result from before the redaction was stored");
  assert.equal(calls, 1, "a paused compactor starts nothing");
  mem.add("step", "r".repeat(900)); // and a new message does not start it either
  assert.equal(calls, 1);
  mem.compactor.resume();
  await mem.compactor.whenIdle();
  assert.equal(mem.store.node(0, 0)!.text, "second");
});

test("compactor: whenIdle waits for the rebuild of a dirty node", async () => {
  const mem = new Memory(tmp(), { async ask() { return { text: "rebuilt", content: [{ type: "text", text: "rebuilt" }] }; } }, { budget: 100_000, retryMs: 5, log: () => {} });
  mem.add("step", "d".repeat(900));
  await mem.compactor.whenIdle();
  mem.compactor.dirty.add("0:0");
  let idle = false;
  void mem.compactor.whenIdle().then(() => (idle = true));
  await sleep(20);
  assert.equal(idle, false);
  mem.compactor.pump();
  await sleep(50);
  assert.equal(idle, true);
  assert.equal(mem.store.node(0, 0)!.text, "rebuilt");
  assert.equal(mem.compactor.dirty.size, 0);
});

test("compactor: a failed node is retried after retryMs, not before and not much later", async () => {
  const at: number[] = [];
  const model: Model = {
    async ask() {
      at.push(Date.now());
      if (at.length < 3) throw new Error("boom");
      return { text: "ok", content: [{ type: "text", text: "ok" }] };
    },
  };
  const mem = new Memory(tmp(), model, { budget: 100_000, retryMs: 60, log: () => {} });
  mem.add("step", "t".repeat(900));
  await mem.compactor.whenIdle();
  assert.equal(at.length, 3);
  assert.ok(at[1] - at[0] >= 55 && at[2] - at[1] >= 55, `gaps ${at[1] - at[0]}, ${at[2] - at[1]}`);
  assert.ok(at[2] - at[0] < 1000);
});

test("compactor: the leaf prompt carries the whole message, the merge prompt carries both flattened children", async () => {
  const asked: string[] = [];
  const child = "a line\nwith a newline " + "w".repeat(300);
  const model: Model = { async ask(_s, turns) { asked.push(text(turns[0])); return { text: child, content: [{ type: "text", text: child }] }; } };
  const mem = new Memory(tmp(), model, { budget: 100_000, retryMs: 5, log: () => {} });
  mem.add("user", "first\nsecond\nthird " + "x".repeat(700));
  mem.add("talk", "reply " + "y".repeat(700));
  await mem.compactor.whenIdle();
  assert.ok(asked[0].includes("user: first\nsecond\nthird")); // newlines kept in a message
  const merge = asked.find((a) => /Merge these two lines/.test(a))!;
  const flatChild = "a line with a newline " + "w".repeat(300);
  assert.ok(merge.includes(`${flatChild}\n${flatChild}`)); // children flattened, one per line
  void Compactor;
});

test("our own tools: names, descriptions, the policy and --allowedTools all come from one list", async () => {
  const { OWN_TOOLS, ownToolName } = await import("../src/constants.ts");
  const { TOOL_DESCRIPTIONS } = await import("../src/tools.ts");
  const { decide, defaultPolicy } = await import("../src/policy.ts");
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS).sort(), [...OWN_TOOLS].sort());
  const cfg = defaultPolicy("/home/u", "/opt/code", []);
  for (const n of OWN_TOOLS) assert.equal(decide(ownToolName(n), {}, cfg).verdict, "allow");
  assert.equal(decide(ownToolName("approve"), {}, cfg).verdict, "ask"); // the permission tool is Claude Code's, not the model's
  const { newService } = await import("./helpers.ts");
  const svc = newService();
  const args: string[] = (svc as any).claudeArgs();
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 1 + OWN_TOOLS.length);
  assert.deepEqual(allowed, OWN_TOOLS.map(ownToolName));
});

test("cutPieces: a line that ends EXACTLY on the mark still fits in the piece", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `${i}-aaaaaaa`); // 9 chars + newline = 10 each
  const [p0] = cutPieces(lines, [7 + 3 * 10]); // header 7 + three lines = 37: ends exactly on the mark
  assert.equal(p0.length, 37);
  assert.equal(p0, "<chat>\n" + lines.slice(0, 3).join("\n") + "\n");
});

test("fold: each step of the load uses the number of messages SO FAR, so it matches the live view", () => {
  for (const [n, budget] of [[300, 3000], [700, 6000]] as const) {
    const s = Store.open(tmp());
    for (let i = 0; i < n; i++) {
      const m = s.appendMsg("talk", `message ${i} ` + "w".repeat(300));
      s.putNode(leafNode(m, `S${i} ` + "y".repeat(180)));
    }
    for (let l = 1; 2 ** l <= n; l++)
      for (let i = 0; (i + 1) * 2 ** l <= n; i++) s.putNode(mergeNode(l, i, `M${l}.${i} ` + "z".repeat(180), s.node(l - 1, 2 * i)!, s.node(l - 1, 2 * i + 1)!));
    const live = new View(s, budget);
    for (let i = 0; i < n; i++) live.append(i, i + 1); // the T of the moment: i + 1 messages exist
    const folded = View.fold(s, budget);
    assert.deepEqual(folded.parts, live.parts, `n=${n}`);
    // and it is NOT the same as folding with the final count at every step (that would be a different, wrong view)
    const wrong = new View(s, budget);
    for (let i = 0; i < n; i++) wrong.append(i, n);
    assert.notDeepEqual(wrong.parts, live.parts, `n=${n}: the test could not tell the two apart`);
  }
});

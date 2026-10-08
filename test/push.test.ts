// The merge order of the view must reproduce Taelin's rollback push exactly. See optchat.md section 3.
import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../src/view.ts";
import type { Store } from "../src/store.ts";
import type { Node, Part } from "../src/types.ts";

/** Taelin's push (rollback_state_list.js). Each entry: newest first, a bit `keep`, `life`, a state, the older entries. */
type St = { keep: number; life: number; state: number; older: St | null } | null;
function push(s: number, st: St): St {
  if (st === null) return { keep: 0, life: 0, state: s, older: null };
  const { keep, life, state, older } = st;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) return { keep: 0, life: 0, state: s, older: { keep: 0, life: life - 1, state, older } };
  return { keep: 0, life, state: s, older: push(state, older) };
}
const starts = (st: St): number[] => {
  const out: number[] = [];
  for (let x = st; x; x = x.older) out.push(x.state);
  return out.sort((a, b) => a - b);
};

/** Only what View reads: messages, and built nodes by level and index. Lines are counted, not measured. */
class StubStore {
  total = 0;
  msgs: unknown[] = [];
  private nodes = new Map<string, Node>();
  hasNode(l: number, i: number): boolean {
    return this.nodes.has(`${l}:${i}`);
  }
  node(l: number, i: number): Node | undefined {
    return this.nodes.get(`${l}:${i}`);
  }
  build(l: number, i: number): void {
    this.nodes.set(`${l}:${i}`, { l, i, text: "", size: 0, kinds: "" });
  }
}

test("the due rule with the push list's length as budget makes the same merges as push, at every step (20,000)", () => {
  const N = 20_000;
  const store = new StubStore();
  let st: St = null;
  let view: View | undefined;
  let mismatches = 0;
  let first = -1;
  for (let t = 0; t < N; t++) {
    st = push(t, st);
    store.total = t + 1;
    // a node exists once both of its halves do: build every node whose messages are all there
    for (let l = 1; 2 ** l <= store.total; l++) for (let i = 0; (i + 1) * 2 ** l <= store.total; i++) if (!store.hasNode(l, i)) store.build(l, i);
    store.build(0, t);
    const budget = starts(st).length; // the list's length, as the budget (counted in lines)
    if (!view) view = new View(store as unknown as Store, budget, budget, "lines");
    else (view as any).high = (view as any).low = budget;
    view.append(t, t + 1);
    // push's lines: each state starts a line that runs to the next state (the newest to now)
    const s = starts(st);
    const want = s.map((a, k) => {
      const end = k + 1 < s.length ? s[k + 1] : t + 1;
      const len = end - a;
      const l = Math.round(Math.log2(len));
      return { l, i: a / len };
    });
    const got = view.parts.map((p) => ({ l: p.l, i: p.i }));
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatches++;
      if (first < 0) first = t;
    }
  }
  assert.equal(mismatches, 0, `first mismatch after ${first + 1} messages`);
});

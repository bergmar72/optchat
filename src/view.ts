import { PLACEHOLDER, VIEW } from "./constants.ts";
import type { Store } from "./store.ts";
import { bytes, flat, KIND_LETTER, type Part, span, startOf } from "./types.ts";

/**
 * The view: a list of tree nodes that tiles the whole chat [0, T), oldest
 * first. It only ever appends at the end and coarsens (merges a pair into its
 * parent). It never splits. The start of the view is the same from one turn to
 * the next, which is what makes it cacheable.
 */
export class View {
  parts: Part[] = [];
  private size = 0;
  private waiters = new Set<() => void>();

  constructor(
    private store: Store,
    readonly budget = VIEW,
  ) {}

  /** Rebuild the view from message 0: append + fit for every message in order. */
  static fold(store: Store, budget = VIEW): View {
    const v = new View(store, budget);
    for (let i = 0; i < store.total; i++) v.append(i, i + 1);
    return v;
  }

  /** Render one line of the view. */
  line(p: Part): string {
    const n = span(p.l);
    const node = this.store.node(p.l, p.i);
    const start = startOf(p.l, p.i);
    if (node) return `${start}+${n}|${node.kinds}|${flat(node.text)}`;
    const m = this.store.msgs[p.i];
    return `${start}+${n}|${m ? KIND_LETTER[m.kind] : ""}|${PLACEHOLDER}`;
  }

  private lineBytes(p: Part): number {
    return bytes(this.line(p)) + 1;
  }

  /** The new message i is now part of the chat. T = number of messages. */
  append(i: number, T = this.store.total): void {
    const p = { l: 0, i };
    this.parts.push(p);
    this.size += this.lineBytes(p);
    this.fit(T);
  }

  /** Merge the most due pair, again and again, until the view fits. */
  fit(T = this.store.total): void {
    while (this.size > this.budget) {
      let best = -1;
      let bestDue = -Infinity;
      for (let k = 0; k + 1 < this.parts.length; k++) {
        const a = this.parts[k];
        const b = this.parts[k + 1];
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        if (!this.store.hasNode(a.l + 1, a.i / 2)) continue;
        const due = (T - startOf(a.l, a.i)) / 2 ** (a.l + 2);
        if (due > bestDue) {
          bestDue = due;
          best = k;
        }
      }
      if (best < 0) break; // wait until a parent is built
      const a = this.parts[best];
      const b = this.parts[best + 1];
      const parent = { l: a.l + 1, i: a.i / 2 };
      this.size += this.lineBytes(parent) - this.lineBytes(a) - this.lineBytes(b);
      this.parts.splice(best, 2, parent);
    }
    this.wake();
  }

  /** First message whose view line is not a built summary (T if none). */
  first(): number {
    for (const p of this.parts) if (!this.store.hasNode(p.l, p.i)) return startOf(p.l, p.i);
    return this.store.total;
  }

  settled(): boolean {
    return this.parts.every((p) => this.store.hasNode(p.l, p.i));
  }

  /** Resolves true once every view line is a built summary; false if aborted. */
  settle(signal?: AbortSignal): Promise<boolean> {
    if (this.settled()) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = () => {
        if (!this.settled()) return;
        cleanup();
        resolve(true);
      };
      const abort = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        this.waiters.delete(done);
        signal?.removeEventListener("abort", abort);
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", abort);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Call after a node was built or replaced. */
  nodeBuilt(T = this.store.total): void {
    // An unbuilt part counted its placeholder; its real line has a new size.
    this.size = this.parts.reduce((s, p) => s + this.lineBytes(p), 0);
    this.fit(T);
  }

  /** View lines whose last message lies at or before `end` (exclusive). */
  linesUpTo(end: number): string[] {
    const out: string[] = [];
    for (const p of this.parts) {
      if (startOf(p.l, p.i) + span(p.l) > end) break;
      out.push(this.line(p));
    }
    return out;
  }

  /**
   * The compactor's context: bare summary text, one per line. NO ids and NO kind column
   * (a model shown `id+n|` copies the format into its own output).
   */
  textLinesUpTo(end: number): string[] {
    const out: string[] = [];
    for (const p of this.parts) {
      if (startOf(p.l, p.i) + span(p.l) > end) break;
      const node = this.store.node(p.l, p.i);
      out.push(node ? flat(node.text) : PLACEHOLDER);
    }
    return out;
  }

  lines(): string[] {
    return this.parts.map((p) => this.line(p));
  }

  bytes(): number {
    return this.size;
  }
}

/**
 * Cut the rendered view into pieces at the last line end before each mark
 * (in characters). Concatenating the pieces gives `<chat>\n…\n</chat>`.
 * A mark past the end of the view is skipped. Every piece but the last is
 * meant to carry a cache breakpoint.
 */
export function cutPieces(lines: string[], marks: number[]): string[] {
  const head = "<chat>\n";
  const foot = "</chat>";
  const pieces: string[] = [];
  let cur = head;
  let total = head.length;
  const ends: number[] = []; // char offset after each line (incl. newline)
  for (const l of lines) {
    total += l.length + 1;
    ends.push(total);
  }
  const cuts = new Set<number>();
  let last = -1;
  for (const m of marks) {
    let k = -1;
    for (let j = 0; j < ends.length && ends[j] <= m; j++) k = j;
    if (k < 0 || k + 1 >= lines.length || k <= last) continue; // past the end, or no new piece
    cuts.add(k);
    last = k;
  }
  for (let j = 0; j < lines.length; j++) {
    cur += lines[j] + "\n";
    if (cuts.has(j)) {
      pieces.push(cur);
      cur = "";
    }
  }
  pieces.push(cur + foot);
  return pieces;
}

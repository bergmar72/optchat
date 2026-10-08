import fs from "node:fs";
import { PLACEHOLDER, VIEW, VIEW_LOW } from "./constants.ts";
import { writeAtomic } from "./fsx.ts";
import type { Store } from "./store.ts";
import { bytes, flat, KIND_LETTER, type Part, span, startOf } from "./types.ts";

/**
 * The view: a list of tree nodes that tiles the whole chat [0, T), oldest first. Lines are only merged
 * (coarsened), never split, so the start of the view stays the same from one call to the next.
 *
 * Which pair merges (the "due" rule, checked against Taelin's push: with the push list's length as the budget
 * it makes exactly the same merges at every one of 20,000 steps): among adjacent sibling lines (l, i) and
 * (l, i+1) whose parent is built, the most due pair has the largest (T - last) / 2^l, where `last` is the pair's
 * last message. Ties go to the oldest pair.
 *
 * When the merges happen (the sawtooth): a new message appends its line. Once the view passes `high`, one batch
 * merges the most due pairs until it is at most `low`. A batch that cannot finish (parents not built yet) finishes
 * at the next messages. So the view grows from `low` to `high`, drops back to `low`, and averages about (high+low)/2.
 *
 * `unit` is "bytes" (the real budget) or "lines" (for the push test, which counts lines).
 */
export class View {
  parts: Part[] = [];
  private size = 0;
  private draining = false;
  private changedSinceSave = false;
  private waiters = new Set<() => void>();

  /** Called once after every change to `parts` (append or batch): Memory saves view.json here. */
  onChange?: () => void;

  constructor(
    private store: Store,
    readonly high = VIEW,
    readonly low = high,
    private unit: "bytes" | "lines" = "bytes",
  ) {}

  /** Rebuild the view from message 0. Only for a view that was never saved (first start) or for the tests. */
  static fold(store: Store, high = VIEW, low = high): View {
    const v = new View(store, high, low);
    for (let i = 0; i < store.total; i++) v.append(i, i + 1);
    return v;
  }

  /** A view with the given parts, merged down to `low` if it is over `high` (tests and load). */
  static fromParts(store: Store, parts: Part[], high = VIEW, low = high, T = store.total): View {
    const v = new View(store, high, low);
    v.parts = parts.map((p) => ({ ...p }));
    v.size = v.parts.reduce((n, p) => n + v.measure(p), 0);
    v.draining = v.size > high;
    v.drain(T);
    return v;
  }

  /**
   * The view as it was saved, plus the messages that came after the save. Never rebuilt from the log: a rebuilt
   * view differs from the live one and every cache entry dies. A missing or damaged file falls back to a fold.
   */
  static load(store: Store, file: string, high = VIEW, low = high): { view: View; restored: boolean } {
    let pairs: Array<[number, number]> | undefined;
    try {
      pairs = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      pairs = undefined;
    }
    if (!Array.isArray(pairs)) return { view: View.fold(store, high, low), restored: false };
    const v = new View(store, high, low);
    let at = 0;
    for (const [l, i] of pairs) {
      if (!Number.isInteger(l) || !Number.isInteger(i) || l < 0 || i < 0 || startOf(l, i) !== at || at + span(l) > store.total)
        return { view: View.fold(store, high, low), restored: false };
      v.parts.push({ l, i });
      at += span(l);
    }
    v.size = v.parts.reduce((n, p) => n + v.lineBytes(p), 0);
    for (let k = at; k < store.total; k++) v.append(k, k + 1);
    return { view: v, restored: true };
  }

  /** Save the parts, atomically. Pairs only: a few bytes per line. */
  save(file: string): void {
    writeAtomic(file, JSON.stringify(this.parts.map((p) => [p.l, p.i])) + "\n");
  }

  private measure(p: Part): number {
    return this.unit === "lines" ? 1 : this.lineBytes(p);
  }

  /** Render one line of the view. */
  line(p: Part): string {
    return renderLine(this.store, p);
  }

  private lineBytes(p: Part): number {
    return bytes(this.line(p)) + 1;
  }

  /** The new message i is now part of the chat. T = number of messages. */
  append(i: number, T = this.store.total): void {
    const p = { l: 0, i };
    this.parts.push(p);
    this.size += this.measure(p);
    if (this.size > this.high) this.draining = true;
    this.changedSinceSave = true;
    this.drain(T);
  }

  /** Once draining, merge the most due pairs until the view is at most `low`. Stops when no pair can merge yet. */
  drain(T = this.store.total): void {
    // Checked here, not only in append(): a line that was a short placeholder when appended grows when its
    // summary arrives (nodeBuilt), and the view can pass `high` at any of those moments.
    if (this.size > this.high) this.draining = true;
    if (this.draining) {
      while (this.size > this.low) {
        let best = -1;
        let bestDue = -Infinity;
        for (let k = 0; k + 1 < this.parts.length; k++) {
          const a = this.parts[k];
          const b = this.parts[k + 1];
          if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
          if (!this.store.hasNode(a.l + 1, a.i / 2)) continue;
          const last = (b.i + 1) * span(b.l) - 1;
          const due = (T - last) / span(a.l);
          if (due > bestDue) {
            bestDue = due;
            best = k;
          }
        }
        if (best < 0) break; // wait until a parent is built; the next message tries again
        const a = this.parts[best];
        const b = this.parts[best + 1];
        const parent = { l: a.l + 1, i: a.i / 2 };
        this.size += this.measure(parent) - this.measure(a) - this.measure(b);
        this.parts.splice(best, 2, parent);
        this.changedSinceSave = true;
      }
      if (this.size <= this.low) this.draining = false;
    }
    if (this.changedSinceSave) {
      this.changedSinceSave = false;
      this.onChange?.();
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
    this.size = this.parts.reduce((s, p) => s + this.measure(p), 0);
    this.drain(T);
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
   * The compactor's context: the bare text of the lines whose messages end before `end`, oldest first. Stops at
   * the first line that is not built yet: a call never sees a placeholder, nor half of a message. No ids, no
   * kind column (a model shown `id+n|` copies the format into its own output).
   */
  builtTextLinesUpTo(end: number, built: (l: number, i: number) => boolean): string[] {
    const out: string[] = [];
    for (const p of this.parts) {
      if (startOf(p.l, p.i) + span(p.l) > end) break;
      const node = this.store.node(p.l, p.i);
      if (!node || !built(p.l, p.i)) break;
      out.push(flat(node.text));
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

/** `id+n|k|text` for a part: the format of the view AND of what `zoom` returns, so they cannot drift apart. */
export function renderLine(store: Store, p: Part): string {
  const n = span(p.l);
  const node = store.node(p.l, p.i);
  const start = startOf(p.l, p.i);
  if (node) return `${start}+${n}|${node.kinds}|${flat(node.text)}`;
  const m = p.l === 0 ? store.msgs[p.i] : undefined; // only a level-0 part can be unbuilt, and only it indexes a message
  return `${start}+${n}|${m ? KIND_LETTER[m.kind] : ""}|${PLACEHOLDER}`;
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
  for (const m of [...marks].sort((a, b) => a - b)) { // unsorted marks must not silently drop cuts
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

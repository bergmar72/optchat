import { COMPACTOR_MARKS, JOBS, NODE, RETRY_MS, TRIES } from "./constants.ts";
import { type ChatTurn, type Model, PermanentError } from "./model.ts";
import { COMPACT, stepPrompt } from "./prompts.ts";
import type { Store } from "./store.ts";
import { freeLeaf, freeMerge, leafLine, leafNode, mergeNode } from "./tree.ts";
import { bytes, capHeadTail, cutBytes, flat, key, span, startOf } from "./types.ts";
import { cutPieces, type View } from "./view.ts";

/** One compactor call (with size retries). Returns the shortest line it got. */
export async function summarize(model: Model, ctxLines: string[], step: string, marks = COMPACTOR_MARKS): Promise<string> {
  const pieces = cutPieces(ctxLines, marks);
  const blocks: any[] = pieces.map((text, k) =>
    k < pieces.length - 1 ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text },
  );
  blocks.push({ type: "text", text: step });
  const turns: ChatTurn[] = [{ role: "user", content: blocks }];
  const tries: string[] = [];
  for (;;) {
    let reply;
    try {
      reply = await model.ask(COMPACT, turns);
    } catch (e) {
      if (tries.length) break; // we already have a line: a failed retry round must not throw it away
      throw e;
    }
    const line = reply.text.trim();
    if (!line) {
      if (tries.length) break;
      throw new PermanentError("empty reply");
    }
    tries.push(line);
    if (bytes(line) <= NODE || tries.length >= TRIES) break;
    turns.push({ role: "assistant", content: reply.content }, { role: "user", content: stepPrompt.tooLong(bytes(line), cutBytes(line, NODE)) });
  }
  return tries.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
}

/** How often a node that fails the same way every time is retried before it gets a mechanical line. */
export const PERMANENT_TRIES = 4;

export interface CompactorOpts {
  jobs?: number;
  retryMs?: number;
  marks?: number[];
  log?: (msg: string) => void;
}

/**
 * Builds tree nodes in the background, in the order the spec requires:
 * a node is started only when its sources are built AND every view line
 * before its end is already a summary. So messages are compressed one at a
 * time, in order, while merges of finished parts run alongside.
 */
export class Compactor {
  busy = new Set<string>();
  /** Nodes that exist but must be rebuilt (after a redaction), keyed "l:i". */
  dirty = new Set<string>();
  /** Bumped by redaction: results of calls started before it are discarded. */
  gen = 0;
  paused = false;
  private failures = new Map<string, number>();
  private front: number[] = [];
  private jobs: number;
  private retryMs: number;
  private marks: number[];
  private log: (msg: string) => void;
  private idle: Array<() => void> = [];
  onBuilt?: () => void;

  constructor(
    private store: Store,
    private view: View,
    private model: Model,
    opts: CompactorOpts = {},
  ) {
    this.jobs = opts.jobs ?? JOBS;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.marks = opts.marks ?? COMPACTOR_MARKS;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  private built(l: number, i: number): boolean {
    return this.store.hasNode(l, i) && !this.dirty.has(key(l, i));
  }

  /**
   * Start every node that is ready. Call after each new message or finished node.
   * Cost is bounded by what can start NOW: rule 3 means that once one node cannot start because
   * its context is not all summaries yet, no later node of that level can either, so the scan stops;
   * it also stops when every job slot is taken. (A scan of the whole backlog on every message
   * made bulk imports quadratic.)
   */
  pump(): void {
    if (this.paused) return;
    const T = this.store.total;
    let changed = false;
    let first: number | undefined; // view.first(), computed when needed and again after a node was built
    for (let l = 0; 2 ** l <= T; l++) {
      if (this.front[l] === undefined) this.front[l] = 0;
      const n = Math.floor(T / 2 ** l);
      while (this.front[l] < n && this.built(l, this.front[l]) && !this.dirty.size) this.front[l]++;

      /** false = nothing further in this level can start */
      const visit = (i: number): boolean => {
        const k = key(l, i);
        if (this.busy.has(k)) return true;
        let a, b;
        if (l > 0) {
          if (!this.built(l - 1, 2 * i) || !this.built(l - 1, 2 * i + 1)) return true;
          a = this.store.node(l - 1, 2 * i)!;
          b = this.store.node(l - 1, 2 * i + 1)!;
        }
        // free nodes: the source already fits, no model call
        const free = l === 0 ? freeLeaf(this.store.msgs[i]) : freeMerge(l, i, a!, b!);
        if (free) {
          this.store.putNode(free);
          this.dirty.delete(k);
          changed = true;
          first = undefined;
          return true;
        }
        if (this.busy.size >= this.jobs) return false;
        const end = l === 0 ? i : (i + 1) * span(l);
        first ??= this.view.first();
        if (end > first) return false; // rule 3: the whole context must be summaries
        this.start(l, i, a, b);
        return true;
      };

      if (this.dirty.size) {
        for (let i = 0; i < n; i++) if ((this.dirty.has(key(l, i)) || !this.store.hasNode(l, i)) && !visit(i)) break;
      } else {
        for (let i = this.front[l]; i < n; i++) if (!this.store.hasNode(l, i) && !visit(i)) break;
      }
    }
    if (changed) {
      this.view.nodeBuilt();
      this.onBuilt?.();
    }
    if (this.busy.size === 0 && this.view.settled() && !this.dirty.size) for (const f of this.idle.splice(0)) f();
  }

  private start(l: number, i: number, a?: any, b?: any): void {
    const k = key(l, i);
    this.busy.add(k);
    const gen = this.gen;
    const ctx = this.view.textLinesUpTo(l === 0 ? i : (i + 1) * span(l)); // bare text: no ids, no kind column
    const step =
      l === 0
        ? stepPrompt.leaf(this.store.msgs[i].kind, this.store.msgs[i].text)
        : stepPrompt.merge(flat(a.text), flat(b.text));
    summarize(this.model, ctx, step, this.marks).then(
      (text) => {
        this.busy.delete(k);
        if (gen !== this.gen) return this.pump(); // a redaction started meanwhile: discard
        try {
          this.finish(l, i, text, a, b);
        } catch (e) {
          // a failed write (ENOSPC...) must not escape as an unhandled rejection or stall the compactor
          this.busy.add(k);
          this.fail(k, l, i, e, a, b);
          return;
        }
        this.pump();
      },
      (err) => {
        if (gen !== this.gen) {
          this.busy.delete(k);
          return this.pump();
        }
        this.fail(k, l, i, err, a, b);
      },
    );
  }

  private finish(l: number, i: number, text: string, a?: any, b?: any): void {
    const k = key(l, i);
    const node = l === 0 ? leafNode(this.store.msgs[i], text) : mergeNode(l, i, text, a, b);
    this.store.putNode(node);
    this.failures.delete(k);
    this.dirty.delete(k);
    this.view.nodeBuilt();
    this.onBuilt?.();
  }

  /**
   * Report the first failure only and retry after RETRY_MS (no backoff: the next turn waits on this).
   * A failure that will repeat identically (a refusal, a 400...) is retried a few times and then the node
   * gets a mechanical, clearly marked line, so one poison message cannot block the chat forever.
   */
  private fail(k: string, l: number, i: number, err: any, a?: any, b?: any): void {
    const n = (this.failures.get(k) ?? 0) + 1;
    this.failures.set(k, n);
    const name = `${startOf(l, i)}+${span(l)}`;
    if (n === 1) this.log(`compactor: node ${name} failed: ${err?.message ?? err}`);
    if (err?.permanent && n >= PERMANENT_TRIES) {
      try {
        const src = l === 0 ? capHeadTail(leafLine(this.store.msgs[i]), 2000) : `${a.text} ${b.text}`;
        const prefix = `[not summarized: ${String(err.message).slice(0, 60)}] `;
        const text = cutBytes(prefix + flat(src), NODE);
        this.log(`compactor: node ${name} could not be summarized (${err.message}); stored a mechanical line instead`);
        this.busy.delete(k);
        this.finish(l, i, text, a, b);
        this.pump();
        return;
      } catch (e: any) {
        this.log(`compactor: node ${name}: even the mechanical line failed: ${e?.message ?? e}`);
      }
    }
    setTimeout(() => {
      this.busy.delete(k);
      this.pump();
    }, this.retryMs);
  }

  /** Resolves once nothing is left to build. */
  whenIdle(): Promise<void> {
    if (this.busy.size === 0 && this.view.settled() && !this.dirty.size) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /** Redaction: stop work, and make results of in-flight calls useless. */
  halt(): void {
    this.paused = true;
    this.gen++;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }
}

export { leafLine };

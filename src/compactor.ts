import { JOBS, NODE, RETRY_MS, TRIES, UNBUILT_AHEAD } from "./constants.ts";
import { type ChatTurn, type Model, PermanentError } from "./model.ts";
import { leafTask, mergeTask, SYSTEM, tooLong } from "./prompts.ts";
import type { Store } from "./store.ts";
import { freeLeaf, freeMerge, leafLine, leafNode, mergeNode } from "./tree.ts";
import { bytes, capHeadTail, cutBytes, flat, key, span, startOf } from "./types.ts";
import type { View } from "./view.ts";

/**
 * One compaction: the compaction view (`context`, bare lines) and its task. Up to TRIES rounds in the same
 * conversation, each told the length of its own line; returns the shortest line it got. A later round that
 * fails keeps the earlier lines. (optchat.md section 4.)
 */
export async function summarize(model: Model, context: string[], task: string): Promise<string> {
  const chat = `<chat>\n${context.join("\n")}\n</chat>`;
  const turns: ChatTurn[] = [
    {
      role: "user",
      content: [
        { type: "text", text: chat, cache_control: { type: "ephemeral" } },
        { type: "text", text: task },
      ],
    },
  ];
  const tries: string[] = [];
  for (;;) {
    let reply;
    try {
      reply = await model.ask(SYSTEM, turns);
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
    turns.push({ role: "assistant", content: reply.content }, { role: "user", content: tooLong(bytes(line), cutBytes(line, NODE)) });
  }
  return tries.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
}

/** How often a node that fails the same way every time is retried before it gets a mechanical line. */
export const PERMANENT_TRIES = 4;

export interface CompactorOpts {
  jobs?: number;
  retryMs?: number;
  log?: (msg: string) => void;
}

/**
 * Builds tree nodes in the background (optchat.md section 4, "The order"):
 * - a message's node starts once fewer than UNBUILT_AHEAD messages before it are still unbuilt;
 * - a merge starts once both of its halves are built;
 * - a call sees only the built lines of the compaction view, up to its node.
 * A failed call is tried again at the next message (or after RETRY_MS, when no message comes).
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
  private log: (msg: string) => void;
  private idle: Array<() => void> = [];
  onBuilt?: () => void;

  constructor(
    private store: Store,
    private view: View,
    private ctxView: View,
    private model: Model,
    opts: CompactorOpts = {},
  ) {
    this.jobs = opts.jobs ?? JOBS;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  private built(l: number, i: number): boolean {
    return this.store.hasNode(l, i) && !this.dirty.has(key(l, i));
  }

  /**
   * Start every node that is ready. Call after each new message or finished node. The scan stops at the
   * first message that cannot start yet (the unbuilt-ahead limit, or the job slots), so the cost is bounded by
   * what can start now, not by the backlog.
   */
  pump(): void {
    if (this.paused) return;
    const T = this.store.total;
    let changed = false;
    for (let l = 0; 2 ** l <= T; l++) {
      if (this.front[l] === undefined) this.front[l] = 0;
      const n = Math.floor(T / 2 ** l);
      while (this.front[l] < n && this.built(l, this.front[l]) && !this.dirty.size) this.front[l]++;
      let unbuiltAhead = 0; // messages seen so far in this scan that are not built (level 0 only)

      /** false = nothing further in this level can start now; `ahead` = unbuilt messages before i (level 0) */
      const visit = (i: number, ahead: number): boolean => {
        const k = key(l, i);
        if (this.busy.has(k)) return true;
        let a, b;
        if (l > 0) {
          if (!this.built(l - 1, 2 * i) || !this.built(l - 1, 2 * i + 1)) return true;
          a = this.store.node(l - 1, 2 * i)!;
          b = this.store.node(l - 1, 2 * i + 1)!;
        }
        // free nodes: the source already fits, no model call (and no wait: they are not model context)
        const free = l === 0 ? freeLeaf(this.store.msgs[i]) : freeMerge(l, i, a!, b!);
        if (free) {
          this.store.putNode(free);
          this.dirty.delete(k);
          changed = true;
          return true;
        }
        if (this.busy.size >= this.jobs) return false;
        if (l === 0 && ahead >= UNBUILT_AHEAD) return false; // fewer than UNBUILT_AHEAD unbuilt messages before this one
        this.start(l, i, a, b);
        return true;
      };

      const each = (i: number) => {
        const ahead = unbuiltAhead;
        if (l === 0 && !this.built(0, i)) unbuiltAhead++;
        return visit(i, ahead);
      };
      if (this.dirty.size) {
        for (let i = 0; i < n; i++) if ((this.dirty.has(key(l, i)) || !this.store.hasNode(l, i)) && !each(i)) break;
      } else {
        for (let i = this.front[l]; i < n; i++) if (!this.store.hasNode(l, i) && !each(i)) break;
      }
    }
    if (changed) {
      this.view.nodeBuilt();
      this.ctxView.nodeBuilt();
      this.onBuilt?.();
    }
    if (this.busy.size === 0 && this.view.settled() && !this.dirty.size) for (const f of this.idle.splice(0)) f();
  }

  private start(l: number, i: number, a?: any, b?: any): void {
    const k = key(l, i);
    this.busy.add(k);
    const gen = this.gen;
    const end = l === 0 ? i : (i + 1) * span(l);
    const context = this.ctxView.builtTextLinesUpTo(end, (x, y) => this.built(x, y));
    const task =
      l === 0
        ? leafTask(i, this.store.msgs[i].kind, this.store.msgs[i].text)
        : mergeTask(`${startOf(l - 1, 2 * i)}+${span(l - 1)}`, `${startOf(l - 1, 2 * i + 1)}+${span(l - 1)}`, startOf(l, i), end - 1, flat(a.text), flat(b.text));
    summarize(this.model, context, task).then(
      (text) => {
        this.busy.delete(k);
        if (gen !== this.gen) return this.pump(); // a redaction started meanwhile: discard
        try {
          this.finish(l, i, text, a, b);
        } catch (e) {
          // a failed write (ENOSPC...) must not escape as an unhandled rejection or stall the compactor
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
    this.ctxView.nodeBuilt();
    this.onBuilt?.();
  }

  /**
   * Report the first failure only. The node is tried again at the next message, or after RETRY_MS if none comes
   * (a turn waits for every node, so the wait must not depend on a message arriving). A failure that will repeat
   * identically (a refusal, a 400...) gets a few tries and then a mechanical, marked line, so one poison message
   * cannot block the chat forever.
   */
  private fail(k: string, l: number, i: number, err: any, a?: any, b?: any): void {
    this.busy.delete(k);
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
        this.finish(l, i, text, a, b);
        this.pump();
        return;
      } catch (e: any) {
        this.log(`compactor: node ${name}: even the mechanical line failed: ${e?.message ?? e}`);
      }
    }
    setTimeout(() => this.pump(), this.retryMs);
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


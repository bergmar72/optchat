import path from "node:path";
import { Compactor, type CompactorOpts } from "./compactor.ts";
import { COMPACTION_VIEW_HIGH, COMPACTION_VIEW_LOW, MASTER_MARKS, SAVE_DELAY_MS, VIEW, VIEW_LOW } from "./constants.ts";
import type { Model } from "./model.ts";
import { Store } from "./store.ts";
import { freeLeaf } from "./tree.ts";
import type { Kind, Msg } from "./types.ts";
import { cutPieces, View } from "./view.ts";

/** The log, the tree, the two views and the compactor, working together. */
export class Memory {
  readonly store: Store;
  /** The chat's view: what the master reads. Saved to chat/view.json. */
  readonly view: View;
  /** What a compaction reads: the chat's view merged further (16-32 KB). Saved to chat/compaction-view.json. */
  readonly ctxView: View;
  readonly compactor: Compactor;
  private saves: Array<{ view: View; file: string }>;
  private timer?: NodeJS.Timeout;
  private log: (msg: string) => void;

  constructor(chatDir: string, model: Model, opts: CompactorOpts & { budget?: number; low?: number } = {}) {
    this.log = opts.log ?? ((m) => console.error(m));
    this.store = Store.open(chatDir);
    for (const w of this.store.warnings) this.log(`store: ${w}`);
    // `budget` (tests) sets the high mark; the default is the sawtooth 128 KB -> 64 KB
    const high = opts.budget ?? VIEW;
    const low = opts.low ?? (opts.budget ? opts.budget : VIEW_LOW);
    const viewFile = path.join(chatDir, "view.json");
    const ctxFile = path.join(chatDir, "compaction-view.json");
    this.view = View.load(this.store, viewFile, high, low).view;
    this.ctxView = View.load(this.store, ctxFile, COMPACTION_VIEW_HIGH, COMPACTION_VIEW_LOW).view;
    this.saves = [
      { view: this.view, file: viewFile },
      { view: this.ctxView, file: ctxFile },
    ];
    this.view.onChange = () => this.saveSoon();
    this.ctxView.onChange = () => this.saveSoon();
    this.compactor = new Compactor(this.store, this.view, this.ctxView, model, opts);
  }

  /** Start the background pump (builds anything left unbuilt from a previous run). */
  start(): void {
    this.compactor.pump();
  }

  /** Save soon: one save covers a burst of changes. flush() saves now. */
  private saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /**
   * Save both views now. A failed save is logged, not thrown: the log is the record, and the view files are a cache
   * of it (a stale file is completed from the log at the next start). The next change saves again.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const { view, file } of this.saves) {
      try {
        view.save(file);
      } catch (e: any) {
        this.log(`view: could not save ${file} (${e?.message ?? e}); it is saved again at the next change`);
      }
    }
  }

  /** Log a message, add it to the view, and let the compactor know. */
  add(kind: Kind, text: string): Msg {
    const m = this.store.appendMsg(kind, text);
    try {
      const f = freeLeaf(m);
      if (f) this.store.putNode(f);
    } finally {
      this.view.append(m.i); // the message is durable: the view must tile it even if the free leaf failed (pump retries it)
      this.ctxView.append(m.i);
    }
    this.compactor.pump(true); // a new message retries a node that failed, at once
    return m;
  }

  /** The view as it is NOW, as text pieces (render BEFORE logging a new message). */
  renderPieces(marks = MASTER_MARKS): string[] {
    return cutPieces(this.view.lines(), marks);
  }

  render(): string {
    return this.renderPieces([]).join("");
  }
}

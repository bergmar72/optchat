import { Compactor, type CompactorOpts } from "./compactor.ts";
import path from "node:path";
import { COMPACTION_VIEW_HIGH, COMPACTION_VIEW_LOW, MASTER_MARKS, VIEW, VIEW_LOW } from "./constants.ts";
import type { Model } from "./model.ts";
import { Store } from "./store.ts";
import { freeLeaf } from "./tree.ts";
import type { Kind, Msg } from "./types.ts";
import { cutPieces, View } from "./view.ts";

/** The log, the tree, the view and the compactor, working together. */
export class Memory {
  readonly store: Store;
  readonly view: View;
  /** What a compaction reads: the chat's view merged further (16-32 KB). Derived, so rebuilt at start. */
  readonly ctxView: View;
  readonly compactor: Compactor;

  constructor(chatDir: string, model: Model, opts: CompactorOpts & { budget?: number; low?: number } = {}) {
    this.store = Store.open(chatDir);
    for (const w of this.store.warnings) console.error(`store: ${w}`);
    // `budget` (tests) sets the high mark; the default is the sawtooth 128 KB -> 64 KB
    const high = opts.budget ?? VIEW;
    const low = opts.low ?? (opts.budget ? opts.budget : VIEW_LOW);
    const file = path.join(chatDir, "view.json");
    const { view } = View.load(this.store, file, high, low);
    this.view = view;
    this.view.onChange = () => this.view.save(file);
    this.ctxView = View.fold(this.store, COMPACTION_VIEW_HIGH, COMPACTION_VIEW_LOW);
    this.compactor = new Compactor(this.store, this.view, this.ctxView, model, opts);
  }

  /** Start the background pump (builds anything left unbuilt from a previous run). */
  start(): void {
    this.compactor.pump();
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
    this.compactor.pump();
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

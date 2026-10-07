import { Compactor, type CompactorOpts } from "./compactor.ts";
import { MASTER_MARKS, VIEW } from "./constants.ts";
import type { Model } from "./model.ts";
import { Store } from "./store.ts";
import { freeLeaf } from "./tree.ts";
import type { Kind, Msg } from "./types.ts";
import { cutPieces, View } from "./view.ts";

/** The log, the tree, the view and the compactor, working together. */
export class Memory {
  readonly store: Store;
  readonly view: View;
  readonly compactor: Compactor;

  constructor(chatDir: string, model: Model, opts: CompactorOpts & { budget?: number } = {}) {
    this.store = Store.open(chatDir);
    for (const w of this.store.warnings) console.error(`store: ${w}`);
    this.view = View.fold(this.store, opts.budget ?? VIEW);
    this.compactor = new Compactor(this.store, this.view, model, opts);
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

import fs from "node:fs";
import path from "node:path";
import { appendDurable, ensureDir, fsyncDir, localDay, writeAtomic } from "./fsx.ts";
import { bytes, key, type Kind, KINDS, type Msg, type Node } from "./types.ts";

export class StoreError extends Error {}

const fsyncDirOf = (file: string) => fsyncDir(path.dirname(file));

/**
 * The log (chat/main/*.jsonl) and the tree (chat/tree/*.jsonl).
 * Both are append-only, with one controlled exception: `rewrite()`, used only
 * by redaction.
 */
export class Store {
  readonly mainDir: string;
  readonly treeDir: string;
  msgs: Msg[] = [];
  nodes = new Map<string, Node>();
  private msgFile: string[] = [];
  private nodeFile = new Map<string, string>();
  warnings: string[] = [];
  private readOnly = false;

  constructor(readonly dir: string) {
    this.mainDir = path.join(dir, "main");
    this.treeDir = path.join(dir, "tree");
  }

  /** `readOnly` never writes: for browsing a chat that a running service owns. */
  static open(dir: string, readOnly = false): Store {
    const s = new Store(dir);
    s.readOnly = readOnly;
    if (!readOnly) {
      ensureDir(s.mainDir);
      ensureDir(s.treeDir);
    }
    s.load();
    return s;
  }

  private files(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => path.join(dir, f));
  }

  /**
   * The complete lines of a file. A crash mid-write leaves a torn last line (no newline):
   * it was never acknowledged, so it is cut off the file (and ignored when read-only).
   */
  private readLines(file: string): string[] {
    const buf = fs.readFileSync(file);
    const nl = buf.lastIndexOf(0x0a);
    const tail = buf.subarray(nl + 1).toString("utf8");
    if (tail.length > 0) {
      let valid = true;
      try {
        JSON.parse(tail);
      } catch {
        valid = false;
      }
      if (valid) {
        if (!this.readOnly) appendDurable(file, ""); // complete but unterminated: just add the newline
        return [...buf.toString("utf8").split("\n").filter(Boolean)];
      }
      this.warnings.push(`torn last line dropped from ${file}`);
      if (!this.readOnly) {
        fs.truncateSync(file, nl + 1);
        fsyncDirOf(file);
      }
    }
    return buf.subarray(0, nl + 1).toString("utf8").split("\n").filter((l) => l.length > 0);
  }

  private parseLine<T>(file: string, line: string, n: number): T {
    try {
      return JSON.parse(line);
    } catch {
      // Not a torn tail (those were dropped above): skipping it would silently lose what follows.
      throw new StoreError(`${file}: line ${n} is unreadable and is not at the end of the file. Refusing to start: repair or remove that line by hand.`);
    }
  }

  private load(): void {
    for (const file of this.files(this.mainDir)) {
      this.readLines(file).forEach((line, idx) => {
        const m = this.parseLine<Msg>(file, line, idx + 1);
        // Chats written by the base spec's tool/echo kinds load as steps.
        if ((m.kind as string) === "tool" || (m.kind as string) === "echo") m.kind = "step";
        if (!KINDS.includes(m.kind)) throw new StoreError(`${file}: line ${idx + 1} has unknown kind '${m.kind}'. Refusing to start.`);
        if (m.i < this.msgs.length) {
          this.warnings.push(`duplicate message id ${m.i} in ${file}; the first one is kept`);
          return;
        }
        if (m.i > this.msgs.length)
          throw new StoreError(`${file}: line ${idx + 1} has id ${m.i} but ${this.msgs.length} was expected: messages are missing. Refusing to start.`);
        this.msgs.push(m);
        this.msgFile.push(file);
      });
    }
    for (const file of this.files(this.treeDir)) {
      this.readLines(file).forEach((line, idx) => {
        const n = this.parseLine<Node>(file, line, idx + 1);
        const k = key(n.l, n.i);
        this.nodes.set(k, n); // a later line replaces an earlier one
        this.nodeFile.set(k, file);
      });
    }
  }

  appendMsg(kind: Kind, text: string, now = new Date()): Msg {
    text = text.toWellFormed(); // a lone surrogate in the permanent log would later break an API request
    const i = this.msgs.length;
    const m: Msg = { i, kind, text, size: bytes(`${kind}: ${text}`), date: now.toISOString() };
    // Files are read in name order and ids must ascend: if the local date went backwards
    // (timezone change, clock fix), keep writing into the latest file instead of an earlier one.
    const last = this.msgFile.length ? path.basename(this.msgFile[this.msgFile.length - 1]) : "";
    const name = `${localDay(now)}.jsonl` > last ? `${localDay(now)}.jsonl` : last;
    const file = path.join(this.mainDir, name);
    appendDurable(file, JSON.stringify(m) + "\n");
    this.msgs.push(m);
    this.msgFile.push(file);
    return m;
  }

  hasNode(l: number, i: number): boolean {
    return this.nodes.has(key(l, i));
  }

  node(l: number, i: number): Node | undefined {
    return this.nodes.get(key(l, i));
  }

  /** Save a node. A node that already exists is replaced in place. */
  putNode(n: Node, now = new Date()): void {
    const k = key(n.l, n.i);
    const existing = this.nodeFile.get(k);
    if (existing) {
      this.rewrite(new Map(), new Map([[k, n]])); // memory is updated only after the file was
      return;
    }
    const file = path.join(this.treeDir, `${localDay(now)}.jsonl`);
    appendDurable(file, JSON.stringify(n) + "\n");
    this.nodes.set(k, n);
    this.nodeFile.set(k, file);
  }

  /**
   * Replace lines in place, one file at a time (temp, fsync, rename, fsync dir).
   * Ids and line order stay the same. Used by redaction and by rebuilding
   * a node that already exists.
   */
  rewrite(msgs: Map<number, Msg>, nodes: Map<string, Node>): string[] {
    const touched = new Set<string>();
    const byFile = new Map<string, { msgs: Msg[]; nodes: Node[] }>();
    const slot = (f: string) => {
      let s = byFile.get(f);
      if (!s) byFile.set(f, (s = { msgs: [], nodes: [] }));
      return s;
    };
    for (const m of msgs.values()) slot(this.msgFile[m.i]).msgs.push(m);
    for (const [k, n] of nodes) {
      const f = this.nodeFile.get(k);
      if (f) slot(f).nodes.push(n);
    }
    for (const [file, ch] of byFile) {
      const mById = new Map(ch.msgs.map((m) => [m.i, m]));
      const nByKey = new Map(ch.nodes.map((n) => [key(n.l, n.i), n]));
      const out: string[] = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          out.push(line);
          continue;
        }
        if (file.startsWith(this.mainDir)) {
          const r = mById.get(parsed.i);
          out.push(r ? JSON.stringify(r) : line);
        } else {
          const r = nByKey.get(key(parsed.l, parsed.i));
          out.push(r ? JSON.stringify(r) : line);
        }
      }
      writeAtomic(file, out.join("\n") + "\n");
      touched.add(file);
    }
    for (const m of msgs.values()) this.msgs[m.i] = m;
    for (const [k, n] of nodes) this.nodes.set(k, n);
    return [...touched];
  }

  get total(): number {
    return this.msgs.length;
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AUTONOMY_LIMIT, CAP, CONFIRM_TIMEOUT_MS, KILL_GRACE_MS, MASTER_MARKS, MASTER_TOOLS, STEP_INPUT_CAP } from "./constants.ts";
import { appendDurable, ensureDir, readJsonl, writeAtomic } from "./fsx.ts";
import { commitAll, ensureRepo } from "./git.ts";
import { indexLinks } from "./links.ts";
import { claimLock } from "./lock.ts";
import { Memory } from "./memory.ts";
import { type Model, usage as compactorUsage } from "./model.ts";
import { decide, defaultPolicy, loadPolicy, type PolicyConfig } from "./policy.ts";
import { MASTER, VIEW_DOC } from "./prompts.ts";
import { Tools } from "./tools.ts";
import { type Paths, pathsFor } from "./paths.ts";
import { capHeadTail, type Kind } from "./types.ts";

export { pathsFor, type Paths } from "./paths.ts";

/**
 * The client token, made if it is not there. The CLI calls this BEFORE it claims the lock: a client that
 * starts the moment the socket appears must already find the token.
 */
export function ensureClientToken(paths: Paths): string {
  try {
    const t = fs.readFileSync(paths.token, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    // first start
  }
  ensureDir(paths.secrets);
  const t = crypto.randomBytes(32).toString("hex");
  writeAtomic(paths.token, t + "\n");
  return t;
}

export interface ServiceConf {
  root: string;
  /** The harness code directory: the agent may never change it. */
  codeDir: string;
  /** Command that starts the MCP shim: ["node", "bin/optchat.mjs", "mcp"]. */
  mcpCommand: string[];
  claudeBin?: string;
  masterModel?: string;
  oauthToken?: string;
  marks?: number[];
  otherHomes?: string[];
  confirmTimeoutMs?: number;
  killGraceMs?: number;
  extraClaudeArgs?: string[];
  /** Where status and errors go besides attached clients (default: stderr, so journald has them). */
  log?: (msg: string) => void;
  /** For tests: replace the claude process. */
  spawnClaude?: (args: string[], env: Record<string, string>, cwd: string) => ChildProcessWithoutNullStreams;
}

export interface Item {
  kind: Extract<Kind, "user" | "work" | "file" | "fwd">;
  text: string;
  /** The user asked for this directly (`optchat file`): it counts as a turn they started. */
  byUser?: boolean;
  /** Id in the durable inbox, until the item is in the chat log. */
  inboxId?: number;
}

interface Client {
  id: number;
  role: string;
  sock: net.Socket;
  send(o: any): void;
}

interface Confirm {
  nonce: string;
  tool: string;
  why: string;
  expires: number;
  resolve(allow: boolean, by: string): void;
}

interface TurnState {
  pending: Map<string, { name: string; input: any }>;
  order: string[];
  done: Map<string, string>;
  logged: Set<string>;
  usageSeen: Set<string>;
  step: number;
  result?: any;
  initOk: boolean;
}

const newTurnState = (): TurnState => ({ pending: new Map(), order: [], done: new Map(), logged: new Set(), usageSeen: new Set(), step: 0, initOk: true });

/** `apiKeySource` values that mean the SUBSCRIPTION login (measured: "none" with an OAuth login). Anything else may bill an API key. */
const SUBSCRIPTION_SOURCES = new Set(["none", "oauth"]);
const MAX_ITEM_CHARS = 4_000_000;
const MAX_LINE_CHARS = 64 << 20;
const userDriven = (i: Item) => i.kind === "user" || !!i.byUser;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class Service {
  readonly paths: Paths;
  readonly mem: Memory;
  readonly tools: Tools;
  policy: PolicyConfig;
  private clients = new Set<Client>();
  private nextClient = 1;
  private server?: net.Server;
  private queue: Item[] = [];
  private turning = false;
  private child?: ChildProcessWithoutNullStreams;
  private ending = false;
  private cancelled = false;
  private waitAbort?: AbortController;
  private sentMid = new Map<string, Item>();
  private st = newTurnState();
  private seq = 0;
  private ring: Array<{ seq: number; ev: any }> = [];
  private confirms = new Map<string, Confirm>();
  private turnNo = 0;
  private nonUserTurns = 0;
  private lastTurnEnd = 0;
  private replaying = false;
  private warnedCommit = false;
  private inboxSeq = 0;
  private inboxPending = new Set<number>();
  private inboxLines = 0;
  private readonly token: string;
  /** Set while a redaction owns the files: no turns, no compactor, no imports. */
  locked = false;

  constructor(
    readonly conf: ServiceConf,
    model: Model,
  ) {
    this.paths = pathsFor(conf.root);
    for (const d of [this.paths.root, this.paths.run, this.paths.secrets]) ensureDir(d);
    ensureDir(this.paths.files, 0o700);
    ensureRepo(this.paths.chat);
    ensureRepo(this.paths.files);
    this.mem = new Memory(this.paths.chat, model, { log: (m) => this.log(m) });
    this.tools = new Tools(this.mem, this.paths.files, this.paths.links);
    this.policy = loadPolicy(this.paths.policy, defaultPolicy(os.homedir(), conf.codeDir, conf.otherHomes ?? [], this.paths.root)); // throws on a bad file
    this.token = this.loadToken();
    this.mem.compactor.onBuilt = () => this.emit({ ev: "built" });
  }

  /** Status and errors: stderr (journald) AND every attached client. Never message text. */
  log(msg: string): void {
    (this.conf.log ?? ((m: string) => console.error(m)))(msg);
    this.emit({ ev: "info", text: msg });
  }

  /** attach, bridge and ctl clients must show this secret. It is a bar, not a wall: see PLAN.md, D1. */
  private loadToken(): string {
    return ensureClientToken(this.paths);
  }

  private tokenOk(given: unknown): boolean {
    if (typeof given !== "string" || given.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.token));
  }

  // ---------------------------------------------------------------- socket

  /** Take the lock, then serve. (The CLI claims the lock BEFORE building the Service; this is for convenience.) */
  async listen(): Promise<boolean> {
    const server = await claimLock(this.paths.sock);
    if (!server) return false;
    this.serve(server);
    return true;
  }

  /** Start accepting clients on a socket that already holds the lock. */
  serve(server: net.Server & { pending?: net.Socket[] }): void {
    this.server = server;
    server.on("connection", (c) => this.onClient(c));
    for (const c of server.pending ?? []) this.onClient(c);
    server.pending = [];
    this.recoverJournal();
    this.recoverInbox();
    this.mem.start();
  }

  private onClient(sock: net.Socket): void {
    const client: Client = {
      id: this.nextClient++,
      role: "?",
      sock,
      send: (o) => sock.writable && sock.write(JSON.stringify(o) + "\n"),
    };
    let buf = "";
    sock.setEncoding("utf8"); // decodes a character split across two chunks correctly
    sock.on("data", (d: string) => {
      buf += d;
      if (buf.length > MAX_LINE_CHARS) return void sock.destroy();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.onMessage(client, JSON.parse(line));
        } catch (e: any) {
          client.send({ ev: "error", text: String(e?.message ?? e) });
        }
      }
    });
    sock.on("close", () => this.clients.delete(client));
    sock.on("error", () => this.clients.delete(client));
    sock.resume();
  }

  private onMessage(c: Client, m: any): void {
    if (!m || typeof m !== "object") throw new Error("bad message");
    if (m.t === "hello") {
      const role = ["attach", "bridge", "mcp", "ctl"].includes(m.role) ? m.role : "ctl";
      if (role !== "mcp" && !this.tokenOk(m.token)) {
        c.send({ ev: "error", text: "not authorized: this client has no valid token (secrets/client-token)" });
        c.sock.end();
        return;
      }
      c.role = role;
      this.clients.add(c);
      c.send({ ev: "hello", messages: this.mem.store.total, turning: this.turning });
      if (c.role === "attach" || c.role === "bridge") {
        const replay = m.since === undefined ? this.ring.slice(-20) : this.ring.filter((r) => r.seq > Number(m.since));
        for (const r of replay) if (this.visible(c, r.ev)) c.send({ ...r.ev, seq: r.seq });
        for (const cf of this.confirms.values()) c.send({ ev: "confirm", nonce: cf.nonce, tool: cf.tool, why: cf.why, expires: cf.expires });
      }
      return;
    }
    switch (c.role) {
      case "attach":
      case "bridge":
        if (m.t === "input") {
          if (typeof m.text !== "string" || !m.text.trim()) throw new Error("input needs a non-empty text");
          this.submit({ kind: m.kind === "fwd" ? "fwd" : "user", text: m.text }); // only these two can come from a person
        } else if (m.t === "cancel") this.cancel();
        else if (m.t === "answer") {
          if (typeof m.nonce !== "string") throw new Error("answer needs a nonce");
          this.answer(m.nonce, m.allow === true, `${c.role}#${c.id}`); // only a real `true` allows
        }
        break;
      case "mcp":
        if (m.t === "call")
          this.call(String(m.name), m.args ?? {}).then(
            (text) => c.send({ t: "result", id: m.id, text }),
            (e) => c.send({ t: "result", id: m.id, text: `error: ${e?.message ?? e}`, error: true }),
          );
        break;
      case "ctl":
        if (m.t === "ctl")
          this.ctl(m).then(
            (text) => c.send({ t: "ctl_result", id: m.id, ok: true, text }),
            (e) => c.send({ t: "ctl_result", id: m.id, ok: false, text: String(e?.message ?? e) }),
          );
        break;
    }
  }

  private visible(c: Client, ev: any): boolean {
    if (c.role !== "bridge") return true;
    // the phone gets replies, confirmations and notices, never tool calls or results
    return (ev.ev === "entry" && ev.kind === "talk") || ev.ev === "confirm" || ev.ev === "confirm_done" || ev.ev === "info";
  }

  emit(ev: any): void {
    if (this.replaying) return;
    const seq = ++this.seq;
    if (ev.ev !== "built" && ev.ev !== "confirm" && ev.ev !== "confirm_done") {
      this.ring.push({ seq, ev });
      if (this.ring.length > 300) this.ring.shift();
    }
    for (const c of this.clients) if ((c.role === "attach" || c.role === "bridge") && this.visible(c, ev)) c.send({ ...ev, seq });
  }

  /** After a redaction: nothing the ring replays may still hold the secret. */
  clearRing(): void {
    this.ring.length = 0;
  }

  // ---------------------------------------------------------------- inbox: an accepted message survives a crash

  private inboxWrite(rec: object): void {
    appendDurable(this.paths.inbox, JSON.stringify(rec) + "\n");
    this.inboxLines++;
  }

  private inboxAdd(item: Item): number {
    const id = this.inboxSeq++;
    this.inboxWrite({ add: id, item: { kind: item.kind, text: item.text, byUser: item.byUser } });
    this.inboxPending.add(id);
    return id;
  }

  private inboxDone(id: number): void {
    if (!this.inboxPending.delete(id)) return;
    try {
      this.inboxWrite({ done: id });
      if (!this.inboxPending.size && this.inboxLines > 200) {
        writeAtomic(this.paths.inbox, "");
        this.inboxLines = 0;
      }
    } catch (e: any) {
      this.log(`inbox: could not record a delivered message (${e?.message ?? e}); it may be answered twice after a restart`);
    }
  }

  /** Messages accepted before the last stop but not yet in the log: answer them now. */
  private recoverInbox(): void {
    const { rows } = readJsonl<any>(this.paths.inbox);
    const pend = new Map<number, Item>();
    for (const r of rows) {
      if (typeof r.add === "number") {
        pend.set(r.add, r.item);
        this.inboxSeq = Math.max(this.inboxSeq, r.add + 1);
      } else if (typeof r.done === "number") pend.delete(r.done);
    }
    this.inboxLines = rows.length;
    const recent = this.mem.store.msgs.slice(-20);
    let n = 0;
    for (const [id, item] of pend) {
      this.inboxPending.add(id);
      // the crash may have come between the log write and the "done": do not answer it twice
      if (recent.some((m) => m.kind === item.kind && m.text === item.text.toWellFormed())) {
        this.inboxDone(id);
        continue;
      }
      this.queue.push({ ...item, inboxId: id });
      n++;
    }
    if (n) {
      this.log(`${n} message(s) accepted before the last stop are being answered now`);
      void this.runTurns();
    }
  }

  // ---------------------------------------------------------------- input

  /** A message from the user (or a report, a file record, a forward). It is durable before this returns. */
  submit(item: Item): void {
    if (typeof item.text !== "string" || !item.text.trim()) throw new Error("empty message");
    if (item.text.length > MAX_ITEM_CHARS) throw new Error(`message too long (over ${MAX_ITEM_CHARS} characters)`);
    item.inboxId = this.inboxAdd(item);
    if (this.child && !this.ending && this.child.stdin.writable && !this.locked) {
      const uuid = crypto.randomUUID();
      this.sentMid.set(uuid, item);
      this.child.stdin.write(userLine([{ type: "text", text: `${item.kind}: ${item.text}` }], uuid));
      return; // logged when the CLI echoes it as consumed
    }
    this.queue.push(item);
    void this.runTurns();
  }

  /** Log an item with its own kind, and index its links. */
  logItem(item: Item): void {
    const m = this.mem.add(item.kind, item.text);
    if (item.inboxId !== undefined) this.inboxDone(item.inboxId);
    if (item.kind === "user" || item.kind === "file" || item.kind === "fwd") {
      try {
        indexLinks(this.paths.links, m.i, m.date, item.text);
      } catch (e: any) {
        this.log(`link index: ${e?.message ?? e}`);
      }
    }
    this.emit({ ev: "entry", kind: item.kind, text: item.text, id: m.i });
  }

  cancel(): void {
    this.cancelled = true;
    this.waitAbort?.abort();
    for (const c of [...this.confirms.values()]) c.resolve(false, "cancel");
    if (this.child) this.killChild(this.child);
  }

  /** SIGINT, then SIGTERM, then SIGKILL: a child that ignores the first must not stay alive. */
  private killChild(child: ChildProcessWithoutNullStreams): void {
    const grace = this.conf.killGraceMs ?? KILL_GRACE_MS;
    const alive = () => child.exitCode === null && child.signalCode === null;
    child.kill("SIGINT");
    const t1 = setTimeout(() => alive() && child.kill("SIGTERM"), grace);
    const t2 = setTimeout(() => alive() && child.kill("SIGKILL"), grace * 2);
    child.once("close", () => (clearTimeout(t1), clearTimeout(t2)));
  }

  // ---------------------------------------------------------------- turns

  private async runTurns(): Promise<void> {
    if (this.turning) return;
    this.turning = true;
    this.held = false;
    try {
      while (this.queue.length && !this.locked) {
        if (this.nonUserTurns >= AUTONOMY_LIMIT && !this.queue.some(userDriven)) {
          this.held = true;
          this.log(`${this.queue.length} report(s) held: ${AUTONOMY_LIMIT} turns in a row started without you. Send a message to continue.`);
          break;
        }
        this.cancelled = false;
        this.emit({ ev: "status", text: "waiting for summaries" });
        this.waitAbort = new AbortController();
        const ok = await this.mem.view.settle(this.waitAbort.signal);
        this.waitAbort = undefined;
        if (this.locked) continue; // a redaction owns the files: the queue waits
        const items = this.queue.splice(0);
        if (!ok) {
          // wait cancelled: the messages stay in the log, unanswered
          for (const it of items) this.logItem(it);
          this.log("wait cancelled; your message is logged and unanswered");
          break;
        }
        this.nonUserTurns = items.some(userDriven) ? 0 : this.nonUserTurns + 1;
        const pieces = this.mem.renderPieces(this.conf.marks ?? MASTER_MARKS); // BEFORE logging the new messages
        for (const it of items) this.logItem(it);
        await this.runClaude(items, pieces);
        this.turnNo++;
        const label = `turn ${this.turnNo}`;
        const okC = await this.commit(this.paths.chat, label);
        const okF = await this.commit(this.paths.files, label);
        if (!(okC && okF) && !this.warnedCommit) {
          this.warnedCommit = true;
          this.log("git commit failed for the chat or files folder: the per-turn history is not being kept (the log itself is fine)");
        }
      }
    } finally {
      this.turning = false;
      this.emit({ ev: "status", text: "idle" });
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private idleWaiters: Array<() => void> = [];
  private held = false;

  private gitChain: Promise<unknown> = Promise.resolve();

  /** All git commits go one after another: two at once would fight over .git/index.lock. */
  commit(dir: string, label: string): Promise<boolean> {
    const p = this.gitChain.then(() => commitAll(dir, label));
    this.gitChain = p.catch(() => {});
    return p;
  }

  /** Resolves when every commit asked for so far has finished. */
  gitIdle(): Promise<unknown> {
    return this.gitChain;
  }

  /** Start a turn for anything that waited (after a redaction). */
  kick(): void {
    if (this.queue.length) void this.runTurns();
  }

  /** Resolves when no turn is running and nothing is waiting to run (held reports excepted). */
  idle(): Promise<void> {
    if (!this.turning && (!this.queue.length || this.held)) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private systemPrompt(): string {
    let agents = "";
    try {
      agents = fs.readFileSync(this.paths.agents, "utf8").trim();
    } catch {
      // no instructions file
    }
    return [MASTER, VIEW_DOC, agents].filter(Boolean).join("\n\n") + "\n";
  }

  private childEnv(): Record<string, string> {
    // An allow-list, not a scrubbed copy: ANTHROPIC_API_KEY & co. never reach the master,
    // or it would bill the API instead of the subscription.
    const env: Record<string, string> = {
      HOME: os.homedir(),
      USER: os.userInfo().username,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      DISABLE_AUTOUPDATER: "1",
      MCP_TOOL_TIMEOUT: String((this.conf.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS) + 300_000),
      OPTCHAT_HOME: this.paths.root,
    };
    if (this.conf.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.conf.oauthToken;
    return env;
  }

  private claudeArgs(): string[] {
    const sys = path.join(this.paths.run, "system.txt");
    const text = this.systemPrompt();
    try {
      if (fs.readFileSync(sys, "utf8") !== text) throw 0;
    } catch {
      fs.writeFileSync(sys, text, { mode: 0o600 });
    }
    const [cmd, ...args] = this.conf.mcpCommand;
    const mcp = path.join(this.paths.run, "mcp.json");
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { optchat: { type: "stdio", command: cmd, args, env: { OPTCHAT_HOME: this.paths.root } } } }), { mode: 0o600 });
    // Every tool call goes through the harness policy first (hook), so Claude Code's own
    // "safe command" auto-allow rules cannot decide instead of us. Calls the policy marks
    // "ask" fall through to the permission prompt tool (approve), which asks the user.
    // "|| exit 2": if the hook crashes or cannot start, that is a BLOCKING error. Any other
    // failure is non-blocking in Claude Code, which would then use its own allow rules.
    const hookCmd = [...this.conf.mcpCommand.slice(0, -1), "hook"].map(shq).join(" ") + " || exit 2";
    const settings = path.join(this.paths.run, "settings.json");
    fs.writeFileSync(
      settings,
      // matcher: only the built-in tools. Our own (zoom, date, search) are always allowed: no hook process for them.
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: MASTER_TOOLS.join("|"), hooks: [{ type: "command", command: hookCmd, timeout: 30 }] }] } }),
      { mode: 0o600 },
    );
    return [
      "-p",
      "--settings", settings,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--system-prompt-file", sys,
      "--mcp-config", mcp,
      "--strict-mcp-config",
      "--permission-prompt-tool", "mcp__optchat__approve",
      "--allowedTools", "mcp__optchat__zoom", "mcp__optchat__date", "mcp__optchat__search",
      "--tools", MASTER_TOOLS.join(","),
      "--disallowedTools", "Task",
      "--no-session-persistence",
      "--setting-sources", "",
      "--model", this.conf.masterModel ?? "opus",
      ...(this.conf.extraClaudeArgs ?? []),
    ];
  }

  private runClaude(items: Item[], pieces: string[]): Promise<void> {
    return new Promise((resolve) => {
      const st = (this.st = newTurnState());
      const cwd = this.paths.run;
      const args = this.claudeArgs();
      const env = this.childEnv();
      const child = (this.conf.spawnClaude ?? ((a, e, c) => spawn(this.conf.claudeBin ?? "claude", a, { env: e, cwd: c }) as ChildProcessWithoutNullStreams))(args, env, cwd);
      this.child = child;
      this.ending = false;
      const journal = path.join(this.paths.run, "turn.jsonl");
      fs.writeFileSync(journal, "", { mode: 0o600 });

      const blocks: any[] = pieces.map((text, k) =>
        k < pieces.length - 1 ? { type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } } : { type: "text", text },
      );
      blocks.push({ type: "text", text: items.map((i) => `${i.kind}: ${i.text}`).join("\n\n") });
      child.stdin.on("error", () => {});
      child.stdin.write(userLine(blocks, crypto.randomUUID()));

      let buf = "";
      let stderr = "";
      child.stdout.setEncoding("utf8"); // a multi-byte character can straddle two chunks
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          try {
            fs.appendFileSync(journal, JSON.stringify({ ev }) + "\n");
            this.handleEvent(ev, st);
          } catch (e: any) {
            // one odd event must not take the whole service down
            this.log(`could not handle a ${ev?.type} event from claude: ${e?.message ?? e}`);
          }
          if (ev.type === "result") {
            this.ending = true;
            child.stdin.end();
          }
          if (!st.initOk) this.killChild(child);
        }
      });
      child.stderr.on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
      child.on("error", (e) => this.log(`could not start claude: ${e.message}`));
      child.on("close", (code) => {
        try {
          this.finishSteps(st, "(no result: the turn ended)");
        } catch (e: any) {
          this.log(`could not log the last steps: ${e?.message ?? e}`);
        }
        // Items sent mid-run that the CLI never consumed: after a cancel they are logged and left
        // unanswered (spec); otherwise they wait for the next turn. Either way they are still in the inbox.
        const lost = [...this.sentMid.values()];
        this.sentMid.clear();
        if (lost.length) {
          if (this.cancelled && !this.locked) for (const it of lost) this.logItem(it);
          else this.queue.unshift(...lost);
        }
        this.child = undefined;
        this.ending = false;
        if (!st.result && !this.cancelled && st.initOk) this.log(`claude exited (${code}) without a result. ${stderr.trim().slice(-400)}`);
        this.lastTurnEnd = Date.now();
        try {
          fs.unlinkSync(journal);
        } catch {
          // already gone
        }
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------- stream

  private logOnce(st: TurnState, uid: string, kind: Kind, text: string): void {
    if (st.logged.has(uid)) return;
    st.logged.add(uid);
    const m = this.mem.add(kind, text);
    try {
      fs.appendFileSync(path.join(this.paths.run, "turn.jsonl"), JSON.stringify({ logged: uid }) + "\n");
    } catch {
      // journal is best effort
    }
    this.emit({ ev: "entry", kind, text, id: m.i });
  }

  handleEvent(ev: any, st: TurnState): void {
    if (!st.initOk && ev.type !== "system") return; // this turn was stopped: nothing it says is logged
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          // An allow-list: only the measured subscription values continue. A missing field is a failure too.
          const src = String(ev.apiKeySource ?? "<missing>");
          if (!SUBSCRIPTION_SOURCES.has(src)) {
            st.initOk = false;
            this.log(`ABORTED: claude reports apiKeySource "${src}", not the subscription: it could bill an API key.`);
          } else this.emit({ ev: "status", text: `running (${ev.model ?? "?"})` });
        }
        break;
      case "assistant": {
        const msg = ev.message ?? {};
        const uk = msg.id ?? ev.uuid;
        if (msg.usage && uk && !st.usageSeen.has(uk)) {
          st.usageSeen.add(uk);
          this.logUsage(st, msg);
        }
        (msg.content ?? []).forEach((b: any, idx: number) => {
          const uid = `${ev.uuid ?? msg.id}#${idx}`;
          if (b.type === "text" && String(b.text).trim()) this.logOnce(st, uid, "talk", b.text);
          else if (b.type === "thinking" && b.thinking) this.emit({ ev: "entry", kind: "thought", text: b.thinking }); // shown, never logged
          else if (b.type === "tool_use") {
            st.pending.set(b.id, { name: String(b.name), input: b.input ?? {} });
            st.order.push(b.id);
            this.emit({ ev: "entry", kind: "tool", text: `${shortName(String(b.name))} ${capHeadTail(JSON.stringify(b.input ?? {}), 300)}` });
          }
        });
        break;
      }
      case "user": {
        if (ev.isReplay) {
          const item = this.sentMid.get(ev.uuid);
          if (item) {
            this.sentMid.delete(ev.uuid);
            this.logItem(item); // consumed by the CLI between tool calls: now it is part of the log
          }
          break;
        }
        const content = ev.message?.content;
        if (Array.isArray(content))
          for (const b of content)
            if (b.type === "tool_result") {
              st.done.set(b.tool_use_id, (b.is_error ? "error: " : "") + resultText(b.content));
              this.flushSteps(st);
            }
        break;
      }
      case "result":
        st.result = ev;
        if (ev.is_error) this.log(`turn error: ${String(ev.result ?? ev.terminal_reason).slice(0, 400)}`);
        break;
    }
  }

  /** Log finished tool calls in call order, one `step` per call. */
  private flushSteps(st: TurnState): void {
    while (st.order.length && st.done.has(st.order[0])) {
      const id = st.order.shift()!;
      this.logStep(st, id, st.done.get(id)!);
    }
  }

  private finishSteps(st: TurnState, note: string): void {
    this.flushSteps(st);
    // An earlier call that never returned blocked the rest: log them in call order,
    // each with its own result if it has one.
    for (const id of st.order.splice(0)) this.logStep(st, id, st.done.get(id) ?? note);
  }

  private logStep(st: TurnState, id: string, result: string): void {
    const p = st.pending.get(id);
    if (!p) return;
    st.pending.delete(id);
    const text = `${shortName(p.name)} ${capHeadTail(JSON.stringify(p.input ?? {}) ?? "{}", STEP_INPUT_CAP)}\n→ ${capHeadTail(String(result), CAP)}`;
    this.logOnce(st, id, "step", text);
  }

  private logUsage(st: TurnState, msg: any): void {
    if (this.replaying) return; // a recovered turn's usage was counted when it ran
    const u = msg.usage ?? {};
    st.step++;
    const row = {
      turn: this.turnNo,
      step: st.step,
      model: msg.model,
      input: u.input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      cache_write_5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      gap_s: st.step === 1 && this.lastTurnEnd ? Math.round((Date.now() - this.lastTurnEnd) / 1000) : null,
    };
    try {
      fs.appendFileSync(path.join(this.paths.run, "usage.jsonl"), JSON.stringify(row) + "\n"); // measurement only: no fsync
    } catch {
      // measurement only
    }
  }

  /** After a crash: log what the interrupted turn did but never wrote to the log. */
  private recoverJournal(): void {
    const journal = path.join(this.paths.run, "turn.jsonl");
    if (!fs.existsSync(journal)) return;
    const { rows } = readJsonl<any>(journal);
    const st = newTurnState();
    for (const l of rows) if (l?.logged) st.logged.add(l.logged);
    this.replaying = true; // no usage rows, no events: only the log writes matter
    try {
      for (const l of rows) {
        if (!l?.ev || l.ev.type === "result") continue;
        try {
          this.handleEvent({ ...l.ev, isReplay: false }, st);
        } catch (e: any) {
          console.error(`recovery: skipped an event (${e?.message ?? e})`);
        }
      }
      this.finishSteps(st, "(no result: harness restarted)");
    } finally {
      this.replaying = false;
    }
    try {
      fs.unlinkSync(journal);
    } catch {
      // gone
    }
  }

  // ---------------------------------------------------------------- tools & confirmations

  async call(name: string, args: any): Promise<string> {
    switch (name) {
      case "zoom":
        return this.tools.zoom(Number(args.id), Number(args.n));
      case "date":
        return this.tools.date(Number(args.id));
      case "search":
        return this.tools.search(String(args.text ?? ""));
      case "hook": {
        // PreToolUse: the same policy, asked before Claude Code's own auto-allow rules can decide.
        // The hook says where Claude is (`cwd`): relative paths resolve against that.
        const pol = typeof args.cwd === "string" && path.isAbsolute(args.cwd) ? { ...this.policy, cwd: args.cwd } : this.policy;
        return JSON.stringify(decide(String(args.tool_name ?? ""), args.tool_input ?? {}, pol));
      }
      case "approve":
        return JSON.stringify(await this.approve(String(args.tool_name ?? ""), args.input ?? {}));
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  /** The permission prompt tool: the harness decides, and asks the user for the rest. */
  async approve(tool: string, input: any): Promise<any> {
    const d = decide(tool, input, this.policy);
    if (d.verdict === "allow") return { behavior: "allow", updatedInput: d.updatedInput ?? input };
    if (d.verdict === "deny") return { behavior: "deny", message: `Denied by the harness: ${d.why}.` };
    const nonce = crypto.randomBytes(8).toString("hex");
    const timeout = this.conf.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    const allow = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(false, "timeout"), timeout);
      const done = (a: boolean, by: string) => {
        if (!this.confirms.delete(nonce)) return;
        clearTimeout(timer);
        this.emit({ ev: "confirm_done", nonce, allow: a, by });
        resolve(a);
      };
      this.confirms.set(nonce, { nonce, tool, why: d.why, expires: Date.now() + timeout, resolve: done });
      this.emit({ ev: "confirm", nonce, tool, why: d.why, expires: Date.now() + timeout });
    });
    return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "denied: the user said no, or did not answer in time" };
  }

  answer(nonce: string, allow: boolean, by: string): void {
    this.confirms.get(nonce)?.resolve(allow, by); // the first valid answer wins; later ones find nothing
  }

  // ---------------------------------------------------------------- control

  /** Hooks for ctl commands that live in other modules (redact, file, import, backup). */
  handlers = new Map<string, (m: any) => Promise<string>>();

  async ctl(m: any): Promise<string> {
    switch (m.cmd) {
      case "status":
        return JSON.stringify(this.status(), null, 2);
      case "view":
        return this.mem.render();
      case "stop":
        this.cancel();
        return "stopped";
      case "shutdown":
        setTimeout(() => void this.shutdown().then(() => process.exit(0)), 50);
        return "shutting down";
      default: {
        const h = this.handlers.get(m.cmd);
        if (!h) throw new Error(`unknown command ${m.cmd}`);
        return h(m);
      }
    }
  }

  status() {
    const c = this.mem.compactor;
    return {
      messages: this.mem.store.total,
      nodes: this.mem.store.nodes.size,
      viewBytes: this.mem.view.bytes(),
      viewParts: this.mem.view.parts.length,
      settled: this.mem.view.settled(),
      compactorBusy: c.busy.size,
      dirty: c.dirty.size,
      turning: this.turning,
      queued: this.queue.length,
      inboxPending: this.inboxPending.size,
      pendingConfirmations: this.confirms.size,
      turns: this.turnNo,
      locked: this.locked,
      compactorUsage: { ...compactorUsage, add: undefined },
    };
  }

  async shutdown(): Promise<void> {
    this.cancel();
    for (let k = 0; k < 250 && this.child; k++) await new Promise((r) => setTimeout(r, 50));
    this.server?.close();
    try {
      fs.unlinkSync(this.paths.sock);
    } catch {
      // gone
    }
  }

  /** Stop the running turn for good (SIGINT, SIGTERM, SIGKILL). Throws if it will not die. */
  async stopTurn(): Promise<void> {
    this.cancel(); // queued messages stay queued: they run after the redaction (see kick)
    const grace = this.conf.killGraceMs ?? KILL_GRACE_MS;
    const until = Date.now() + grace * 2 + 5000;
    while ((this.child || this.turning) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    if (this.child) throw new Error("the running turn would not stop; nothing was changed");
  }

  /**
   * One owner of the files: no turn, no compactor job, no import while `fn` runs. Used by redaction,
   * at a request and at startup. The queue waits and is run afterwards.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) throw new Error("a redaction is already running");
    this.locked = true;
    try {
      await this.stopTurn();
      this.mem.compactor.halt();
      return await fn();
    } finally {
      this.locked = false;
      this.mem.view.nodeBuilt();
      this.mem.compactor.resume();
      this.kick();
    }
  }
}

function userLine(content: any[], uuid: string): string {
  return JSON.stringify({ type: "user", uuid, message: { role: "user", content } }) + "\n";
}

const shortName = (n: string) => n.replace(/^mcp__optchat__/, "");

function resultText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  return JSON.stringify(c);
}

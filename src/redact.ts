import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { haveRestic, resticBackup, resticPurge, resticRestore } from "./backup.ts";
import { appendDurable, readJsonl, writeAtomic } from "./fsx.ts";
import { linkRows, type LinkRow } from "./links.ts";
import type { Service } from "./service.ts";
import { freeLeaf, freeMerge } from "./tree.ts";
import { bytes, key, type Msg, type Node } from "./types.ts";

const execP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RedactReq {
  id: number;
  whole?: boolean;
  literal?: string;
}

const MARK = "[REDACTED]";
const REBUILDING = "(summary being rebuilt after redaction)";
const MIN_LITERAL = 4;
const TEXT_EXT = /\.(txt|md|json|jsonl|csv|tsv|log|tex|html?|xml|ya?ml|toml|ini|cfg)$/i;

// ---------------------------------------------------------------- the forms a secret can take

const jsonEsc = (s: string) => JSON.stringify(s).slice(1, -1);

/** Base64 of the secret at each of the 3 byte alignments, keeping only the characters that do not depend on the neighbours. */
function b64forms(lit: string): string[] {
  const b = Buffer.from(lit, "utf8");
  const out = new Set<string>();
  for (let k = 0; k < 3; k++) {
    let s = Buffer.concat([Buffer.alloc(k), b]).toString("base64").replace(/=+$/, "");
    if ((k + b.length) % 3 !== 0) s = s.slice(0, -1); // the last character mixes in the next byte
    s = s.slice([0, 2, 3][k]); // the first characters mix in the padding bytes
    if (s.length >= 8) {
      out.add(s);
      out.add(s.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...out];
}

/** The forms to look for in DECODED text (message and node texts). */
export function forms(lit: string): string[] {
  const b = Buffer.from(lit, "utf8");
  const pct = encodeURIComponent(lit);
  const base = [lit, pct, pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), b.toString("hex"), ...b64forms(lit)];
  // A tool call is logged as JSON.stringify(input): the secret sits in a step's text already JSON-escaped.
  const all = new Set([...base, ...base.map(jsonEsc)]);
  return [...all].filter((f) => f.length >= MIN_LITERAL).sort((a, c) => c.length - a.length);
}

/** The forms to look for in RAW FILE BYTES: the decoded forms, and how JSON stores them (once, and twice for a step's embedded input). */
export function diskForms(F: string[]): string[] {
  const all = new Set<string>();
  for (const f of F) {
    all.add(f);
    const once = jsonEsc(f);
    all.add(once);
    all.add(jsonEsc(once));
  }
  return [...all].filter((f) => f.length >= MIN_LITERAL);
}

const scrub = (s: string, F: string[]): string => F.reduce((t, f) => t.split(f).join(MARK), s);
const has = (s: string, F: string[]): boolean => F.some((f) => s.includes(f));
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- journal

type Step = "started" | "applied" | "history" | "manual" | "backup" | "verified" | "report" | "done";

interface JournalEntry {
  ts: string;
  id: number;
  mode: "literal" | "whole";
  step: Step;
  plan?: string;
  dirty?: string[];
  since?: string;
  files?: string[];
  oldHeads?: Record<string, string>;
  newHeads?: Record<string, string>;
  open?: string[];
  skipped?: boolean;
  ok?: boolean;
}

function journal(svc: Service, e: JournalEntry): void {
  appendDurable(svc.paths.redactions, JSON.stringify(e) + "\n"); // never the secret, not even a hash
}

/** One torn line (power loss mid-append) must not make the whole journal unreadable. */
function readJournal(svc: Service): JournalEntry[] {
  return readJsonl<JournalEntry>(svc.paths.redactions).rows.filter((e) => e && typeof e.ts === "string" && typeof e.step === "string");
}

function byTs(svc: Service): Map<string, JournalEntry[]> {
  const m = new Map<string, JournalEntry[]>();
  for (const e of readJournal(svc)) m.set(e.ts, [...(m.get(e.ts) ?? []), e]);
  return m;
}

// ---------------------------------------------------------------- the plan

interface Plan {
  msgs: Msg[];
  nodes: Node[];
  dirty: string[];
  /** Hash of each line BEFORE the redaction: a plan is applied only where the line is still as it was. */
  pre: Record<string, string>;
}

const preKey = (kind: "m" | "n", k: string | number) => `${kind}:${k}`;

function validate(svc: Service, req: RedactReq): void {
  if (!Number.isInteger(req.id) || req.id < 0 || req.id >= svc.mem.store.total) throw new Error(`no message ${req.id}`);
  if (req.whole && req.literal) throw new Error("give --whole OR --literal, not both");
  if (!req.whole && !req.literal) throw new Error("give --literal or --whole");
  if (req.literal && req.literal.length < MIN_LITERAL)
    throw new Error(`the secret is too short to find safely (under ${MIN_LITERAL} characters); use --whole to replace the whole message instead`);
}

/** Compute the changes. Touches nothing on disk. */
function plan(svc: Service, req: RedactReq, F: string[]): Plan {
  const store = svc.mem.store;
  const msgs = new Map<number, Msg>();
  const withText = (m: Msg, text: string): Msg => ({ ...m, text, size: bytes(`${m.kind}: ${text}`) });
  if (req.whole) msgs.set(req.id, withText(store.msgs[req.id], "(redacted)"));
  if (F.length) for (const m of store.msgs) if (has(m.text, F)) msgs.set(m.i, withText(m, scrub(m.text, F)));

  const nodes = new Map<string, Node>();
  const dirty = new Set<string>();
  const cur = (l: number, i: number): Node | undefined => nodes.get(key(l, i)) ?? store.node(l, i);

  // 1. the leaf of each changed message, and every ancestor of it, bottom-up
  let level = new Set<number>(msgs.keys());
  for (let l = 0; level.size; l++) {
    const next = new Set<number>();
    for (const i of level) {
      const old = store.node(l, i);
      if (old) {
        let fresh: Node | null;
        if (l === 0) fresh = freeLeaf(msgs.get(i) ?? store.msgs[i]);
        else if (dirty.has(key(l - 1, 2 * i)) || dirty.has(key(l - 1, 2 * i + 1))) fresh = null; // a child still waits for its rebuild: so does the parent
        else fresh = freeMerge(l, i, cur(l - 1, 2 * i)!, cur(l - 1, 2 * i + 1)!);
        if (fresh) nodes.set(key(l, i), fresh); // free: exact text of clean sources, nothing to rebuild
        else {
          const text = F.length ? scrub(old.text, F) : REBUILDING;
          nodes.set(key(l, i), { ...old, text, size: bytes(text) });
          dirty.add(key(l, i));
        }
      }
      next.add(Math.floor(i / 2));
    }
    level = 2 ** (l + 1) <= store.total ? next : new Set();
  }

  // 2. nodes that are NOT above a changed message but still hold the secret:
  // a compactor call sees the whole view, so it can copy detail from anywhere.
  if (F.length)
    for (const [k, n] of store.nodes)
      if (!nodes.has(k) && has(n.text, F)) {
        const text = scrub(n.text, F);
        nodes.set(k, { ...n, text, size: bytes(text) });
        dirty.add(k);
      }

  const pre: Record<string, string> = {};
  for (const m of msgs.values()) pre[preKey("m", m.i)] = sha(JSON.stringify(store.msgs[m.i]));
  for (const [k, n] of nodes) pre[preKey("n", k)] = sha(JSON.stringify(store.nodes.get(k)));
  return { msgs: [...msgs.values()], nodes: [...nodes.values()], dirty: [...dirty], pre };
}

/** Apply a plan to the lines that are still as they were when it was made. */
function applyPlan(svc: Service, p: Plan): string[] {
  const store = svc.mem.store;
  const msgs = new Map<number, Msg>();
  for (const m of p.msgs) if (!p.pre || p.pre[preKey("m", m.i)] === sha(JSON.stringify(store.msgs[m.i]))) msgs.set(m.i, m);
  const nodes = new Map<string, Node>();
  for (const n of p.nodes) {
    const k = key(n.l, n.i);
    if (store.nodes.has(k) && (!p.pre || p.pre[preKey("n", k)] === sha(JSON.stringify(store.nodes.get(k))))) nodes.set(k, n);
  }
  const touched = store.rewrite(msgs, nodes);
  for (const k of p.dirty) if (nodes.has(k)) svc.mem.compactor.dirty.add(k);
  return touched;
}

function loadPlan(file?: string): Plan | undefined {
  if (!file) return undefined;
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(p?.msgs) && Array.isArray(p?.nodes) ? p : undefined;
  } catch {
    return undefined; // missing, empty or torn
  }
}

// ---------------------------------------------------------------- side files

interface SideResult {
  touched: string[];
  /** Oldest date among the copies that were cleaned: backups from there on may hold the secret. */
  since?: string;
  /** Copies that cannot be edited here (PDFs, binaries): the user must remove them. */
  unfixable: string[];
}

function scrubSideFiles(svc: Service, req: RedactReq, F: string[], changed: Msg[]): SideResult {
  const touched: string[] = [];
  const unfixable: string[] = [];
  let since: string | undefined;
  const older = (d?: string) => d && (!since || new Date(d) < new Date(since)) && (since = d);

  // link index: the rows of every changed message are dropped and made again from its cleaned text
  const { rows } = readJsonl<LinkRow>(svc.paths.links);
  if (rows.length) {
    const changedIds = new Map(changed.map((m) => [m.i, m]));
    const out: LinkRow[] = [];
    let did = false;
    for (const r of rows) {
      const c = changedIds.get(r.id);
      if (c) {
        did = true;
        older(r.date);
        continue;
      }
      if (F.length && (has(r.url ?? "", F) || has(r.context ?? "", F))) {
        did = true;
        older(r.date);
        out.push({ ...r, url: scrub(r.url ?? "", F), context: scrub(r.context ?? "", F) });
      } else out.push(r);
    }
    if (did) {
      for (const m of changed) if (m.kind === "user" || m.kind === "file" || m.kind === "fwd") out.push(...linkRows(m.i, m.date, m.text));
      writeAtomic(svc.paths.links, out.length ? out.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
      touched.push(svc.paths.links);
    }
  }

  // saved files: text files are edited; anything else that holds the secret is reported
  if (F.length) {
    const needles = diskForms(F).map((f) => Buffer.from(f, "utf8"));
    let names: string[] = [];
    try {
      names = fs.readdirSync(svc.paths.files);
    } catch {
      // no files folder
    }
    for (const f of names) {
      const file = path.join(svc.paths.files, f);
      let buf: Buffer;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
        if (!st.isFile()) continue;
        buf = fs.readFileSync(file);
      } catch {
        unfixable.push(`${file} (could not be read)`);
        continue;
      }
      if (!needles.some((n) => buf.includes(n))) continue;
      older(st.mtime.toISOString());
      if (TEXT_EXT.test(f)) {
        writeAtomic(file, scrub(buf.toString("utf8"), F), 0o600);
        touched.push(file);
      } else unfixable.push(file);
    }
  }

  // derived copies of the whole memory: gone (they are made again on demand)
  for (const f of ["browse.html"]) {
    const p = path.join(svc.paths.run, f);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      touched.push(p);
    }
  }
  return { touched, since, unfixable };
}

// ---------------------------------------------------------------- git history

let filterRepoOk: boolean | undefined;
export function haveFilterRepo(): boolean {
  if (filterRepoOk === undefined) {
    try {
      execFileSync("git", ["filter-repo", "--version"], { stdio: "ignore", timeout: 10_000 });
      filterRepoOk = true;
    } catch {
      filterRepoOk = false;
    }
  }
  return filterRepoOk;
}
export const resetFilterRepoProbe = () => (filterRepoOk = undefined);

const hasGit = (dir: string) => fs.existsSync(path.join(dir, ".git"));

const BLOB_CALLBACK = `
import json, os
global MAP
try:
    MAP
except NameError:
    MAP = json.load(open(os.environ["OPTCHAT_REDACT_MAP"]))
out = []
for line in blob.data.split(b"\\n"):
    if line:
        try:
            d = json.loads(line)
        except Exception:
            d = None
        if isinstance(d, dict):
            if "kind" in d and "text" in d and "i" in d and str(d["i"]) in MAP["msgs"]:
                line = MAP["msgs"][str(d["i"])].encode("utf-8")
            elif "kinds" in d and "l" in d and "i" in d and ("%d:%d" % (d["l"], d["i"])) in MAP["nodes"]:
                line = MAP["nodes"][("%d:%d" % (d["l"], d["i"]))].encode("utf-8")
    out.append(line)
blob.data = b"\\n".join(out)
`;

function head(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const reEscape = (s: string) => s.replace(/[\\.^$*+?{}[\]|()]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

/**
 * Hand `data` to a process that reads the FIFO. The writer opens non-blocking and retries until a reader
 * is there (ENXIO), so it never parks a thread on an open() that no reader will answer; it gives up
 * as soon as the reading process has exited.
 */
export async function feedFifo(fifo: string, data: string, exited: () => boolean): Promise<void> {
  for (;;) {
    if (exited()) return;
    let fd: number;
    try {
      fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (e: any) {
      if (e.code === "ENXIO") {
        await sleep(20);
        continue;
      }
      throw e;
    }
    try {
      const buf = Buffer.from(data);
      let off = 0;
      while (off < buf.length) {
        try {
          off += fs.writeSync(fd, buf, off);
        } catch (e: any) {
          if (e.code !== "EAGAIN") throw e;
          await sleep(10);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
}

/**
 * Rewrite one repo's history. The chat repo uses ONLY the id-based callback: a raw --replace-text there would
 * also hit JSON keys and numbers ("user", "2026") and corrupt the log. The files repo uses the literal, over a FIFO:
 * kernel memory only, never argv, env or a file on disk.
 */
async function rewriteHistory(svc: Service, dir: string, p: Plan | undefined, F: string[]): Promise<void> {
  const args = ["filter-repo", "--force", "--replace-refs", "delete-no-add"];
  const env: Record<string, string> = { HOME: os.homedir(), PATH: process.env.PATH ?? "" };
  let mapFile: string | undefined;
  let fifo: string | undefined;
  try {
    if (p) {
      // line-for-line replacement by id: the map holds the new lines, never the secret
      mapFile = path.join(svc.paths.run, `redact-map-${process.pid}-${Date.now()}.json`);
      const msgs: Record<string, string> = {};
      for (const m of p.msgs) msgs[m.i] = JSON.stringify(m);
      const nodes: Record<string, string> = {};
      for (const n of p.nodes) nodes[key(n.l, n.i)] = JSON.stringify(n);
      fs.writeFileSync(mapFile, JSON.stringify({ msgs, nodes }), { mode: 0o600 });
      env.OPTCHAT_REDACT_MAP = mapFile;
      args.push("--blob-callback", BLOB_CALLBACK);
    }
    let expressions = "";
    if (F.length) {
      fifo = path.join(svc.paths.run, `redact-${process.pid}.fifo`);
      fs.rmSync(fifo, { force: true });
      execFileSync("mkfifo", ["-m", "600", fifo]);
      args.push("--replace-text", fifo);
      expressions = F.filter((f) => !f.includes("==>")).map((f) => `regex:${reEscape(f)}==>${MARK}`).join("\n") + "\n";
    }
    await new Promise<void>((resolve, reject) => {
      const c = spawn("git", args, { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      let gone = false;
      c.stderr.on("data", (d) => (err += d));
      c.on("error", (e) => ((gone = true), reject(e)));
      c.on("close", (code) => {
        gone = true;
        code === 0 ? resolve() : reject(new Error(`git filter-repo failed: ${err.slice(-1500)}`));
      });
      if (fifo) feedFifo(fifo, expressions, () => gone).catch((e) => !gone && (c.kill("SIGKILL"), reject(e)));
    });
    await execP("git", ["reflog", "expire", "--expire=now", "--all"], { cwd: dir });
    await execP("git", ["gc", "--prune=now", "-q"], { cwd: dir });
  } finally {
    if (mapFile) fs.rmSync(mapFile, { force: true });
    if (fifo) fs.rmSync(fifo, { force: true });
    fs.rmSync(path.join(dir, ".git", "filter-repo"), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- verification

function scanFiles(dir: string, needles: Buffer[], hits: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === "ENOTDIR") {
      // a single file was given
      try {
        if (needles.some((n) => fs.readFileSync(dir).includes(n))) hits.push(dir);
      } catch {
        hits.push(`${dir} (could not be read)`);
      }
    } else if (e.code !== "ENOENT") hits.push(`${dir} (could not be listed: ${e.code})`); // not looked at = not clean
    return;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scanFiles(p, needles, hits);
    else if (e.isFile()) {
      try {
        const buf = fs.readFileSync(p);
        if (needles.some((n) => buf.includes(n))) hits.push(p);
      } catch {
        hits.push(`${p} (could not be read)`);
      }
    }
  }
}

async function scanGitObjects(dir: string, needles: Buffer[]): Promise<string | null> {
  if (!hasGit(dir)) return null;
  return new Promise((resolve) => {
    const c = spawn("git", ["cat-file", "--batch-all-objects", "--batch"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const keep = Math.max(...needles.map((n) => n.length));
    let tail = Buffer.alloc(0);
    let found = false;
    c.stdout.on("data", (d: Buffer) => {
      const buf = Buffer.concat([tail, d]);
      if (needles.some((n) => buf.includes(n))) found = true;
      tail = buf.subarray(Math.max(0, buf.length - keep));
    });
    c.on("error", () => resolve(`git objects in ${dir} (could not be scanned)`));
    c.on("close", (code) => resolve(code !== 0 ? `git objects in ${dir} (could not be scanned)` : found ? `git objects in ${dir}` : null));
  });
}

/** Look for the secret everywhere it could still be. A place that cannot be checked counts as NOT clean. */
export async function verifyGone(svc: Service, F: string[]): Promise<string[]> {
  const needles = diskForms(F).map((f) => Buffer.from(f, "utf8"));
  const left: string[] = [];
  scanFiles(svc.paths.root, needles, left);
  const claude = path.join(os.homedir(), ".claude");
  scanFiles(path.join(claude, "projects"), needles, left);
  scanFiles(path.join(claude, "history.jsonl"), needles, left);
  for (const d of [svc.paths.chat, svc.paths.files]) {
    const r = await scanGitObjects(d, needles);
    if (r) left.push(r);
  }
  if (haveRestic(svc.paths)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optchat-verify-"));
    try {
      await resticRestore(svc.paths, tmp);
      const r: string[] = [];
      scanFiles(tmp, needles, r);
      left.push(...r.map((x) => `restic snapshot: ${x.replace(tmp, "")}`));
    } catch (e: any) {
      left.push(`restic snapshot (could not be checked: ${String(e.message).slice(0, 100)})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return left;
}

// ---------------------------------------------------------------- the command

/** Snapshots from the oldest changed message on may hold the secret (literal mode cleans older messages too). */
export function earliestDate(svc: Service, p: { msgs: Msg[] }, id: number, extra?: string): string {
  const dates = [svc.mem.store.msgs[id].date, ...p.msgs.map((m) => m.date), ...(extra ? [extra] : [])];
  return dates.reduce((a, b) => (new Date(b) < new Date(a) ? b : a));
}

/** Other open redactions keep plans that hold this text too: clean those plans of THIS secret. */
function scrubOpenPlans(svc: Service, F: string[], exceptTs: string): void {
  for (const [ts, es] of byTs(svc)) {
    if (ts === exceptTs || es.some((e) => e.step === "done")) continue;
    const file = es.find((e) => e.step === "started")?.plan;
    const p = loadPlan(file);
    if (!file || !p) continue;
    const clean = (s: string) => scrub(s, F);
    p.msgs = p.msgs.map((m) => ({ ...m, text: clean(m.text) }));
    p.nodes = p.nodes.map((n) => ({ ...n, text: clean(n.text) }));
    writeAtomic(file, JSON.stringify(p));
  }
}

export async function redact(svc: Service, req: RedactReq): Promise<string> {
  validate(svc, req); // BEFORE anything is stopped, locked or changed
  const F = req.literal ? forms(req.literal) : [];
  return svc.exclusive(async () => {
    const report: string[] = ["Rotate or revoke the secret now: it already reached Anthropic, and Telegram if the bridge echoed it."];
    const open: string[] = [];
    const git = hasGit(svc.paths.chat) && hasGit(svc.paths.files);

    // Commit first: filter-repo ends with a hard reset, which reverts anything uncommitted.
    if (git && !((await svc.commit(svc.paths.chat, "before redaction")) && (await svc.commit(svc.paths.files, "before redaction"))))
      throw new Error("git could not commit the current state (see `git status` in chat/ and files/); nothing was changed");

    const oldHeads = { chat: head(svc.paths.chat), files: head(svc.paths.files) };
    const p = plan(svc, req, F);
    const ts = new Date().toISOString();
    const planFile = path.join(svc.paths.run, `redact-${ts.replace(/[:.]/g, "")}.json`);
    writeAtomic(planFile, JSON.stringify(p)); // new texts only: no secret in it
    const base = { ts, id: req.id, mode: (req.whole ? "whole" : "literal") as "whole" | "literal" };
    journal(svc, { ...base, step: "started", plan: planFile, dirty: p.dirty, since: earliestDate(svc, p, req.id) });

    const touched = [...applyPlan(svc, p)];
    const side = scrubSideFiles(svc, req, F, p.msgs);
    touched.push(...side.touched);
    const since = earliestDate(svc, p, req.id, side.since);
    journal(svc, { ...base, step: "applied", files: touched, since });
    svc.clearRing(); // the display ring replays raw entries to clients that attach later
    if (F.length) scrubOpenPlans(svc, F, ts);
    report.push(`rewrote ${p.msgs.length} message(s) and ${p.nodes.length} node(s) in ${touched.length} file(s); ${p.dirty.length} node(s) will be rebuilt`);
    for (const f of side.unfixable) open.push(`remove this saved file by hand (it holds the secret and cannot be edited): ${f}`);

    // git history
    let historyDone = false;
    if (git && haveFilterRepo()) {
      if (await svc.commit(svc.paths.chat, "redaction applied")) {
        await rewriteHistory(svc, svc.paths.chat, p, []);
        if (F.length && (await svc.commit(svc.paths.files, "redaction applied"))) await rewriteHistory(svc, svc.paths.files, undefined, F);
        else if (F.length) open.push("git could not commit the files folder: its history was not rewritten");
        historyDone = !F.length || !open.some((o) => o.startsWith("git could not commit the files"));
        if (historyDone) report.push("rewrote local git history (reflog expired, objects pruned)");
      } else open.push("git could not commit the redacted state, so the history was NOT rewritten (filter-repo would have reverted the redaction)");
    } else if (git) open.push(`git history still holds the secret: install git-filter-repo, then restart the service (it finishes open redactions)`);
    else historyDone = true; // no git repo at all: there is no history to rewrite
    if (historyDone) journal(svc, { ...base, step: "history" });
    await svc.commit(svc.paths.chat, "after redaction");

    // off-host backup
    if (haveRestic(svc.paths)) {
      try {
        report.push(...(await resticPurge(svc.paths, since)));
        await resticBackup(svc.paths);
        journal(svc, { ...base, step: "backup" });
        report.push("restic: fresh snapshot taken");
      } catch (e: any) {
        open.push(`restic cleanup failed: ${String(e.message).slice(0, 200)}. It is retried when the service restarts.`);
      }
    } else {
      journal(svc, { ...base, step: "backup", skipped: true });
      open.push("no restic backup is configured: clean any other backup copy by hand");
    }

    // verification
    let verified = !F.length; // a whole-message redaction has no secret to look for
    if (F.length) {
      const left = await verifyGone(svc, F);
      if (left.length) open.push(`the secret is STILL present, or could not be checked, in: ${left.slice(0, 10).join(", ")}`);
      else {
        verified = true;
        report.push("verified: the secret is not found in ~/optchat, ~/.claude/projects, git objects or the newest restic snapshot");
      }
    }
    journal(svc, { ...base, step: "verified", ok: verified, skipped: !F.length });
    open.push("delete Time Machine / filesystem local snapshots that may hold the old files (an admin step; see PLAN.md, D3)");
    open.push("if the Telegram bridge echoed the secret, delete those bot messages (deleteMessage, about 48 h window)");
    journal(svc, { ...base, step: "report", oldHeads, newHeads: { chat: head(svc.paths.chat), files: head(svc.paths.files) }, open });
    closeFinished(svc);
    report.push(...open.map((o) => `TODO: ${o}`));
    return report.join("\n");
  });
}

// ---------------------------------------------------------------- resume

function stepsOf(es: JournalEntry[]) {
  const has = (s: Step, f?: (e: JournalEntry) => boolean) => es.some((e) => e.step === s && (!f || f(e)));
  return {
    applied: has("applied"),
    history: has("history") || has("manual"),
    backup: has("backup", (e) => !e.skipped),
    backupSkipped: has("backup", (e) => !!e.skipped),
    verified: has("verified", (e) => e.ok !== false),
    done: has("done"),
  };
}

/**
 * At startup: finish a redaction that a crash (or a missing tool) left open, from its secret-free plan file.
 * It can redo the file rewrite, the id-based history rewrite of the chat, and the restic purge. It cannot redo
 * the literal rewrite of the files repo, or verify: those are reported, never claimed.
 */
export async function resumeRedactions(svc: Service): Promise<string[]> {
  const openOnes = [...byTs(svc)].filter(([, es]) => es.some((e) => e.step === "started") && !stepsOf(es).done);
  if (!openOnes.length) return [];
  return svc.exclusive(async () => {
    const notes: string[] = [];
    for (const [ts, es] of openOnes) {
      const started = es.find((e) => e.step === "started")!;
      const s = stepsOf(es);
      const base = { ts, id: started.id, mode: started.mode };
      const p = loadPlan(started.plan);
      const since = [...es].reverse().find((e) => e.since)?.since ?? started.since;
      if (!s.applied && p) {
        applyPlan(svc, p); // only lines that are still as the plan saw them
        journal(svc, { ...base, step: "applied" });
        notes.push(`redaction ${ts}: file rewrite re-applied`);
      } else if (!s.applied) notes.push(`redaction ${ts}: TODO its plan file is gone; run \`optchat redact ${started.id}\` again`);
      if (p) for (const n of p.nodes) { // rebuild only what is still the interim text
        const k = key(n.l, n.i);
        if (p.dirty.includes(k) && svc.mem.store.node(n.l, n.i)?.text === n.text) svc.mem.compactor.dirty.add(k);
      }
      if (!s.history) {
        if (p && hasGit(svc.paths.chat) && haveFilterRepo() && (await svc.commit(svc.paths.chat, "redaction applied"))) {
          await rewriteHistory(svc, svc.paths.chat, p, []);
          if (started.mode === "literal") {
            journal(svc, { ...base, step: "manual" });
            notes.push(`redaction ${ts}: chat git history rewritten. TODO the files repo history needs the secret: run \`optchat redact ${started.id} --literal\` again`);
          } else {
            journal(svc, { ...base, step: "history" });
            notes.push(`redaction ${ts}: chat git history rewritten`);
          }
        } else notes.push(`redaction ${ts}: TODO git history still holds the secret (git-filter-repo missing, git unusable, or no plan file)`);
      }
      if (!s.backup && haveRestic(svc.paths) && since) {
        try {
          await resticPurge(svc.paths, since);
          await resticBackup(svc.paths);
          journal(svc, { ...base, step: "backup" });
          notes.push(`redaction ${ts}: restic purged`);
        } catch (e: any) {
          notes.push(`redaction ${ts}: TODO restic purge failed: ${String(e.message).slice(0, 200)}`);
        }
      }
      if (!s.verified) {
        journal(svc, { ...base, step: "verified", ok: true, skipped: true });
        notes.push(`redaction ${ts}: TODO the secret could not be looked for again (it is not stored); run \`optchat redact ${started.id} --literal\` to verify`);
      }
    }
    closeFinished(svc);
    return notes;
  });
}

/** `done` only when the history is rewritten (or flagged for hand work), the backup is clean, the check ran, and every node is rebuilt. */
function closeFinished(svc: Service): void {
  if (svc.mem.compactor.dirty.size) return;
  for (const [ts, es] of byTs(svc)) {
    const s = stepsOf(es);
    if (s.done || !es.some((e) => e.step === "started") || !s.applied) continue;
    if (!s.history || !s.verified) continue;
    if (!s.backup && haveRestic(svc.paths)) continue;
    const started = es.find((e) => e.step === "started")!;
    journal(svc, { ts, id: started.id, mode: started.mode, step: "done" });
    if (started.plan) fs.rmSync(started.plan, { force: true });
    void svc.commit(svc.paths.chat, "redaction done"); // the closing entry and the rebuilt nodes, now
  }
}

/** When the rebuild of a redaction's nodes has finished, close its journal entries. */
export function watchRedactions(svc: Service): void {
  const prev = svc.mem.compactor.onBuilt;
  svc.mem.compactor.onBuilt = () => {
    prev?.();
    closeFinished(svc);
  };
}

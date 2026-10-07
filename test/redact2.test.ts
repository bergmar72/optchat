import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { diskForms, feedFifo, forms, redact, resumeRedactions, verifyGone, watchRedactions } from "../src/redact.ts";
import { haveFilterRepo, msgs, newService, tmp } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const journal = (svc: any) => fs.readFileSync(svc.paths.redactions, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rnd = () => crypto.randomBytes(9).toString("hex");

function grep(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

test("validation happens BEFORE anything is stopped: a typo id does not kill the running turn", async () => {
  const svc = newService();
  svc.submit({ kind: "user", text: "SCRIPT:slow go" });
  await sleep(150);
  const gen = (svc.mem.compactor as any).gen;
  await assert.rejects(redact(svc, { id: 99999, whole: true }), /no message 99999/);
  assert.equal((svc.mem.compactor as any).gen, gen);
  await svc.idle();
  assert.ok(msgs(svc).includes("talk: slow done"), "the turn finished normally");
  svc.mem.add("user", "x");
  await assert.rejects(redact(svc, { id: 0, literal: "abc" }), /too short/);
  await assert.rejects(redact(svc, { id: 0, literal: "abcdef", whole: true }), /not both/);
  await assert.rejects(redact(svc, { id: 0 }), /give --literal or --whole/);
});

test("secrets that JSON escapes (quotes, backslash, newline) are found everywhere, and the verifier can see them", async () => {
  const secret = `pa"ss\\w${rnd()}\nline2-${rnd()}`;
  const svc = newService();
  watchRedactions(svc);
  svc.mem.add("talk", "context " + "c".repeat(300));
  const bad = svc.mem.add("user", `password is ${secret} ok https://example.org/a end ` + "u".repeat(600));
  // the agent used it in a tool call: the step embeds JSON.stringify(input), so it is escaped TWICE on disk
  svc.mem.add("step", `Bash ${JSON.stringify({ command: `echo '${secret}'` })}\n→ done ` + "s".repeat(600));
  fs.writeFileSync(svc.paths.links, JSON.stringify({ date: "d", id: bad.i, url: "https://example.org/a", context: `password is ${secret} ok` }) + "\n");
  fs.writeFileSync(path.join(svc.paths.files, "notes.md"), `remember: ${secret}\n`);
  fs.writeFileSync(path.join(svc.paths.files, "scan.pdf"), Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.from(secret)]));
  await svc.mem.compactor.whenIdle();
  const F = forms(secret);
  assert.ok((await verifyGone(svc, F)).length > 0, "test setup: the verifier must SEE the escaped copies");

  const report = await redact(svc, { id: bad.i, literal: secret });
  await svc.mem.compactor.whenIdle();
  const left = await verifyGone(svc, F);
  const allowed = (x: string) => x.startsWith("git objects") || x.endsWith("scan.pdf");
  assert.deepEqual(left.filter((x) => !allowed(x)), [], `still present: ${left}`);
  assert.match(report, /remove this saved file by hand.*scan\.pdf/); // a PDF cannot be edited: it is reported, not claimed
  assert.ok(!svc.mem.store.msgs.some((m) => m.text.includes(secret.slice(0, 12)) && m.text.includes("line2")));
  assert.equal(grep(svc.paths.root, JSON.stringify(secret).slice(1, -1)).filter((f) => !f.endsWith("scan.pdf")).length, 0);
  assert.match(fs.readFileSync(svc.paths.links, "utf8"), /example\.org\/a/); // the link row was made again from the cleaned text
  assert.doesNotMatch(fs.readFileSync(path.join(svc.paths.files, "notes.md"), "utf8"), /pa"ss/);
});

test("other encodings: base64 at every alignment, percent-encoding in either case", () => {
  const s = "Sup3r-S3cret-Value!";
  const F = forms(s);
  const hay = (x: string) => F.some((f) => x.includes(f));
  assert.ok(hay(`Basic ${Buffer.from("user:" + s).toString("base64")}`), "after a 5-byte prefix");
  assert.ok(hay(`x${Buffer.from("a" + s).toString("base64")}y`), "after 1 byte");
  assert.ok(hay(`x${Buffer.from("ab" + s).toString("base64")}y`), "after 2 bytes");
  assert.ok(hay(Buffer.from(s).toString("base64")));
  assert.ok(hay(encodeURIComponent("é" + s + "é").toLowerCase()) || hay(encodeURIComponent(s)));
  const accented = "gëheim-" + rnd();
  assert.ok(forms(accented).some((f) => encodeURIComponent(accented).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()) === f));
  assert.ok(diskForms(["a\"b\\c\nd____"]).some((f) => f.includes('\\"') && f.includes("\\\\n")));
});

test("the display ring is emptied: a client attaching later never sees the secret", async () => {
  const secret = "ring-" + rnd();
  const svc = newService();
  svc.logItem({ kind: "user", text: `my key is ${secret} ` + "r".repeat(400) });
  assert.ok(JSON.stringify((svc as any).ring).includes(secret));
  await redact(svc, { id: 0, literal: secret });
  assert.equal((svc as any).ring.length, 0);
});

test("another open redaction's plan file is cleaned of this secret", async () => {
  const secretB = "planB-" + rnd();
  const svc = newService();
  svc.mem.add("user", `first ${secretB} ` + "a".repeat(400));
  svc.mem.add("user", `second ` + "b".repeat(400));
  const planA = path.join(svc.paths.run, "redact-A.json");
  fs.writeFileSync(planA, JSON.stringify({ msgs: [{ ...svc.mem.store.msgs[0] }], nodes: [], dirty: [] })); // A's plan holds the line, with B in it
  fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "A", id: 1, mode: "whole", step: "started", plan: planA, dirty: [] }) + "\n");
  assert.ok(fs.readFileSync(planA, "utf8").includes(secretB));
  await redact(svc, { id: 0, literal: secretB });
  assert.ok(!fs.readFileSync(planA, "utf8").includes(secretB), "A's plan still carries B");
});

test("a stale plan is not applied over a line that has changed since (it would bring a removed secret back)", async () => {
  const svc = newService();
  for (let i = 0; i < 3; i++) svc.mem.add("user", `m${i} ` + "z".repeat(500));
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const old = svc.mem.store.msgs[1];
  const stalePlan = { msgs: [{ ...old, text: "A's version of message 1, with another secret in it" }], nodes: [], dirty: [], pre: { "m:1": sha(JSON.stringify(old)) } };
  const planFile = path.join(svc.paths.run, "redact-stale.json");
  fs.writeFileSync(planFile, JSON.stringify(stalePlan));
  fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "S", id: 1, mode: "whole", step: "started", plan: planFile, dirty: [] }) + "\n");
  // B ran meanwhile and changed message 1
  svc.mem.store.rewrite(new Map([[1, { ...old, text: "B cleaned this", size: 20 }]]), new Map());
  await resumeRedactions(svc);
  assert.equal(svc.mem.store.msgs[1].text, "B cleaned this");
});

test("'done' is written only when history, backup, verification and the rebuild are all finished", async () => {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "restic"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const svc = newService();
  fs.writeFileSync(path.join(svc.paths.secrets, "restic.env"), "RESTIC_REPOSITORY=/nowhere\n");
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    watchRedactions(svc);
    const w = (step: string, extra: object = {}) => fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "T", id: 0, mode: "whole", step, ...extra }) + "\n");
    const closed = () => journal(svc).some((e: any) => e.step === "done");
    const poke = () => svc.mem.compactor.onBuilt?.();
    w("started"); w("applied"); w("history"); w("verified", { ok: true });
    poke();
    assert.equal(closed(), false, "restic is configured and the backup step is missing");
    w("backup", { skipped: true });
    poke();
    assert.equal(closed(), false, "a skipped backup does not count while restic is configured");
    w("backup");
    poke();
    assert.equal(closed(), true);
    // a failed check keeps it open
    const other = (step: string, extra: object = {}) => fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "U", id: 0, mode: "whole", step, ...extra }) + "\n");
    other("started"); other("applied"); other("history"); other("backup"); other("verified", { ok: false });
    poke();
    assert.equal(journal(svc).filter((e: any) => e.ts === "U" && e.step === "done").length, 0);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("a torn line in the redaction journal does not make it unreadable", async () => {
  const svc = newService();
  svc.mem.add("user", "m0 " + "q".repeat(400));
  svc.mem.add("user", "m1 " + "q".repeat(400));
  const m = { ...svc.mem.store.msgs[1], text: "(redacted)", size: 20 };
  const planFile = path.join(svc.paths.run, "redact-torn.json");
  fs.writeFileSync(planFile, JSON.stringify({ msgs: [m], nodes: [], dirty: [] }));
  fs.writeFileSync(svc.paths.redactions, JSON.stringify({ ts: "X", id: 1, mode: "whole", step: "started", plan: planFile, dirty: [] }) + '\n{"ts":"X","id":1,"mo');
  const notes = await resumeRedactions(svc);
  assert.match(notes.join("\n"), /re-applied/);
  assert.equal(svc.mem.store.msgs[1].text, "(redacted)");
  // and the next entry starts on its own line
  const lines = fs.readFileSync(svc.paths.redactions, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } }).length >= 2);
});

test("a plan file that is empty or torn does not abort the resume of the others", async () => {
  const svc = newService();
  svc.mem.add("user", "m0 " + "q".repeat(400));
  fs.writeFileSync(path.join(svc.paths.run, "redact-empty.json"), "");
  fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "E", id: 0, mode: "whole", step: "started", plan: path.join(svc.paths.run, "redact-empty.json"), dirty: [] }) + "\n");
  const notes = await resumeRedactions(svc);
  assert.match(notes.join("\n"), /plan file is gone/);
});

test("redaction aborts, changing nothing, if a turn will not stop... and if git cannot commit", async () => {
  const svc = newService();
  svc.mem.add("user", "secret-ish " + "w".repeat(400));
  // a stuck global git config makes `git commit` fail: the pre-redaction commit must be a hard stop
  const real = fs.readFileSync(path.join(svc.paths.chat, ".git", "config"), "utf8");
  fs.writeFileSync(path.join(svc.paths.chat, ".git", "config"), real + "\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent\n");
  fs.mkdirSync(path.join(svc.paths.chat, "extra"), { recursive: true });
  fs.writeFileSync(path.join(svc.paths.chat, "extra", "dirty.txt"), "uncommitted");
  // our own -c commit.gpgsign=false wins over the repo config, so the commit still works:
  await redact(svc, { id: 0, whole: true });
  assert.equal(svc.mem.store.msgs[0].text, "(redacted)");
  // but a read-only index really does stop it, before anything is changed
  const svc2 = newService();
  svc2.mem.add("user", "other " + "w".repeat(400));
  fs.mkdirSync(path.join(svc2.paths.chat, ".git", "index.lock"));
  await assert.rejects(redact(svc2, { id: 0, whole: true }), /could not commit/);
  assert.match(svc2.mem.store.msgs[0].text, /^other /);
  assert.equal(svc2.locked, false);
});

test("feedFifo hands the data over once a reader appears, and gives up when the reader is gone (no stuck thread)", async () => {
  const dir = tmp();
  const fifo = path.join(dir, "f");
  execFileSync("mkfifo", [fifo]);
  const reader = spawn("sh", ["-c", `sleep 0.3; cat ${fifo}`], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  reader.stdout.on("data", (d) => (out += d));
  await feedFifo(fifo, "hello fifo\n", () => false);
  await new Promise((r) => reader.on("close", r));
  assert.equal(out, "hello fifo\n");
  // nobody ever reads: it must return as soon as told the reader exited
  const t0 = Date.now();
  let gone = false;
  setTimeout(() => (gone = true), 150);
  await feedFifo(fifo, "x", () => gone);
  assert.ok(Date.now() - t0 < 1000);
  // and the event loop is not blocked: a threadpool call still works
  await fs.promises.readFile(__filename_of_test());
});
function __filename_of_test() {
  return new URL(import.meta.url).pathname;
}

test("with git-filter-repo: a secret that is also a JSON key or value does not corrupt the chat", { skip: !haveFilterRepo() && "needs git-filter-repo" }, async () => {
  const svc = newService();
  for (let i = 0; i < 4; i++) svc.mem.add("user", `message ${i} with the word user in it ` + "u".repeat(300));
  await svc.mem.compactor.whenIdle();
  await redact(svc, { id: 1, literal: "user" });
  await svc.mem.compactor.whenIdle();
  const again = newService({}, svc.paths.root);
  assert.equal(again.mem.store.total, 4); // 4 characters, equal to every kind: the raw bytes were NOT rewritten
  assert.ok(again.mem.store.msgs.every((m) => m.kind === "user"));
  assert.ok(again.mem.store.msgs[1].text.includes("[REDACTED]"));
});

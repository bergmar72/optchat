// One test per finding of the second code review.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { parseSnapshots } from "../src/backup.ts";
import { connect } from "../src/client.ts";
import { fetchCapped, ingest, pickExt, slug } from "../src/ingest.ts";
import { writeFilesIfRoot } from "../src/platform.ts";
import { decide, defaultPolicy, otherHomesOf } from "../src/policy.ts";
import { redact, resumeRedactions, watchRedactions } from "../src/redact.ts";
import { haveFilterRepo, newService, tmp } from "./helpers.ts";

const journal = (svc: any) => fs.readFileSync(svc.paths.redactions, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("1. the history rewrite cannot revert the redaction journal", { skip: !haveFilterRepo() && "needs git-filter-repo" }, async () => {
  const svc = newService();
  watchRedactions(svc);
  for (let i = 0; i < 4; i++) svc.mem.add("talk", `m${i} ` + "x".repeat(700));
  await svc.mem.compactor.whenIdle();
  await redact(svc, { id: 1, whole: true });
  await svc.mem.compactor.whenIdle();
  await svc.gitIdle();
  const steps = journal(svc).map((e) => e.step);
  for (const s of ["started", "applied", "history", "backup", "report", "done"]) assert.ok(steps.includes(s), `missing ${s} in ${steps}`);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: svc.paths.chat }).toString().trim(), ""); // HEAD matches the files
});

test("2. resume after a crash: 'done' only once the git history is rewritten", async () => {
  const svc = newService();
  for (let i = 0; i < 4; i++) svc.mem.add("talk", `m${i} ` + "z".repeat(700));
  await svc.mem.compactor.whenIdle();
  const m = { ...svc.mem.store.msgs[2], text: "(redacted)", size: 20 };
  const planFile = path.join(svc.paths.run, "redact-crash.json");
  fs.writeFileSync(planFile, JSON.stringify({ msgs: [m], nodes: [], dirty: [] }));
  fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "t9", id: 2, mode: "whole", step: "started", plan: planFile, dirty: [], since: m.date }) + "\n");
  fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "t9", id: 2, mode: "whole", step: "applied" }) + "\n");
  const again = newService({}, svc.paths.root);
  const notes = await resumeRedactions(again);
  const steps = journal(again).filter((e) => e.ts === "t9").map((e) => e.step);
  if (haveFilterRepo()) {
    assert.ok(steps.includes("history") && steps.includes("done"));
    assert.equal(fs.existsSync(planFile), false); // 3. the plan file is removed once done
  } else {
    assert.ok(!steps.includes("done"), "must not claim done while git history still holds the secret");
    assert.ok(notes.some((n) => /TODO git history/.test(n)));
    assert.equal(fs.existsSync(planFile), true); // kept: needed to finish later
  }
});

test("4. restic 'null' snapshots output is an empty list", () => {
  assert.deepEqual(parseSnapshots("null\n"), []);
  assert.deepEqual(parseSnapshots(""), []);
  assert.deepEqual(parseSnapshots('[{"id":"a","time":"t"}]'), [{ id: "a", time: "t" }]);
});

const home = tmp();
fs.mkdirSync(path.join(home, "work"));
fs.mkdirSync(path.join(home, ".ssh"));
const cfg = defaultPolicy(home, "/opt/code", []);
const v = (tool: string, input: any) => decide(tool, input, cfg).verdict;

test("5. bash path arguments: protected paths deny, outside or relative paths are not auto-allowed", () => {
  assert.equal(v("Bash", { command: "ls ~/.ssh" }), "deny");
  assert.equal(v("Bash", { command: "cat ~/.ssh/id_ed25519" }), "deny");
  assert.equal(v("Bash", { command: `ls ${home}/optchat/secrets` }), "deny");
  assert.equal(v("Bash", { command: "ls ../secrets" }), "ask"); // relative: where it points is unknown
  assert.equal(v("Bash", { command: "ls /etc" }), "ask");
  assert.equal(v("Bash", { command: `ls ${home}/work` }), "allow");
  assert.equal(v("Bash", { command: "ls -la" }), "allow");
  assert.equal(v("Bash", { command: "git diff HEAD~1" }), "ask");
});

test("6. Glob patterns and Grep globs are checked as paths", () => {
  const work = path.join(home, "work");
  assert.equal(v("Glob", { pattern: `${home}/.ssh/*`, path: work }), "deny");
  assert.equal(v("Glob", { pattern: "~/.ssh/**", path: work }), "deny");
  assert.equal(v("Glob", { pattern: "../../**/*.pem", path: work }), "ask");
  assert.equal(v("Grep", { pattern: "key", path: work, glob: "../*" }), "ask");
  assert.equal(v("Glob", { pattern: "**/*.ts", path: work }), "allow");
  assert.equal(v("Glob", { pattern: `${work}/src/*.ts` }), "allow"); // absolute pattern inside work names its own path
});

test("7. a protected folder reached through a symlinked home is still protected", () => {
  const real = tmp();
  fs.mkdirSync(path.join(real, "work"));
  fs.mkdirSync(path.join(real, ".ssh"));
  const linkHome = path.join(tmp(), "homelink");
  fs.symlinkSync(real, linkHome);
  const c = defaultPolicy(linkHome, "/opt/code", []); // protect list written via the symlink
  assert.equal(decide("Read", { file_path: path.join(real, ".ssh", "id_rsa.bak") }, c).verdict, "deny");
  assert.equal(decide("Read", { file_path: path.join(real, "work", "a.ts") }, c).verdict, "allow");
});

test("8. other users' homes: none for /root or a home right under /", () => {
  assert.deepEqual(otherHomesOf("/root"), []);
  assert.deepEqual(otherHomesOf("/srv"), []);
});

test("9. a multi-byte character split across two socket chunks arrives intact", async () => {
  const sock = path.join(tmp(), "s");
  const line = Buffer.from(JSON.stringify({ ev: "entry", text: "Grüße 日本 🎉" }) + "\n");
  const cut = line.indexOf(Buffer.from("日")) + 1; // in the middle of a 3-byte character
  const srv = net.createServer((c) => {
    c.resume(); // read (and drop) the client's hello, so its close is seen
    c.write(line.subarray(0, cut));
    setTimeout(() => c.write(line.subarray(cut)), 30);
  });
  await new Promise<void>((r) => srv.listen(sock, r));
  const conn = await connect(sock, { role: "attach" });
  const got: any = await new Promise((r) => conn.on(r));
  assert.equal(got.text, "Grüße 日本 🎉");
  conn.close();
  srv.close();
});

test("10. one API message whose blocks arrive as several events is one usage row", () => {
  const svc = newService();
  const st = { pending: new Map(), order: [], done: new Map(), logged: new Set(), usageSeen: new Set(), step: 0, initOk: true };
  const usage = { input_tokens: 5, output_tokens: 1 };
  svc.handleEvent({ type: "assistant", uuid: "e1", message: { id: "msg_1", usage, content: [{ type: "text", text: "a" }] } }, st as any);
  svc.handleEvent({ type: "assistant", uuid: "e2", message: { id: "msg_1", usage, content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } }, st as any);
  const rows = fs.readFileSync(path.join(svc.paths.run, "usage.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(rows.length, 1);
});

test("11. ingest refuses a symlink into secrets/, but accepts a sibling like secrets-old/", async () => {
  const svc = newService();
  fs.writeFileSync(path.join(svc.paths.secrets, "api"), "sk-nothing");
  const link = path.join(tmp(), "innocent.txt");
  fs.symlinkSync(path.join(svc.paths.secrets, "api"), link);
  assert.match(await ingest(svc, link), /failed: refusing to save it/);
  const sib = path.join(svc.paths.root, "secrets-old");
  fs.mkdirSync(sib);
  fs.writeFileSync(path.join(sib, "notes.txt"), "plain notes");
  assert.match(await ingest(svc, path.join(sib, "notes.txt")), /^saved .*\/files\//);
  await svc.idle();
});

test("12. downloads have a size cap, and unknown binary data is not called .txt", async () => {
  const srv = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "application/octet-stream" });
    r.end(Buffer.alloc(5000, 1));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/blob`;
  await assert.rejects(fetchCapped(url, 1000, { allowPrivate: true }), /too large/);
  const ok = await fetchCapped(url, 10_000, { allowPrivate: true });
  assert.equal(ok.data.length, 5000);
  srv.close();
  const bin = Buffer.from([1, 2, 0, 3]);
  assert.equal(pickExt("application/octet-stream", bin, "/blob"), ".bin");
  assert.equal(pickExt("application/octet-stream", bin, "/data.parquet"), ".parquet");
  assert.equal(pickExt("text/plain", Buffer.from("hi"), "/x"), ".txt");
  assert.equal(pickExt("application/pdf", Buffer.from("%PDF-1"), "/x"), ".pdf");
});

test("13. slug keeps arXiv ids whole", () => {
  assert.equal(slug("2301.12345"), "2301.12345");
  assert.equal(slug("2301.12345v2.pdf"), "2301.12345v2");
  assert.notEqual(slug("2301.12345"), slug("2301.99999"));
  assert.equal(slug("My Paper (final).pdf"), "my-paper-final");
});

test("14. the installer refuses without root and writes all files or none", () => {
  const dir = tmp();
  const files = [
    { path: path.join(dir, "a.service"), text: "A" },
    { path: path.join(dir, "b.timer"), text: "B" },
  ];
  assert.throws(() => writeFilesIfRoot(files, false), /needs root/);
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.throws(() => writeFilesIfRoot([files[0], { path: path.join(dir, "missing-dir", "c"), text: "C" }], true));
  assert.equal(fs.readdirSync(dir).length, 0); // nothing half-installed, no temp files left
  assert.deepEqual(writeFilesIfRoot(files, true), files.map((f) => f.path));
  assert.equal(fs.readFileSync(files[1].path, "utf8"), "B");
});

// One test per finding of the code review.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { absSrc, browse } from "../src/commands.ts";
import { hookDecision } from "../src/hook.ts";
import { uniqueBase } from "../src/ingest.ts";
import { installPlan } from "../src/platform.ts";
import { decide, defaultPolicy, real } from "../src/policy.ts";
import { earliestDate, redact } from "../src/redact.ts";
import { Store } from "../src/store.ts";
import { msgs, newService, tmp } from "./helpers.ts";

test("1. redact --whole: no node keeps the 'being rebuilt' placeholder, at any level", async () => {
  const svc = newService();
  for (let i = 0; i < 16; i++) svc.mem.add(i === 3 ? "user" : "talk", `message ${i} ` + "w".repeat(700));
  await svc.mem.compactor.whenIdle();
  await redact(svc, { id: 3, whole: true });
  await svc.mem.compactor.whenIdle();
  const stuck = [...svc.mem.store.nodes.values()].filter((n) => n.text.includes("being rebuilt"));
  assert.deepEqual(stuck, []);
  assert.equal(svc.mem.compactor.dirty.size, 0);
});

test("2. restic purge starts at the OLDEST message a literal redaction changed", () => {
  const svc = newService();
  svc.mem.add("user", "old secret");
  svc.mem.add("talk", "x");
  svc.mem.add("user", "the redacted one");
  const store = svc.mem.store;
  store.msgs[0] = { ...store.msgs[0], date: "2026-01-01T00:00:00.000Z" };
  store.msgs[2] = { ...store.msgs[2], date: "2026-03-01T00:00:00.000Z" };
  assert.equal(earliestDate(svc, { msgs: [store.msgs[0], store.msgs[2]] }, 2), "2026-01-01T00:00:00.000Z");
  assert.equal(earliestDate(svc, { msgs: [] }, 2), "2026-03-01T00:00:00.000Z");
});

test("3. a local date that goes backwards does not lose messages", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "a", new Date(2026, 9, 5, 12));
  s.appendMsg("user", "b", new Date(2026, 9, 4, 12)); // clock / timezone went back a day
  s.appendMsg("user", "c", new Date(2026, 9, 5, 13));
  const again = Store.open(dir);
  assert.deepEqual(again.msgs.map((m) => m.text), ["a", "b", "c"]);
  assert.deepEqual(again.warnings, []);
  assert.equal(fs.readdirSync(again.mainDir).length, 1);
});

test("4. a redaction keeps queued messages and runs them afterwards", async () => {
  const svc = newService();
  svc.mem.add("talk", "hello " + "h".repeat(600));
  (svc as any).queue.push({ kind: "user", text: "queued while redacting" });
  await redact(svc, { id: 0, whole: true });
  await svc.idle();
  assert.ok(msgs(svc).includes("user: queued while redacting"));
  assert.ok(msgs(svc).includes("talk: ok")); // the fake claude answered it
});

test("5. the hook fails closed: no service, bad input, bad answer -> deny", async () => {
  const dead = path.join(tmp(), "nosock");
  const d1 = JSON.parse(await hookDecision(dead, JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })));
  assert.equal(d1.hookSpecificOutput.permissionDecision, "deny");
  assert.match(d1.hookSpecificOutput.permissionDecisionReason, /denied/);
  const d2 = JSON.parse(await hookDecision(dead, "not json"));
  assert.equal(d2.hookSpecificOutput.permissionDecision, "deny");
  // a service that answers garbage
  const sock = path.join(tmp(), "s");
  const srv = net.createServer((c) => c.on("data", (d) => String(d).includes('"call"') && c.write(JSON.stringify({ t: "result", id: 1, text: "{}" }) + "\n")));
  await new Promise<void>((r) => srv.listen(sock, r));
  const d3 = JSON.parse(await hookDecision(sock, JSON.stringify({ tool_name: "Bash", tool_input: {} })));
  assert.equal(d3.hookSpecificOutput.permissionDecision, "deny");
  // a service that hangs up
  srv.close();
  const sock2 = path.join(tmp(), "s2");
  const srv2 = net.createServer((c) => c.on("data", () => c.destroy()));
  await new Promise<void>((r) => srv2.listen(sock2, r));
  const d4 = JSON.parse(await hookDecision(sock2, JSON.stringify({ tool_name: "Bash", tool_input: {} })));
  assert.equal(d4.hookSpecificOutput.permissionDecision, "deny");
  srv2.close();
});

test("5b. the hook passes a real verdict through", async () => {
  const sock = path.join(tmp(), "s");
  const srv = net.createServer((c) => c.on("data", (d) => String(d).includes('"call"') && c.write(JSON.stringify({ t: "result", id: 1, text: JSON.stringify({ verdict: "ask", why: "run: x" }) }) + "\n")));
  await new Promise<void>((r) => srv.listen(sock, r));
  const d = JSON.parse(await hookDecision(sock, JSON.stringify({ tool_name: "Bash", tool_input: { command: "x" } })));
  assert.equal(d.hookSpecificOutput.permissionDecision, "ask");
  srv.close();
});

test("6. the policy protects the REAL root, not ~/optchat", () => {
  const home = tmp();
  const root = path.join(home, "elsewhere", "chatdata");
  const cfg = defaultPolicy(home, "/opt/code", [], root);
  assert.equal(decide("Read", { file_path: path.join(root, "chat", "main", "x.jsonl") }, cfg).verdict, "deny");
  assert.equal(decide("Read", { file_path: path.join(root, "secrets", "api") }, cfg).verdict, "deny");
  assert.equal(decide("Edit", { file_path: path.join(root, "policy.json") }, cfg).verdict, "deny"); // the agent cannot loosen its own policy
  assert.equal(decide("Read", { file_path: path.join(root, "files", "p.txt") }, cfg).verdict, "allow"); // saved papers: read-only, at the real root
  assert.equal(decide("Write", { file_path: path.join(root, "files", "p.txt") }, cfg).verdict, "ask");
});

test("7. git commands that write or run programs are not auto-allowed", () => {
  const cfg = { ...defaultPolicy("/home/u", "/opt/code", []), bashAllow: ["git status", "git diff", "git log", "ls", "pwd"] };
  const v = (c: string) => decide("Bash", { command: c }, cfg).verdict;
  assert.equal(v("git status"), "allow");
  assert.equal(v("git diff --stat"), "allow");
  assert.equal(v("git log --oneline -5"), "allow");
  assert.equal(v("git diff HEAD~1"), "ask"); // "~" is shell syntax
  assert.equal(v("git diff HEAD src/a.ts"), "ask"); // a relative path: the shell's cwd is unknown
  assert.equal(v("git diff --output=/home/u/.bashrc"), "ask");
  assert.equal(v("git diff --ext-diff"), "ask");
  assert.equal(v("git diff --textconv"), "ask");
  assert.equal(v("git log --output=x"), "ask");
  assert.equal(v("git branch -D main"), "ask"); // no longer on the list at all
  assert.equal(v("git diff -O/tmp/orders"), "ask");
});

test("8. a symlinked folder is resolved even when several levels below it do not exist", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "work"));
  fs.mkdirSync(path.join(home, "outside"));
  fs.symlinkSync(path.join(home, "outside"), path.join(home, "work", "link"));
  const p = path.join(home, "work", "link", "new1", "new2", "f.txt");
  assert.equal(real(p), path.join(fs.realpathSync(home), "outside", "new1", "new2", "f.txt"));
  const cfg = defaultPolicy(home, "/opt/code", []);
  assert.equal(decide("Write", { file_path: p }, cfg).verdict, "ask"); // lands outside ~/work: asks
  assert.equal(decide("Write", { file_path: path.join(home, "work", "a", "b", "c.txt") }, cfg).verdict, "allow");
});

test("9. browse writes a private file and never through an existing symlink", () => {
  const dir = tmp();
  const svc = newService({}, dir);
  svc.mem.add("user", "secret plans");
  const out = path.join(svc.paths.run, "browse.html");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  fs.symlinkSync(victim, out); // someone planted a link at the output path
  browse(svc.paths, out);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
  assert.equal(fs.lstatSync(out).isSymbolicLink(), false);
  assert.equal(fs.statSync(out).mode & 0o077, 0);
  assert.match(fs.readFileSync(out, "utf8"), /secret plans/);
});

test("10. ingest never reuses an existing .txt name, even when only the .txt exists", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "2026-10-05-paper.txt"), "earlier text");
  const base = uniqueBase(dir, "2026-10-05-paper", [".pdf", ".txt"]);
  assert.equal(base, "2026-10-05-paper-2");
  fs.writeFileSync(path.join(dir, "2026-10-05-paper-2.pdf"), "x");
  assert.equal(uniqueBase(dir, "2026-10-05-paper", [".pdf", ".txt"]), "2026-10-05-paper-3");
  assert.equal(fs.readFileSync(path.join(dir, "2026-10-05-paper.txt"), "utf8"), "earlier text");
});

test("11. a relative file path is made absolute in the user's shell; URLs are left alone", () => {
  assert.equal(absSrc("notes/a.pdf"), path.resolve(process.cwd(), "notes/a.pdf"));
  assert.equal(absSrc("https://arxiv.org/abs/1234.5678"), "https://arxiv.org/abs/1234.5678");
  assert.equal(absSrc("doi:10.1000/x"), "doi:10.1000/x");
});

test("12. systemd: missing folders do not stop the service, and install creates ~/.claude", () => {
  const plan = installPlan("linux", { user: "ann", node: "/usr/bin/node", codeDir: "/opt/optchat" });
  const unit = plan.files[0].text;
  assert.match(unit, /ReadWritePaths=-\/home\/%i\/optchat -\/home\/%i\/work -\/home\/%i\/\.claude/);
  assert.ok(plan.commands.some((c) => c.includes("install -d") && c.includes("/home/ann/.claude")));
});

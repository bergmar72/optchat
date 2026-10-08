import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { forms, redact, verifyGone, watchRedactions } from "../src/redact.ts";
import { haveFilterRepo, newService } from "./helpers.ts";


function grepAll(dir: string, needle: string, skipGit = true): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skipGit && e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

test("redact --literal: gone from the log, the tree, the link index and files; the rest of the chat survives", async () => {
  const secret = "sk-test-" + crypto.randomBytes(12).toString("hex"); // random: never appears in any transcript
  const svc = newService();
  watchRedactions(svc); // the service installs this at startup: it closes the journal once the rebuild is done
  for (let i = 0; i < 6; i++) svc.mem.add("talk", `ordinary message ${i} ` + "o".repeat(700));
  const bad = svc.mem.add("user", `my key is ${secret} please use it; also see https://x.org/p?token=${secret} ` + "b".repeat(700));
  svc.mem.add("tool", `curl -H "Authorization: ${secret}" https://api.example.com ` + "c".repeat(700)); // an echo of it
  for (let i = 0; i < 5; i++) svc.mem.add("talk", `later message ${i} ` + "l".repeat(700));
  fs.writeFileSync(path.join(svc.paths.links, "..", "links.jsonl"), JSON.stringify({ id: bad.i, date: "d", url: `https://x.org/p?token=${secret}`, context: "k" }) + "\n");
  fs.writeFileSync(path.join(svc.paths.files, "notes.txt"), `remember ${secret}\n`);
  await svc.mem.compactor.whenIdle();
  assert.ok(grepAll(svc.paths.root, secret).length > 0, "test setup: the secret must be on disk first");

  const report = await redact(svc, { id: bad.i, literal: secret });
  assert.match(report, /Rotate or revoke/);
  await svc.mem.compactor.whenIdle(); // dirty nodes are rebuilt

  assert.deepEqual(grepAll(svc.paths.root, secret), []);
  const left = await verifyGone(svc, forms(secret));
  if (haveFilterRepo()) assert.deepEqual(left, []);
  else assert.ok(left.every((x) => x.startsWith("git objects")), `only git history may remain without git-filter-repo, got ${left}`);

  const m = svc.mem.store.msgs;
  assert.match(m[bad.i].text, /\[REDACTED\]/);
  assert.match(m[bad.i].text, /please use it/); // only the secret is removed
  assert.equal(m[0].text.startsWith("ordinary message 0"), true);
  assert.equal(m.length, 13);
  // kinds and ids unchanged; tree complete and view settled
  assert.equal(m[bad.i].kind, "user");
  assert.equal(svc.mem.compactor.dirty.size, 0);
  assert.ok(svc.mem.view.settled());
  for (const n of svc.mem.store.nodes.values()) assert.ok(!n.text.includes(secret));
  // a restart loads the same, clean state
  const again = newService({}, svc.paths.root);
  assert.equal(again.mem.store.total, 13);
  assert.ok(again.mem.view.settled());
  // the journal records the redaction without the secret
  const j = fs.readFileSync(svc.paths.redactions, "utf8");
  assert.ok(!j.includes(secret));
  // "done" only when the git history was rewritten too; without git-filter-repo it stays open
  if (haveFilterRepo()) assert.match(j, /"step":"done"/);
  else assert.doesNotMatch(j, /"step":"done"/);
  assert.equal(svc.locked, false);
});

test("redact --whole: the message becomes (redacted), its kind and date stay, ancestors are rebuilt", async () => {
  const svc = newService();
  for (let i = 0; i < 8; i++) svc.mem.add(i === 3 ? "user" : "talk", `message ${i} ` + "w".repeat(700));
  await svc.mem.compactor.whenIdle();
  const date = svc.mem.store.msgs[3].date;
  await redact(svc, { id: 3, whole: true });
  await svc.mem.compactor.whenIdle();
  const m = svc.mem.store.msgs[3];
  assert.equal(m.text, "(redacted)");
  assert.equal(m.kind, "user");
  assert.equal(m.date, date);
  assert.equal(svc.mem.store.node(0, 3)!.text, "user: (redacted)");
  assert.ok(svc.mem.store.node(3, 0)); // ancestors still built
  assert.equal(svc.mem.compactor.dirty.size, 0);
});

test("redact: an unknown id is refused, and so is a second run while one is going", async () => {
  const svc = newService();
  svc.mem.add("user", "x " + "y".repeat(400));
  await assert.rejects(redact(svc, { id: 5, whole: true }), /no message 5/);
  assert.equal(svc.locked, false);
  const first = redact(svc, { id: 0, whole: true });
  assert.equal(svc.locked, true, "the lock is taken synchronously");
  await assert.rejects(redact(svc, { id: 0, whole: true }), /already running/);
  await first;
  assert.equal(svc.locked, false);
});

test("redact: a crash between 'started' and 'applied' is finished from the plan file at the next start", async () => {
  const svc = newService();
  for (let i = 0; i < 4; i++) svc.mem.add("talk", `m${i} ` + "z".repeat(700));
  await svc.mem.compactor.whenIdle();
  const { resumeRedactions } = await import("../src/redact.ts");
  // simulate: plan written, journal says started, nothing applied
  const m = { ...svc.mem.store.msgs[2], text: "(redacted)", size: 20 };
  const planFile = path.join(svc.paths.run, "redact-test.json");
  fs.writeFileSync(planFile, JSON.stringify({ msgs: [m], nodes: [], dirty: [] }));
  fs.appendFileSync(svc.paths.redactions, JSON.stringify({ ts: "t1", id: 2, mode: "whole", step: "started", plan: planFile, dirty: [] }) + "\n");
  const again = newService({}, svc.paths.root);
  const notes = await resumeRedactions(again);
  assert.match(notes[0], /re-applied/);
  assert.equal(again.mem.store.msgs[2].text, "(redacted)");
  assert.equal(newService({}, svc.paths.root).mem.store.msgs[2].text, "(redacted)"); // on disk
});

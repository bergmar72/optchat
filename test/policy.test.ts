import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, defaultPolicy } from "../src/policy.ts";
import { Memory } from "../src/memory.ts";
import { TruncModel } from "../src/model.ts";
import { Tools } from "../src/tools.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "optchat-p-"));
fs.mkdirSync(path.join(home, "work"));
const cfg = defaultPolicy(home, "/opt/optchat-code", ["/home/other"]);
const v = (tool: string, input: any) => decide(tool, input, cfg).verdict;

test("policy: reading and editing inside ~/work is allowed; outside asks", () => {
  assert.equal(v("Read", { file_path: path.join(home, "work", "a.ts") }), "allow");
  assert.equal(v("Edit", { file_path: path.join(home, "work", "new", "b.ts") }), "allow");
  assert.equal(v("Read", { file_path: "/etc/hosts" }), "ask");
  assert.equal(v("Write", { file_path: path.join(home, "optchat", "files", "x") }), "ask"); // files are read-only
  assert.equal(v("Read", { file_path: path.join(home, "optchat", "files", "paper.txt") }), "allow");
});

test("policy: hard denies", () => {
  assert.equal(v("Bash", { command: "sudo rm -rf /" }), "deny");
  assert.equal(v("Bash", { command: "ls && sudo ls" }), "deny");
  assert.equal(v("Read", { file_path: path.join(home, "work", ".env") }), "deny");
  assert.equal(v("Read", { file_path: path.join(home, ".ssh", "id_ed25519") }), "deny");
  assert.equal(v("Edit", { file_path: "/opt/optchat-code/src/service.ts" }), "deny");
  assert.equal(v("Read", { file_path: path.join(home, "optchat", "chat", "main", "x.jsonl") }), "deny");
  assert.equal(v("Read", { file_path: "/home/other/notes.txt" }), "deny");
  assert.equal(v("Bash", { command: `cat ${home}/optchat/secrets/api` }), "deny");
  assert.equal(v("Grep", { pattern: "x" }), "deny"); // no path: would search the run folder
});

test("policy: a symlink out of ~/work does not escape (to a folder that exists, through a file name that is not a secret)", () => {
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "config"), "Host x");
  const link = path.join(home, "work", "sneaky");
  fs.symlinkSync(path.join(home, ".ssh"), link);
  assert.equal(v("Read", { file_path: path.join(link, "config") }), "deny"); // the NAME is harmless: only the link target gives it away
  assert.equal(v("Read", { file_path: path.join(home, "work", "plain.txt") }), "allow");
});

const gitCfg = { ...cfg, bashAllow: ["git status", "git diff", "git log", "ls", "pwd"] };
const g = (c: string) => decide("Bash", { command: c }, gitCfg).verdict;

test("policy: bash — a few bare read-only commands are allowed, anything with shell syntax asks", () => {
  assert.equal(v("Bash", { command: "ls" }), "allow");
  assert.equal(v("Bash", { command: "pwd" }), "allow");
  assert.equal(v("Bash", { command: "git status" }), "ask"); // git is not auto-allowed by default: a repo's own config can run programs
  assert.equal(g("git status"), "allow"); // unless the user adds it to bashAllow
  assert.equal(g("git status; rm -rf x"), "ask");
  assert.equal(v("Bash", { command: "ls $(whoami)" }), "ask");
  assert.equal(v("Bash", { command: "npm test" }), "ask");
  assert.equal(v("WebFetch", { url: "https://example.com" }), "ask");
  assert.equal(v("mcp__optchat__zoom", { id: 0, n: 2 }), "allow");
});

test("tools: zoom validates, opens a line into its two children, and gives a message whole", async () => {
  const mem = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "optchat-z-")), new TruncModel());
  for (let i = 0; i < 8; i++) mem.add(i % 2 ? "talk" : "user", `message ${i} ` + "p".repeat(300));
  await mem.compactor.whenIdle();
  const t = new Tools(mem, "/nonexistent", "/nonexistent");
  assert.equal(t.zoom(1, 2), "No line 1+2."); // id % n != 0
  assert.equal(t.zoom(0, 3), "No line 0+3.");
  assert.equal(t.zoom(0, 16), "No line 0+16.");
  assert.equal(t.zoom(3, 1), "3+0|talk: message 3 " + "p".repeat(300));
  const lines = t.zoom(0, 8).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^0\+4\|[a-z]+\|/);
  assert.match(lines[1], /^4\+4\|[a-z]+\|/);
  assert.match(t.date(0), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
});

test("tools: search finds raw messages the summaries dropped, falls back to all-words, and indexes files and links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optchat-s-"));
  const mem = new Memory(path.join(dir, "chat"), new TruncModel());
  mem.add("user", "the rotor speed was 4711 rpm at the test, " + "y".repeat(600));
  mem.add("talk", "unrelated " + "n".repeat(600));
  fs.mkdirSync(path.join(dir, "files"));
  fs.writeFileSync(path.join(dir, "files", "paper.txt"), "line one\nthe Kalman filter converges\n");
  fs.writeFileSync(path.join(dir, "links.jsonl"), JSON.stringify({ id: 1, date: "d", url: "https://x.org/kalman", context: "kalman notes" }) + "\n");
  const t = new Tools(mem, path.join(dir, "files"), path.join(dir, "links.jsonl"));
  assert.match(t.search("4711 rpm"), /^0\|user\|/);
  assert.match(t.search("speed rpm"), /^0\|user\|/); // all words, not the phrase
  assert.match(t.search("kalman"), /file \/.*files\/paper\.txt:2/); // absolute: the agent works elsewhere
  assert.match(t.search("kalman"), /link msg 1/);
  assert.match(t.search("no-such-thing"), /No match/);
});

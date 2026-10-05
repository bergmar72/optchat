import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendDurable, readJsonl, writeAtomic } from "../src/fsx.ts";
import { Memory } from "../src/memory.ts";
import { Store, StoreError } from "../src/store.ts";
import { TruncModel } from "../src/model.ts";
import { tmp } from "./helpers.ts";

/** Make fs.writeSync misbehave for the next calls. */
function patchWrite(fn: (real: typeof fs.writeSync, args: any[], n: number) => number) {
  const real = fs.writeSync;
  let n = 0;
  (fs as any).writeSync = (...args: any[]) => fn(real as any, args, ++n);
  return () => ((fs as any).writeSync = real);
}

test("a short write is completed, not acknowledged half-written", () => {
  const f = path.join(tmp(), "a.jsonl");
  const undo = patchWrite((real, args, n) => (n === 1 ? (real as any)(args[0], args[1], args[2], Math.floor(args[3] / 2)) : (real as any)(...args)));
  try {
    appendDurable(f, '{"i":0,"text":"' + "x".repeat(200) + '"}\n');
  } finally {
    undo();
  }
  assert.equal(readJsonl(f).rows.length, 1);
  assert.equal(readJsonl(f).bad, 0);
});

test("a failed append is cut back: no fragment for the next append to glue onto", () => {
  const f = path.join(tmp(), "a.jsonl");
  appendDurable(f, '{"i":0}\n');
  const undo = patchWrite((real, args, n) => {
    if (n === 1) return (real as any)(args[0], args[1], args[2], 5); // part of the line goes in...
    throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); // ...then the disk is full
  });
  try {
    assert.throws(() => appendDurable(f, '{"i":1,"text":"long enough line"}\n'), /ENOSPC/);
  } finally {
    undo();
  }
  assert.equal(fs.readFileSync(f, "utf8"), '{"i":0}\n');
  appendDurable(f, '{"i":1}\n');
  assert.deepEqual(readJsonl(f).rows, [{ i: 0 }, { i: 1 }]);
});

test("appendDurable starts on its own line after a torn tail", () => {
  const f = path.join(tmp(), "a.jsonl");
  fs.writeFileSync(f, '{"i":0}\n{"i":1,"te');
  appendDurable(f, '{"i":2}\n');
  assert.equal(fs.readFileSync(f, "utf8"), '{"i":0}\n{"i":1,"te\n{"i":2}\n');
});

test("writeAtomic: a short write leaves the original untouched and no temp file", () => {
  const f = path.join(tmp(), "t.jsonl");
  fs.writeFileSync(f, "original\n");
  const undo = patchWrite(() => 0);
  try {
    assert.throws(() => writeAtomic(f, "new content that is longer\n"), /short write/);
  } finally {
    undo();
  }
  assert.equal(fs.readFileSync(f, "utf8"), "original\n");
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["t.jsonl"]);
});

test("store: a torn tail is cut off the file, later appends survive a reload", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "one");
  const file = path.join(s.mainDir, fs.readdirSync(s.mainDir)[0]);
  fs.appendFileSync(file, '{"i":1,"kind":"user","te');
  const s2 = Store.open(dir);
  assert.equal(s2.total, 1);
  assert.equal(s2.warnings.length, 1);
  s2.appendMsg("user", "two");
  s2.appendMsg("user", "three");
  const s3 = Store.open(dir);
  assert.deepEqual(s3.msgs.map((m) => m.text), ["one", "two", "three"]);
  assert.deepEqual(s3.warnings, []);
});

test("store: a bad line in the MIDDLE refuses to start instead of dropping everything after it", () => {
  const dir = tmp();
  const s = Store.open(dir);
  for (const t of ["zero", "one", "two", "three"]) s.appendMsg("user", t);
  const file = path.join(s.mainDir, fs.readdirSync(s.mainDir)[0]);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines[1] = lines[1].slice(0, 20); // damage line 2
  fs.writeFileSync(file, lines.join("\n"));
  assert.throws(() => Store.open(dir), (e: any) => e instanceof StoreError && /line 2/.test(e.message) && /Refusing to start/.test(e.message));
});

test("store: a gap in the ids refuses to start; a duplicate id keeps the first", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "zero");
  s.appendMsg("user", "one");
  const file = path.join(s.mainDir, fs.readdirSync(s.mainDir)[0]);
  const [a, b] = fs.readFileSync(file, "utf8").split("\n");
  fs.writeFileSync(file, [a, b, b, ""].join("\n")); // duplicate of id 1
  const dup = Store.open(dir);
  assert.equal(dup.total, 2);
  assert.match(dup.warnings[0], /duplicate message id 1/);
  fs.writeFileSync(file, [a, b.replace('"i":1', '"i":5'), ""].join("\n"));
  assert.throws(() => Store.open(dir), /messages are missing/);
});

test("store: the base spec's tool/echo kinds load as steps; an unknown kind refuses", () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.appendMsg("user", "hi");
  const file = path.join(s.mainDir, fs.readdirSync(s.mainDir)[0]);
  const mk = (i: number, kind: string) => JSON.stringify({ i, kind, text: "t", size: 8, date: "2026-01-01T00:00:00.000Z" });
  fs.appendFileSync(file, mk(1, "tool") + "\n" + mk(2, "echo") + "\n" + mk(3, "talk") + "\n");
  assert.deepEqual(Store.open(dir).msgs.map((m) => m.kind), ["user", "step", "step", "talk"]);
  fs.appendFileSync(file, mk(4, "bogus") + "\n");
  assert.throws(() => Store.open(dir), /unknown kind 'bogus'/);
});

test("memory.add: if writing the free leaf fails, the message is still in the view", () => {
  const mem = new Memory(tmp(), new TruncModel());
  const real = mem.store.putNode.bind(mem.store);
  let fail = true;
  mem.store.putNode = ((n: any) => (fail ? (fail = false, (() => { throw new Error("ENOSPC"); })()) : real(n))) as any;
  assert.throws(() => mem.add("user", "short one"), /ENOSPC/);
  mem.add("user", "second");
  assert.equal(mem.store.total, 2);
  assert.equal(mem.view.parts.length, 2); // the view tiles both messages
  assert.equal(mem.view.parts[0].i, 0);
});

test("putNode on an existing node: memory is not ahead of the disk if the write fails", () => {
  const dir = tmp();
  const s = Store.open(dir);
  const m = s.appendMsg("step", "x".repeat(900));
  s.putNode({ l: 0, i: 0, text: "old summary", size: 11, kinds: "s" });
  const undo = patchWrite(() => 0);
  try {
    assert.throws(() => s.putNode({ l: 0, i: 0, text: "NEW summary", size: 11, kinds: "s" }));
  } finally {
    undo();
  }
  assert.equal(s.node(0, 0)!.text, "old summary");
  assert.equal(Store.open(dir).node(0, 0)!.text, "old summary");
  void m;
});

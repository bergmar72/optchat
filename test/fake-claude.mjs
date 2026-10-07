#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// The first stdin message carries the script in its last text block: "SCRIPT:<name>".
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const rl = readline.createInterface({ input: process.stdin });
let first = true;
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;
const text = (m) => m.message.content.map((b) => b.text ?? "").join("");
send({ type: "system", subtype: "init", ...(process.env.FAKE_KEY_SOURCE === "__omit__" ? {} : { apiKeySource: process.env.FAKE_KEY_SOURCE ?? "none" }), model: "fake" });
const tool = (id, name, input) => send({ type: "assistant", uuid: uuid(), message: { id: "msg_" + id, model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, is_error = false) => send({ type: "user", uuid: uuid(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
const say = (t) => send({ type: "assistant", uuid: uuid(), message: { id: "msg_t" + uuidN, model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: t }] } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (!first) { send({ ...m, isReplay: true }); return; } // mid-run message consumed
  first = false;
  send({ ...m, isReplay: true });
  const t = text(m);
  if (/SCRIPT:echo/.test(t)) {
    say("GOT:" + m.message.content.at(-1).text); // what the agent actually receives as its new message
  } else if (/SCRIPT:parallel/.test(t)) {
    tool("a1", "Read", { file_path: "/x/a" }); tool("b2", "Bash", { command: "ls" });
    result("b2", "second finished first"); result("a1", "first");
    say("both done");
  } else if (/SCRIPT:slow/.test(t)) {
    tool("s1", "Bash", { command: "sleep" });
    await sleep(400);
    result("s1", "slept");
    await sleep(100);
    say("slow done");
  } else if (/SCRIPT:deaf/.test(t)) {
    process.on("SIGINT", () => {}); // a child that ignores every polite request
    process.on("SIGTERM", () => {});
    tool("d1", "Bash", { command: "sleep" });
    await sleep(120000);
  } else if (/SCRIPT:noinput/.test(t)) {
    send({ type: "assistant", uuid: uuid(), message: { id: "m_ni", content: [{ type: "tool_use", id: "n1", name: "Bash" }] } }); // no input
    send({ type: "assistant", uuid: uuid(), message: null }); // malformed
    send({ type: "user", uuid: uuid(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "n1", content: 5 }] } }); // content not a string
    say("survived");
  } else if (/SCRIPT:crash/.test(t)) {
    tool("c1", "Bash", { command: "never returns" });
    say("about to die"); await sleep(50); process.exit(1);
  } else say("ok");
  send({ type: "result", subtype: "success", is_error: false, result: "ok" });
});

// S2a probe: does the view prefix get cache hits ACROSS turns through `claude -p`? (spends 2-3 subscription requests)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const code = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "optchat-cache-")), "optchat");
fs.mkdirSync(home, { recursive: true });
const svc = spawn(process.execPath, [path.join(code, "bin/optchat.mjs"), "serve", "--dev-model"], { env: { ...process.env, OPTCHAT_HOME: home, OPTCHAT_MODEL: "sonnet", OPTCHAT_EXTRA_ARGS: "--effort low" }, stdio: ["ignore", "ignore", "pipe"] });
let up = "";
svc.stderr.on("data", (d) => ((up += d), process.stderr.write(d)));
const sock = path.join(home, "run", "sock");
for (let i = 0; i < 150 && !/service up/.test(up); i++) await new Promise((r) => setTimeout(r, 100));
const rpc = (role, msgs, until) => new Promise((res) => { const k = net.connect(sock); let b = ""; k.on("data", (d) => { b += d; for (const l of b.split("\n")) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (until(m)) { k.end(); res(m); return; } } }); k.write(JSON.stringify({ t: "hello", role, token: fs.readFileSync(path.join(home, "secrets", "client-token"), "utf8").trim() }) + "\n" + msgs.map((m) => JSON.stringify(m)).join("\n") + "\n"); });
const notes = Array.from({ length: 700 }, (_, i) => `note ${i}: ${["rotor", "gimbal", "firmware", "invoice", "kalman", "battery"][i % 6]} ${crypto.randomUUID()} ${"detail ".repeat(36)}`);
await rpc("ctl", [{ t: "ctl", id: 1, cmd: "import", notes }], (m) => m.t === "ctl_result");
const st = JSON.parse((await rpc("ctl", [{ t: "ctl", id: 2, cmd: "status" }], (m) => m.t === "ctl_result")).text);
console.log("view bytes:", st.viewBytes, "parts:", st.viewParts, "messages:", st.messages);
// attach replays the last events: only a busy -> idle transition AFTER our message ends the turn
const turn = (text) => new Promise((res) => {
  const k = net.connect(sock);
  let buf = "", busy = false;
  k.setEncoding("utf8");
  k.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.ev === "status" && m.text !== "idle" && sent) busy = true;
      if (m.ev === "status" && m.text === "idle" && busy) { k.end(); res(); }
    }
  });
  let sent = false;
  k.on("connect", () => {
    const token = fs.readFileSync(path.join(home, "secrets", "client-token"), "utf8").trim();
    k.write(JSON.stringify({ t: "hello", role: "attach", token }) + "\n");
    setTimeout(() => { sent = true; k.write(JSON.stringify({ t: "input", text }) + "\n"); }, 200);
  });
});
await turn("Reply with exactly the word: ok");
await new Promise((r) => setTimeout(r, 2000));
await turn("Reply with exactly the word: again");
const rows = fs.readFileSync(path.join(home, "run/usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const r of rows) console.log(JSON.stringify(r));
svc.kill();

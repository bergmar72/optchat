// End-to-end check against the REAL `claude` CLI (spends a few subscription requests).
// Run: node test/e2e.mjs   (the compactor is the dev model: no API calls)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const code = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "optchat-e2e-"));
const work = path.join(root, "work");
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, "note.txt"), "The launch code word is PELICAN-77.\n");
fs.mkdirSync(path.join(work, "proj"));
fs.writeFileSync(path.join(work, "proj", ".env"), "SERVICE_TOKEN=hunter2-SECRET\n");
fs.writeFileSync(path.join(work, "proj", "readme.txt"), "SERVICE_TOKEN is documented in the wiki.\n");
fs.mkdirSync(path.join(root, "optchat"), { recursive: true });
const home = path.join(root, "optchat");
fs.writeFileSync(path.join(home, "policy.json"), JSON.stringify({ work, bashAllow: ["pwd"] }));

const svc = spawn(process.execPath, [path.join(code, "bin/optchat.mjs"), "serve", "--dev-model"], {
  env: { ...process.env, OPTCHAT_HOME: home, OPTCHAT_MODEL: "sonnet", OPTCHAT_EXTRA_ARGS: "--effort low" },
  stdio: ["ignore", "inherit", "pipe"],
});
let up = "";
svc.stderr.on("data", (d) => ((up += d), process.stderr.write(d)));
const sock = path.join(home, "run", "sock");
for (let i = 0; i < 150 && !/service up/.test(up); i++) await new Promise((r) => setTimeout(r, 100));
if (!/service up/.test(up)) { console.error("the service did not start"); svc.kill(); process.exit(2); }

const log = [];
const c = net.connect(sock);
let idleResolve;
let buf = "";
const confirms = [];
c.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log.push(m);
    if (m.ev === "entry") console.log(`  [${m.kind}] ${String(m.text).replace(/\s+/g, " ").slice(0, 150)}`);
    if (m.ev === "info") console.log(`  ! ${m.text}`);
    if (m.ev === "confirm") {
      console.log(`  ? confirm ${m.tool}: ${m.why}  -> answering yes`);
      confirms.push(m);
      c.write(JSON.stringify({ t: "answer", nonce: m.nonce, allow: true }) + "\n");
    }
    if (m.ev === "status" && m.text === "idle") idleResolve?.();
  }
});
const token = fs.readFileSync(path.join(home, "secrets", "client-token"), "utf8").trim();
c.write(JSON.stringify({ t: "hello", role: "attach", token }) + "\n");
const say = (text) => new Promise((res) => { idleResolve = res; console.log(`\nYOU: ${text}`); c.write(JSON.stringify({ t: "input", text }) + "\n"); });
const ctl = (cmd, extra = {}) => new Promise((res, rej) => {
  const k = net.connect(sock); let b = "";
  k.on("data", (d) => { b += d; for (const line of b.split("\n")) { if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.t === "ctl_result") { k.end(); m.ok ? res(m.text) : rej(new Error(m.text)); } } });
  k.write(JSON.stringify({ t: "hello", role: "ctl", token }) + "\n" + JSON.stringify({ t: "ctl", id: 1, cmd, ...extra }) + "\n");
});

const timeout = setTimeout(() => { console.error("TIMEOUT"); svc.kill(); process.exit(2); }, 420_000);
try {
  await say(`Please do three things and then reply in one short sentence: (1) use the search tool for the word "zzzqqq"; (2) Read the file ${work}/note.txt; (3) run the bash command \`touch ${work}/marker.txt\` (it creates a file).`);
  await ctl("status").then((s) => console.log("\nSTATUS after turn 1:", JSON.parse(s)));
  await say("What was the code word in the file I asked you to read? Answer from your memory of our chat, zooming if needed.");
  const status = JSON.parse(await ctl("status"));
  console.log("\nSTATUS after turn 2:", status);
  // Grep searches hidden files too: the hook must have added the exclusions (updatedInput), or the .env line comes back
  await say(`Use the Grep tool (not Bash) to search for SERVICE_TOKEN in ${work}/proj, and tell me which files matched.`);
  // a saved paper: the agent must be able to open it (the record gives an absolute path under the read-only files folder)
  const paper = path.join(root, "paper.txt");
  fs.writeFileSync(paper, "Abstract. The calibration constant is ZEBRA-42 in all runs.\n");
  await new Promise((res) => { idleResolve = res; console.log("\nYOU: optchat file paper.txt  (note: what is the calibration constant?)"); ctl("file", { src: paper, note: "What is the calibration constant in the paper I just sent? Open the file to check." }); });
  const msgs = fs.readdirSync(path.join(home, "chat/main")).flatMap((f) => fs.readFileSync(path.join(home, "chat/main", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const kinds = {}; for (const m of msgs) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
  console.log("log kinds:", kinds);
  const usage = fs.existsSync(path.join(home, "run/usage.jsonl")) ? fs.readFileSync(path.join(home, "run/usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log("usage rows:"); for (const u of usage) console.log("  ", JSON.stringify(u));
  const last = [...msgs].reverse().find((m) => m.kind === "talk");
  const fileRec = msgs.find((m) => m.kind === "file");
  const checks = {
    "talk replies logged": !!kinds.talk,
    "the confirmed bash command ran": fs.existsSync(path.join(work, "marker.txt")),
    "steps logged (one per tool call)": (kinds.step ?? 0) >= 3,
    "a confirmation was asked for the bash write": confirms.some((m) => /touch/.test(m.why)),
    "Read inside work was allowed without asking": !confirms.some((m) => /note\.txt/.test(m.why)),
    "turn 2 recalled PELICAN-77": msgs.some((m) => m.kind === "talk" && /PELICAN-77/i.test(m.text)),
    "the file record gives an absolute path": /^path: \//m.test(fileRec?.text ?? ""),
    "the agent opened the saved paper (ZEBRA-42)": /ZEBRA-42/.test(last?.text ?? ""),
    "Grep ran, and the .env line never came back (updatedInput honoured)": (() => {
      const g = msgs.filter((m) => m.kind === "step" && /^Grep /.test(m.text));
      // both files contain the string: "Found 1 file" (the readme) proves the .env was excluded
      return g.some((m) => /Found 1 file/.test(m.text) && /readme\.txt/.test(m.text) && !/\.env/.test(m.text.split("→")[1] ?? "")) && !msgs.some((m) => /hunter2-SECRET/.test(m.text) && m.kind !== "user");
    })(),
    "no tool call was denied as protected": !msgs.some((m) => m.kind === "step" && /is protected/.test(m.text)),
    "usage logged": usage.length > 0,
  };
  console.log("\nCHECKS"); for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
} finally {
  clearTimeout(timeout);
  svc.kill();
  console.log(`\n(data left in ${root})`);
}

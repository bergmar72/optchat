import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { haveRestic, resticBackup, resticRestore } from "./backup.ts";
import { ctl } from "./client.ts";
import { isLink } from "./ingest.ts";
import { haveFilterRepo } from "./redact.ts";
import { installPlan, detect, writeFilesIfRoot } from "./platform.ts";
import type { Paths } from "./service.ts";
import { Store } from "./store.ts";
import { localStamp } from "./tools.ts";
import { span } from "./types.ts";
import { cutPieces, View } from "./view.ts";

interface Ctx {
  paths: Paths;
  codeDir: string;
}

/** The service runs elsewhere (cwd "/" under systemd): resolve a local path HERE, in the user's shell. */
export const absSrc = (src: string): string => (isLink(src) ? src : path.resolve(process.cwd(), src));

const USAGE = `optchat <command>

  serve [--dev-model]            run the service (normally started by systemd/launchd)
  attach [--view]                talk to the chat (plain output; works over ssh and tmux)
  status | view | stop           ask the running service
  file <path|url> [note...]      save a file or paper, log it, and have the agent read it
  redact <id> --literal|--whole  remove a secret from the log, the tree, git history and backups
  browse [out.html]              write the whole memory as one HTML page (read-only)
  import <notes.txt>             import old notes (one per line, or JSON lines with a "text") as kind note
  backup                         restic snapshot of ~/optchat now
  restore-test                   restore the newest snapshot to a temp folder and check that its view loads
  install-service <user> [--write]  print (or write, as root) the systemd/launchd files for a user
  doctor                         check the host for what the harness needs
`;

export async function runOther(cmd: string | undefined, rest: string[], ctx: Ctx): Promise<void> {
  const { paths } = ctx;
  switch (cmd) {
    case "file": {
      const [src, ...note] = rest;
      if (!src) throw new Error("usage: optchat file <path|url> [note...]");
      console.log(await ctl(paths.sock, "file", { src: absSrc(src), note: note.join(" ") || undefined }));
      return;
    }
    case "import": {
      const file = rest[0];
      if (!file) throw new Error("usage: optchat import <notes.txt>");
      const notes = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            const j = JSON.parse(l);
            return typeof j === "string" ? j : String(j.text ?? l);
          } catch {
            return l;
          }
        });
      console.log(await ctl(paths.sock, "import", { notes }));
      return;
    }
    case "backup":
      console.log(await ctl(paths.sock, "backup").catch((e) => (haveRestic(paths) ? resticBackup(paths) : Promise.reject(e))));
      return;
    case "restore-test":
      return await restoreTest(paths);
    case "browse":
      return browse(paths, rest[0] ?? path.join(paths.run, "browse.html"));
    case "install-service": {
      const user = rest.find((a) => !a.startsWith("--"));
      if (!user) throw new Error("usage: optchat install-service <user> [--write]");
      const p = detect();
      const plan = installPlan(p, { user, node: process.execPath, codeDir: ctx.codeDir });
      for (const w of plan.notes.filter((n) => n.startsWith("WARNING"))) console.error(w);
      for (const f of plan.files) console.log(`# ${f.path}\n${f.text}`);
      if (rest.includes("--write")) console.log("wrote:", writeFilesIfRoot(plan.files).join(", "));
      console.log("# then, as root:\n" + plan.commands.map((c) => `  ${c}`).join("\n"));
      console.log("# notes:\n" + plan.notes.map((n) => `  - ${n}`).join("\n"));
      return;
    }
    case "doctor":
      return doctor(ctx);
    default:
      console.log(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

function have(bin: string, args = ["--version"]): string | null {
  try {
    return execFileSync(bin, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n")[0].trim() || "ok";
  } catch {
    return null;
  }
}

function doctor(ctx: Ctx): void {
  const rows: Array<[string, string | null, boolean]> = [
    ["node >= 22", parseInt(process.versions.node) >= 22 ? process.version : null, true],
    ["claude", have("claude"), true],
    ["git", have("git"), true],
    ["git-filter-repo (redaction of git history)", haveFilterRepo() ? "ok" : null, false],
    ["pdftotext (papers)", have("pdftotext", ["-v"]) ?? (fs.existsSync("/usr/bin/pdftotext") ? "ok" : null), false],
    ["restic (off-host backup)", haveRestic(ctx.paths) ? "ok" : have("restic", ["version"]) ? "installed, but secrets/restic.env is missing" : null, false],
    ["rg (optional, not required)", have("rg"), false],
  ];
  for (const [name, v, required] of rows) console.log(`${v ? "ok     " : required ? "MISSING" : "absent "} ${name}${v ? `  ${v}` : ""}`);
  const secrets = ctx.paths.secrets;
  for (const f of ["api", "oauth", "restic.env"]) {
    let state = "absent";
    try {
      const st = fs.statSync(path.join(secrets, f));
      state = st.mode & 0o077 ? "READABLE BY OTHERS: chmod 600" : "ok (mode 600)";
    } catch {
      // absent
    }
    console.log(`secret ${f}: ${state}`);
  }
  for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) if (process.env[v]) console.log(`note: ${v} is set in this shell; the service never passes it to claude`);
}

export function browse(paths: Paths, out: string): void {
  const store = Store.open(paths.chat, true);
  const view = View.fold(store);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const when = (a: number, n: number) => {
    const first = store.msgs[a]?.date;
    const last = store.msgs[Math.min(a + n, store.total) - 1]?.date;
    return first ? `${localStamp(first).slice(0, 16)} → ${localStamp(last ?? first).slice(0, 16)}` : "";
  };
  const parts: string[] = [];
  parts.push(`<h2>View (${view.parts.length} lines, ${view.bytes()} bytes)</h2><pre>${esc(cutPieces(view.lines(), []).join(""))}</pre>`);
  parts.push(`<h2>ROOT: every message (${store.total})</h2>`);
  parts.push(store.msgs.map((m) => `<details><summary>${m.i} · ${m.kind} · ${localStamp(m.date)} · ${m.size} B · ${esc(m.text.replace(/\s+/g, " ").slice(0, 100))}</summary><pre>${esc(m.text)}</pre></details>`).join("\n"));
  const maxL = Math.floor(Math.log2(Math.max(1, store.total)));
  for (let l = 0; l <= maxL; l++) {
    const rows: string[] = [];
    for (let i = 0; (i + 1) * span(l) <= store.total; i++) {
      const n = store.node(l, i);
      if (n) rows.push(`<tr><td>${i * span(l)}+${span(l)}</td><td>${n.kinds}</td><td>${when(i * span(l), span(l))}</td><td>${n.size}</td><td>${esc(n.text.replace(/\s+/g, " "))}</td></tr>`);
    }
    parts.push(`<h2>Level ${l} (${span(l)} message${l ? "s" : ""} per line, ${rows.length} lines)</h2><table>${rows.join("")}</table>`);
  }
  // private file, and never through a symlink someone else put there
  fs.rmSync(out, { force: true });
  fs.writeFileSync(
    out,
    `<!doctype html><meta charset=utf-8><title>OptChat memory</title><style>body{font:14px/1.4 system-ui;max-width:1100px;margin:2em auto;padding:0 1em}pre{white-space:pre-wrap;background:#f4f4f4;padding:.6em;overflow:auto}td{vertical-align:top;border-bottom:1px solid #ddd;padding:2px 6px}summary{cursor:pointer}</style>${parts.join("\n")}`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(`wrote ${out}`);
}

async function restoreTest(paths: Paths): Promise<void> {
  if (!haveRestic(paths)) throw new Error("restic is not installed or secrets/restic.env is missing");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optchat-restore-"));
  try {
    await resticRestore(paths, tmp);
    const restored = path.join(tmp, paths.root, "chat");
    const a = View.fold(Store.open(restored, true));
    const b = View.fold(Store.open(paths.chat, true));
    const same = a.lines().join("\n") === b.lines().join("\n");
    console.log(same ? `ok: the restored chat loads the same view (${a.parts.length} lines)` : "DIFFERENT: the restored view differs from the live one (a newer live state is expected if turns ran since the snapshot)");
    process.exitCode = same ? 0 : 2;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}


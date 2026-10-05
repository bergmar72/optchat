import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execP = promisify(execFile);
// A global gpgsign, commit hook or template must not be able to turn a commit into a silent no-op.
const BASE = [
  "-c", "user.name=optchat",
  "-c", "user.email=optchat@localhost",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "core.hooksPath=/dev/null",
];
const run = async (cwd: string, args: string[]) => (await execP("git", [...BASE, ...args], { cwd, timeout: 120_000, maxBuffer: 64 << 20 })).stdout;

/** Local safety net: one commit per turn. No remote. Messages never contain chat text. */
export function ensureRepo(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const g = (args: string[]) => execFileSync("git", [...BASE, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    if (!fs.existsSync(path.join(dir, ".git"))) g(["init", "-q"]);
    g(["config", "core.fsync", "all"]);
    return true;
  } catch {
    return false; // git missing: the log itself is still durable
  }
}

/** Commit everything. Returns true only if the working tree is clean afterwards. Never blocks the event loop. */
export async function commitAll(dir: string, label: string): Promise<boolean> {
  try {
    await run(dir, ["add", "-A"]);
    if ((await run(dir, ["status", "--porcelain"])).trim()) await run(dir, ["commit", "-q", "--no-verify", "-m", label]);
    return !(await run(dir, ["status", "--porcelain"])).trim();
  } catch {
    return false;
  }
}

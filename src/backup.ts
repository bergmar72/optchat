import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Paths } from "./service.ts";

const execP = promisify(execFile);

/** restic settings live in secrets/restic.env: KEY=VALUE lines (RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE, backend credentials). */
export function resticEnv(paths: Paths): Record<string, string> | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(paths.secrets, "restic.env"), "utf8");
  } catch {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env.RESTIC_REPOSITORY ? env : null;
}

/** restic never runs on the event loop: a backup over the network can take minutes. */
async function restic(paths: Paths, args: string[], timeoutMs = 3 * 3600_000): Promise<string> {
  const cfg = resticEnv(paths);
  if (!cfg) throw new Error(`restic is not configured (${path.join(paths.secrets, "restic.env")})`);
  const { stdout } = await execP("restic", args, {
    env: { HOME: os.homedir(), PATH: process.env.PATH ?? "", ...cfg },
    maxBuffer: 64 << 20,
    timeout: timeoutMs,
  });
  return stdout;
}

export function haveRestic(paths: Paths): boolean {
  if (!resticEnv(paths)) return false;
  try {
    execFileSync("restic", ["version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** One restic snapshot of the whole ~/optchat (both .git directories included), without secrets and run state. */
export function resticBackup(paths: Paths): Promise<string> {
  return restic(paths, ["backup", paths.root, "--tag", "optchat", "--exclude", paths.secrets, "--exclude", paths.run]);
}

/** restic prints `null` (or nothing) when there are no snapshots. */
export function parseSnapshots(out: string): Array<{ id: string; time: string }> {
  const v = JSON.parse(out.trim() || "[]");
  return Array.isArray(v) ? v : [];
}

/** Forget every snapshot taken at or after `sinceIso` (minus slack), prune with no unused space left, and check. */
export async function resticPurge(paths: Paths, sinceIso: string): Promise<string[]> {
  const notes: string[] = [];
  const since = new Date(sinceIso).getTime() - 10 * 60_000;
  const snaps = parseSnapshots(await restic(paths, ["snapshots", "--json", "--tag", "optchat"]));
  const ids = snaps.filter((s) => new Date(s.time).getTime() >= since).map((s) => s.id);
  if (ids.length) {
    await restic(paths, ["forget", ...ids]);
    notes.push(`restic: forgot ${ids.length} snapshot(s) taken since ${sinceIso.slice(0, 10)}`);
  }
  await restic(paths, ["prune", "--max-unused", "0"]);
  notes.push("restic: pruned with --max-unused 0");
  await restic(paths, ["check"]);
  return notes;
}

/** Restore the newest snapshot into `target` (for the monthly restore test and for verification). */
export async function resticRestore(paths: Paths, target: string, include?: string): Promise<void> {
  await restic(paths, ["restore", "latest", "--target", target, "--tag", "optchat", ...(include ? ["--include", include] : [])]);
}

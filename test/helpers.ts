import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TruncModel } from "../src/model.ts";
import { Service } from "../src/service.ts";

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "optchat-t-"));
const fake = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fake-claude.mjs");

export function newService(env: Record<string, string> = {}, root = tmp()): Service {
  return new Service(
    {
      root,
      codeDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      mcpCommand: [process.execPath, "optchat.mjs", "mcp"],
      killGraceMs: 200,
      log: () => {},
      spawnClaude: (_args, _env, cwd) => spawn(process.execPath, [fake], { cwd, env: { ...process.env, ...env } }) as any,
    },
    new TruncModel(),
  );
}
import { execFileSync } from "node:child_process";

/** Same probe the product uses, so tests branch on the same condition as the code. */
export { haveFilterRepo } from "../src/redact.ts";
export const msgs = (svc: Service) => svc.mem.store.msgs.map((m) => `${m.kind}: ${m.text}`);

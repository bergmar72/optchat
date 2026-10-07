// Only the standard library at the top: `hook` runs once per tool call and `mcp` once per turn, and they
// must not load the Anthropic SDK, the MCP SDK and the whole service just to start. The rest is imported where it is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launcherPath, pathsFor } from "./paths.ts";

// absolute: the shim and the hook run in another folder and must find the same socket
const root = path.resolve(process.env.OPTCHAT_HOME ?? path.join(os.homedir(), "optchat"));
const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = pathsFor(root);
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);

function readSecret(name: string): string | undefined {
  const f = path.join(paths.secrets, name);
  try {
    const mode = fs.statSync(f).mode & 0o077;
    if (mode) console.error(`warning: ${f} is readable by others (chmod 600 it)`);
    return fs.readFileSync(f, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

async function serve(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY || readSecret("api");
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || readSecret("oauth");
  // The service itself keeps the API key (compactor only). Nothing else may inherit it.
  for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[v];
  const { AnthropicModel, TruncModel } = await import("./model.ts");
  const model = flag("dev-model")
    ? new TruncModel()
    : apiKey
      ? new AnthropicModel(new (await import("@anthropic-ai/sdk")).default({ apiKey }))
      : die(`No API key for the compactor. Put it in ${path.join(paths.secrets, "api")} (mode 600), or use --dev-model for a throwaway test.`);
  if (flag("dev-model")) console.error("WARNING: --dev-model: summaries are truncated text, not model summaries. Do not use on a real chat.");

  // The lock comes FIRST. Building the Service opens the log, runs git and may repair files:
  // an instance that is about to lose the lock must not touch any of that.
  const { ensureClientToken, Service } = await import("./service.ts");
  const { claimLock } = await import("./lock.ts");
  const { otherHomesOf } = await import("./policy.ts");
  ensureClientToken(paths);
  const server = await claimLock(paths.sock);
  if (!server) {
    console.error("another OptChat service owns this chat; exiting");
    process.exit(0); // exit 0 so the service manager does not restart it in a loop
  }
  const svc = new Service(
    {
      root,
      codeDir,
      mcpCommand: [process.execPath, launcherPath(codeDir), "mcp"],
      claudeBin: process.env.OPTCHAT_CLAUDE ?? "claude",
      masterModel: process.env.OPTCHAT_MODEL,
      oauthToken,
      otherHomes: otherHomesOf(os.homedir()),
      extraClaudeArgs: process.env.OPTCHAT_EXTRA_ARGS?.split(" ").filter(Boolean),
    },
    model,
  );
  // Commands and the resume of an interrupted redaction are in place BEFORE the first client is served.
  const { registerHandlers } = await import("./handlers.ts");
  registerHandlers(svc);
  svc.serve(server);
  const s = svc.status();
  console.error(`OptChat service up: ${s.messages} messages, ${s.nodes} nodes, view ${s.viewBytes} bytes. Attach: optchat attach`);
  const stop = () => void svc.shutdown().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "serve":
      return serve();
    case "mcp": {
      const { runMcpShim } = await import("./mcp.ts");
      return runMcpShim(paths.sock);
    }
    case "hook": {
      const { runHook } = await import("./hook.ts");
      return runHook(paths.sock, await readAll());
    }
    case "attach": {
      const { attach } = await import("./client.ts");
      return attach(paths.sock, { view: flag("view") });
    }
    case "status":
    case "view":
    case "stop":
    case "shutdown":
      console.log(await (await import("./client.ts")).ctl(paths.sock, cmd));
      return;
    case "redact": {
      const id = Number(rest.find((a) => /^\d+$/.test(a)));
      if (!Number.isInteger(id)) die("usage: optchat redact <id> --literal | --whole   (the secret is read from stdin with --literal)");
      const whole = flag("whole");
      let literal: string | undefined;
      if (flag("literal")) {
        literal = await readSecretInput();
        if (!literal) die("empty secret");
      }
      if (!whole && !literal) die("give --literal or --whole");
      console.log("Step 0: rotate or revoke this secret NOW. Redaction cleans up; the secret already reached Anthropic.");
      console.log(await (await import("./client.ts")).ctl(paths.sock, "redact", { id, whole, literal }));
      return;
    }
    default: {
      const { runOther } = await import("./commands.ts");
      return runOther(cmd, rest, { paths, codeDir });
    }
  }
}

function readAll(): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
  });
}

/** Read the secret without echoing it (a terminal) or from a pipe (all of stdin, one trailing newline removed). */
async function readSecretInput(): Promise<string> {
  if (!process.stdin.isTTY) return (await readAll()).replace(/\r?\n$/, "");
  process.stderr.write("Paste the secret, then Enter (nothing is shown; it is not logged and not stored anywhere): ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve) => {
    let s = "";
    const on = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          process.stdin.off("data", on);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        s = ch === "\u007f" || ch === "\b" ? s.slice(0, -1) : s + ch;
      }
    };
    process.stdin.on("data", on);
  });
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

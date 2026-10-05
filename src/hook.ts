import { connect } from "./client.ts";

const HOOK_TIMEOUT_MS = 20_000;

const out = (permissionDecision: "allow" | "deny" | "ask", why: string, updatedInput?: unknown) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: why, ...(updatedInput ? { updatedInput } : {}) } });

/**
 * PreToolUse hook for `claude`. It FAILS CLOSED: if the service cannot be reached, the
 * answer is not valid, or it takes too long, the tool call is denied. (The settings run it as
 * `... hook || exit 2`, so a crash or a missing node is a blocking error too: an exit code 1
 * would be non-blocking, and Claude Code would then fall back to its own allow rules.)
 */
export async function hookDecision(sock: string, stdinText: string): Promise<string> {
  let input: any;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return out("deny", "harness hook: unreadable input; denied");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const c = await connect(sock, { role: "mcp" });
    try {
      const text = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), HOOK_TIMEOUT_MS);
        c.on((m) => m.t === "result" && resolve(m.text));
        c.sock.on("close", () => reject(new Error("the service closed the connection")));
        // `cwd` is where Claude is: relative paths in Glob/Grep/Read resolve against it
        c.send({ t: "call", id: 1, name: "hook", args: { tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd } });
      });
      const d = JSON.parse(text);
      if (!["allow", "deny", "ask"].includes(d?.verdict)) throw new Error("bad verdict");
      return out(d.verdict, d.why ?? "harness policy", d.updatedInput);
    } finally {
      c.sock.destroy();
    }
  } catch (e: any) {
    return out("deny", `harness hook: ${e?.message ?? e}; denied`);
  } finally {
    clearTimeout(timer); // otherwise the process lingers after it has already answered
  }
}

export async function runHook(sock: string, stdinText: string): Promise<void> {
  process.stdout.write((await hookDecision(sock, stdinText)) + "\n");
  process.exit(0);
}


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "node:net";
import { z } from "zod";
import { TOOL_DESCRIPTIONS } from "./tools.ts";

/**
 * `optchat mcp`: the MCP server `claude` launches over stdio. It holds no state:
 * every call is relayed to the harness service over its Unix socket. This removes
 * the TCP port, the secret in the URL and the per-user port setting.
 */
export async function runMcpShim(sockPath: string): Promise<void> {
  const sock = net.connect(sockPath);
  await new Promise<void>((res, rej) => {
    sock.once("connect", res);
    sock.once("error", (e) => rej(new Error(`the OptChat service is not running (${sockPath}): ${e.message}`)));
  });
  sock.write(JSON.stringify({ t: "hello", role: "mcp" }) + "\n");

  const waiting = new Map<number, (r: { text: string; error?: boolean }) => void>();
  let nextId = 1;
  let buf = "";
  sock.setEncoding("utf8"); // decodes a character split across two chunks correctly
  sock.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.t === "result") waiting.get(m.id)?.(m), waiting.delete(m.id);
      } catch {
        // not ours
      }
    }
  });
  sock.on("close", () => {
    for (const w of waiting.values()) w({ text: "error: the OptChat service went away", error: true });
    waiting.clear();
    process.exit(1);
  });

  const call = (name: string, args: unknown) =>
    new Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>((resolve) => {
      const id = nextId++;
      waiting.set(id, (r) => resolve({ content: [{ type: "text", text: r.text }], isError: r.error }));
      sock.write(JSON.stringify({ t: "call", id, name, args }) + "\n");
    });

  const server = new McpServer({ name: "optchat", version: "0.1.0" });
  server.registerTool("zoom", { description: TOOL_DESCRIPTIONS.zoom, inputSchema: { id: z.number().int().min(0), n: z.number().int().min(1) } }, (a) => call("zoom", a));
  server.registerTool("date", { description: TOOL_DESCRIPTIONS.date, inputSchema: { id: z.number().int().min(0) } }, (a) => call("date", a));
  server.registerTool("search", { description: TOOL_DESCRIPTIONS.search, inputSchema: { text: z.string().min(1) } }, (a) => call("search", a));
  // The permission prompt tool. Claude Code calls it, not the model.
  server.registerTool(
    "approve",
    {
      description: "Permission prompt: asks the harness whether a tool call may run.",
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
    },
    (a) => call("approve", a),
  );
  await server.connect(new StdioServerTransport());
}

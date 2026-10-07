import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "./client.ts";
import { TOOL_DESCRIPTIONS } from "./tools.ts";

/**
 * `optchat mcp`: the MCP server `claude` launches over stdio. It holds no state:
 * every call is relayed to the harness service over its Unix socket. This removes
 * the TCP port, the secret in the URL and the per-user port setting.
 */
export async function runMcpShim(sockPath: string): Promise<void> {
  const conn = await connect(sockPath, { role: "mcp" });
  const waiting = new Map<number, (r: { text: string; error?: boolean }) => void>();
  let nextId = 1;
  conn.on((m) => {
    if (m.t === "result") {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  conn.sock.on("close", () => {
    // answer the calls still waiting, THEN go: exiting at once would leave them without any reply
    for (const w of waiting.values()) w({ text: "error: the OptChat service went away", error: true });
    waiting.clear();
    setTimeout(() => process.exit(1), 50);
  });

  const call = (name: string, args: unknown) =>
    new Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>((resolve) => {
      const id = nextId++;
      waiting.set(id, (r) => resolve({ content: [{ type: "text", text: r.text }], isError: r.error }));
      conn.send({ t: "call", id, name, args });
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

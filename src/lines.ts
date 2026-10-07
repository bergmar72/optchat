import type { Readable } from "node:stream";

/**
 * Newline-framed text from a stream: calls `onLine` for every non-empty complete line.
 * Decodes UTF-8 correctly across chunk boundaries, looks for the newline only in NEW data (a
 * multi-megabyte line is not rescanned per chunk), and drops a peer that sends more than `maxChars`
 * without a newline. This is the one reader for the service socket, its clients, the MCP shim and `claude`'s stdout.
 */
export function onLines(stream: Readable, onLine: (line: string) => void, maxChars = 64 << 20): void {
  stream.setEncoding("utf8");
  let buf = "";
  stream.on("data", (d: string) => {
    let from = buf.length;
    buf += d;
    if (buf.length > maxChars) return void stream.destroy();
    let nl: number;
    while ((nl = buf.indexOf("\n", from)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      from = 0;
      if (line.trim()) onLine(line);
    }
  });
}

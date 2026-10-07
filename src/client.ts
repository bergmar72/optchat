import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { onLines } from "./lines.ts";

export interface Conn {
  send(o: any): void;
  on(f: (m: any) => void): void;
  close(): void;
  sock: net.Socket;
}

/** attach, bridge and ctl clients show the service's token (secrets/client-token, mode 600); the `mcp` role needs none. */
function tokenFor(sockPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(path.dirname(path.dirname(sockPath)), "secrets", "client-token"), "utf8").trim();
  } catch {
    return undefined;
  }
}

export function connect(sockPath: string, hello: any): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const handlers: Array<(m: any) => void> = [];
    onLines(sock, (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      for (const h of handlers) h(m); // a throwing handler is the caller's bug: let it show
    });
    sock.once("error", (e) => reject(new Error(`cannot reach the OptChat service at ${sockPath}: ${e.message}`)));
    sock.once("connect", () => {
      const token = hello.role === "mcp" ? undefined : (hello.token ?? tokenFor(sockPath));
      sock.write(JSON.stringify({ t: "hello", ...hello, token }) + "\n");
      resolve({ send: (o) => sock.write(JSON.stringify(o) + "\n"), on: (f) => handlers.push(f), close: () => sock.end(), sock });
    });
  });
}

/** One control request, one answer. If the service drops the connection first, that is an ERROR, not silence. */
export async function ctl(sockPath: string, cmd: string, args: Record<string, unknown> = {}): Promise<string> {
  const c = await connect(sockPath, { role: "ctl" });
  return new Promise((resolve, reject) => {
    c.on((m) => {
      if (m.ev === "error") {
        c.sock.destroy();
        reject(new Error(m.text));
      } else if (m.t === "ctl_result") {
        c.close();
        m.ok ? resolve(m.text) : reject(new Error(m.text));
      }
    });
    c.sock.once("close", () => reject(new Error(`the service closed the connection before it answered "${cmd}"; the command may or may not have run (check \`optchat status\`)`)));
    c.sock.once("error", (e) => reject(e));
    c.send({ ...args, t: "ctl", id: 1, cmd }); // t, id and cmd last: an argument named "id" must not replace them
  });
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

/** `optchat attach`: plain output (no redraws), so the terminal's own scrollback works. */
export async function attach(sockPath: string, opts: { view?: boolean } = {}): Promise<void> {
  if (opts.view) console.log(await ctl(sockPath, "view"));
  const c = await connect(sockPath, { role: "attach" });
  let turning = false;
  let sent = 0;
  let busySeen = false;
  let lastConfirm: string | undefined;
  const pendingConfirms = new Set<string>();
  const interactive = process.stdin.isTTY === true;

  c.on((m) => {
    switch (m.ev) {
      case "error":
        console.log(`! ${m.text}`);
        break;
      case "hello":
        turning = m.turning;
        console.log(dim(`-- attached: ${m.messages} messages in the chat. /help for commands.`));
        break;
      case "entry":
        if (m.kind === "talk") console.log(`\n${m.text}\n`);
        else if (m.kind === "user" || m.kind === "fwd" || m.kind === "work" || m.kind === "file") console.log(dim(`[${m.kind}] ${m.text}`));
        else if (m.kind === "thought") console.log(dim(`(thinking) ${m.text}`));
        else console.log(dim(`· ${m.text.split("\n")[0].slice(0, 160)}`));
        break;
      case "status":
        turning = m.text !== "idle";
        if (m.text !== "idle") {
          busySeen = true;
          console.log(dim(`-- ${m.text}`));
        } else if (!interactive && sent && busySeen) process.exit(0); // piped input: the answer is in, we are done
        break;
      case "info":
        console.log(`! ${m.text}`);
        break;
      case "confirm":
        pendingConfirms.add(m.nonce);
        lastConfirm = m.nonce;
        console.log(`\n? CONFIRM [${m.nonce}] ${m.tool}: ${m.why}\n  answer: /y or /n  (or /y ${m.nonce})\n`);
        break;
      case "confirm_done":
        pendingConfirms.delete(m.nonce);
        if (lastConfirm === m.nonce) lastConfirm = [...pendingConfirms].pop();
        console.log(dim(`-- confirmation ${m.nonce}: ${m.allow ? "allowed" : "denied"} (${m.by})`));
        break;
    }
  });
  c.sock.on("close", () => {
    console.log(dim("-- the service closed the connection"));
    process.exit(0);
  });

  // A real terminal gets line editing and Ctrl-C handling; a pipe is read as it comes.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  // Lines that arrive together (a paste) are one message, not many.
  let batch: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    clearTimeout(timer);
    const text = batch.join("\n").trim();
    batch = [];
    if (text) {
      sent++;
      c.send({ t: "input", text });
    }
  };
  let asking = false;
  rl.on("line", (line) => {
    if (asking) {
      asking = false;
      if (/^y/i.test(line)) c.send({ t: "cancel" });
      return;
    }
    const cmd = /^\/(\w+)\s*(\S*)/.exec(line);
    if (cmd && !batch.length) {
      switch (cmd[1]) {
        case "y":
        case "n":
          c.send({ t: "answer", nonce: cmd[2] || lastConfirm, allow: cmd[1] === "y" });
          return;
        case "stop":
          c.send({ t: "cancel" });
          return;
        case "detach":
          process.exit(0);
          return;
        case "view":
          ctl(sockPath, "view").then(console.log, (e) => console.log(`! ${e.message}`));
          return;
        case "status":
          ctl(sockPath, "status").then(console.log, (e) => console.log(`! ${e.message}`));
          return;
        case "help":
          console.log("/stop cancel the turn · /y /n answer a confirmation · /view print the view · /status · /detach (or Ctrl-D)");
          return;
      }
    }
    batch.push(line);
    clearTimeout(timer);
    timer = setTimeout(flush, 40);
  });
  rl.on("SIGINT", () => {
    if (turning) {
      asking = true;
      console.log("stop the running turn? y/N (Ctrl-D detaches)");
    } else console.log(dim("(Ctrl-D to detach)"));
  });
  rl.on("close", () => {
    flush(); // a pipe ends before the 40 ms batch timer: send what is pending first
    if (!sent || interactive) return setTimeout(() => process.exit(0), 50); // let the socket write go out
    setTimeout(() => process.exit(0), 30 * 60_000).unref(); // piped: wait for the answer (exit on idle, above)
  });
}

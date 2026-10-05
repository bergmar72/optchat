import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureDir } from "./fsx.ts";

/** sun_path is 104 bytes on macOS and 108 on Linux; Node silently truncates a longer path. */
const MAX_SOCKET_PATH = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listenOn(server: net.Server, sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    server.listen(sock, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/** Is a live service behind this socket file? Only "refused" and "gone" mean stale; anything else is an error. */
function probe(sock: string): Promise<"alive" | "stale"> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    c.once("connect", () => (c.destroy(), resolve("alive")));
    c.once("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNREFUSED" || e.code === "ENOENT" ? resolve("stale") : reject(e)));
  });
}

/** A directory is an atomic mutex. A holder that died leaves it behind: older than 10 s counts as dead. */
function takeMutex(dir: string): boolean {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > 10_000) fs.rmdirSync(dir);
    } catch {
      // released meanwhile
    }
    return false;
  }
}

/**
 * Take the single-writer lock: bind the socket. Returns the listening server, or null if another
 * instance owns it (exit 0 then, so a service manager does not restart us in a loop).
 *
 * Binding is the atomic step. Only when the file is already there do we probe it, and the
 * probe-unlink-bind takeover of a stale socket runs under a mutex, so two starters cannot each
 * unlink the other's fresh socket. Connections that arrive before the service is ready are held
 * (paused) in `server.pending`.
 */
export async function claimLock(sockPath: string): Promise<(net.Server & { pending: net.Socket[] }) | null> {
  if (Buffer.byteLength(sockPath) > MAX_SOCKET_PATH)
    throw new Error(`the socket path is too long (${Buffer.byteLength(sockPath)} bytes, the limit is about 104): ${sockPath}\nUse a shorter OPTCHAT_HOME.`);
  ensureDir(path.dirname(sockPath), 0o700);
  const mutex = `${sockPath}.lock`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const server = net.createServer({ pauseOnConnect: true }) as net.Server & { pending: net.Socket[] };
    server.pending = [];
    server.on("connection", (c) => server.pending.push(c));
    try {
      await listenOn(server, sockPath);
      fs.chmodSync(sockPath, 0o600);
      return server;
    } catch (e: any) {
      if (e.code !== "EADDRINUSE") throw e;
    }
    if (!takeMutex(mutex)) {
      await sleep(50);
      continue;
    }
    try {
      if ((await probe(sockPath)) === "alive") return null;
      fs.rmSync(sockPath, { force: true }); // stale: the owner died
    } finally {
      try {
        fs.rmdirSync(mutex);
      } catch {
        // already gone
      }
    }
  }
  throw new Error(`could not take the lock on ${sockPath}`);
}

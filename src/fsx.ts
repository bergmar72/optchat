import fs from "node:fs";
import path from "node:path";

/** fsync a directory so a created or renamed entry survives a crash. */
export function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some filesystems refuse fsync on a directory; nothing more can be done.
  }
}

/** write(2) may write less than asked (disk full, quota, file-size limit) without an error: loop. */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error("short write");
    off += n;
  }
}

/**
 * Append `data` and fsync (Node uses F_FULLFSYNC on macOS). All or nothing:
 * - if the file does not end in a newline (a torn tail), the new data starts on its own line;
 * - if the write or fsync fails, the file is cut back to its old size and the error is thrown,
 *   so a failed append never leaves a fragment for the next one to glue onto.
 */
export function appendDurable(file: string, data: string): void {
  const isNew = !fs.existsSync(file);
  const fd = fs.openSync(file, "a+", 0o600);
  try {
    const before = fs.fstatSync(fd).size;
    let prefix = "";
    if (before > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, before - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    try {
      writeAll(fd, Buffer.from(prefix + data, "utf8"));
      fs.fsyncSync(fd);
    } catch (e) {
      try {
        fs.ftruncateSync(fd, before);
      } catch {
        // nothing more to do
      }
      throw e;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (isNew) fsyncDir(path.dirname(file));
}

/** All-or-nothing replace: temp file, fsync, size check, rename, fsync the directory. */
export function writeAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch {
    // no stale temp file
  }
  const buf = Buffer.from(data, "utf8");
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    writeAll(fd, buf);
    fs.fsyncSync(fd);
    if (fs.fstatSync(fd).size !== buf.length) throw new Error("short write");
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e; // the original file is untouched
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/**
 * Read a JSON-lines file, skipping lines that do not parse (a torn tail after a crash).
 * Returns the rows and how many lines were skipped. A missing file is empty.
 */
export function readJsonl<T = any>(file: string): { rows: T[]; bad: number } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { rows: [], bad: 0 };
  }
  const rows: T[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

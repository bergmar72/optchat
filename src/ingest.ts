import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { localDay } from "./fsx.ts";
import { decide } from "./policy.ts";
import type { Service } from "./service.ts";

const execP = promisify(execFile);

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
];
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log", ".tex", ".html", ".xml", ".yaml", ".yml"]);

/** Keeps dots (arXiv "2301.12345v2" stays whole); strips only a known file extension. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(pdf|txt|md|html?|json|csv|xml|ya?ml|tex|log|bin)$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40) || "file";

/** Text that goes into the permanent log as the harness's own words: one line, no control characters, bounded. */
export const oneLine = (s: string, max = 300) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).toWellFormed();

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Loopback, private, link-local and similar: a link must not reach the machine's own services. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || /^fe[89ab]/.test(v6);
}

async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`only http and https links are fetched (not ${u.protocol})`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error(`${host} is not a public address; not fetched`);
}

/** Download with a time limit, a size cap, and every redirect hop checked (`allowPrivate` is for tests only). */
export async function fetchCapped(url: string, max = MAX_FILE_BYTES, opts: { allowPrivate?: boolean } = {}): Promise<{ data: Buffer; type: string; finalUrl: string }> {
  let cur = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!opts.allowPrivate) await assertPublic(cur);
    const res = await fetch(cur, { redirect: "manual", headers: { "user-agent": "optchat" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      cur = new URL(res.headers.get("location")!, cur);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max) throw new Error(`too large (${len} bytes; the limit is ${max})`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > max) throw new Error(`too large (over ${max} bytes)`);
      chunks.push(Buffer.from(chunk));
    }
    return { data: Buffer.concat(chunks), type: res.headers.get("content-type") ?? "", finalUrl: cur.href };
  }
}

/** Binary data (NUL bytes in the first 8 KB) is never named or read as text. */
export const looksBinary = (b: Buffer) => b.subarray(0, 8192).includes(0);

export function pickExt(type: string, data: Buffer, urlPath: string): string {
  if (type.includes("pdf") || data.subarray(0, 5).toString() === "%PDF-") return ".pdf";
  if (type.includes("html")) return ".html";
  if (type.includes("json")) return ".json";
  const fromUrl = path.extname(urlPath).toLowerCase();
  if (looksBinary(data)) return fromUrl && !TEXT_EXT.has(fromUrl) ? fromUrl : ".bin";
  return type.startsWith("text/") || !fromUrl ? ".txt" : fromUrl;
}

/** A base name that is free for EVERY extension we may write (the file and its extracted .txt). Never overwrites. */
export function uniqueBase(dir: string, base: string, exts: string[]): string {
  let b = base;
  for (let n = 2; exts.some((e) => fs.existsSync(path.join(dir, `${b}${e}`))); n++) b = `${base}-${n}`;
  return b;
}

/** arXiv abs pages and DOIs lead to a PDF; other links are fetched as they are. */
function resolveUrl(u: string): string {
  const arx = /^https?:\/\/arxiv\.org\/abs\/(.+)$/.exec(u);
  if (arx) return `https://arxiv.org/pdf/${arx[1]}`;
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)(10\..+)$/.exec(u);
  if (doi) return `https://doi.org/${doi[1]}`;
  return u;
}

/**
 * Save a file or paper, extract its text, log ONE `file` record and start a turn.
 * The record and the agent's summary are normal log messages: the compactor
 * summarizes them like all others. The tree is never written to directly.
 * The record gives ABSOLUTE paths: the agent works elsewhere and cannot guess the root.
 */
export async function ingest(svc: Service, src: string, note?: string): Promise<string> {
  const isUrl = /^https?:\/\//i.test(src) || /^doi:/i.test(src);
  const day = localDay(new Date());
  let title: string;
  let ext: string;
  let data: Buffer;
  let source = "";
  try {
    if (isUrl) {
      source = src;
      const r = await fetchCapped(resolveUrl(src));
      data = r.data;
      const u = new URL(r.finalUrl);
      ext = pickExt(r.type, data, u.pathname);
      title = path.basename(u.pathname) || u.hostname;
    } else {
      const abs = fs.realpathSync(path.resolve(src)); // a symlink must not hide where the file really is
      // the same rules as for the agent's own reads: secret files and protected folders are never saved
      const d = decide("Read", { file_path: abs }, svc.policy);
      if (d.verdict === "deny") throw new Error(`refusing to save it: ${d.why}`);
      if (fs.statSync(abs).size > MAX_FILE_BYTES) throw new Error(`too large (the limit is ${MAX_FILE_BYTES} bytes)`);
      data = fs.readFileSync(abs);
      ext = path.extname(abs).toLowerCase() || (looksBinary(data) ? ".bin" : ".txt");
      title = path.basename(abs);
    }
  } catch (e: any) {
    // log the link and the error, so nothing is silently lost (one line: a name or message cannot add paragraphs)
    svc.submit({ kind: "file", byUser: true, text: `Could not save ${oneLine(src) || "file"}: ${oneLine(e.message)}` });
    if (note) svc.submit({ kind: "user", byUser: true, text: note });
    return `failed: ${oneLine(e.message)} (logged)`;
  }

  const dest = path.join(svc.paths.files, uniqueBase(svc.paths.files, `${day}-${slug(title)}`, [ext, ".txt"]) + ext);
  fs.writeFileSync(dest, data, { mode: 0o600, flag: "wx" });

  // text (never blocks the service: pdftotext runs as a child with a time limit)
  let txt = "";
  let textFile: string | undefined;
  try {
    if (ext === ".pdf") {
      textFile = dest.replace(/\.pdf$/, ".txt");
      await execP("pdftotext", ["-layout", dest, textFile], { timeout: 120_000 });
      txt = fs.readFileSync(textFile, "utf8");
    } else if (TEXT_EXT.has(ext) && !looksBinary(data)) {
      txt = data.toString("utf8");
      if (ext !== ".txt") {
        textFile = dest.replace(/\.[^.]+$/, ".txt");
        fs.writeFileSync(textFile, txt, { mode: 0o600, flag: "wx" });
      } else textFile = dest;
    }
  } catch {
    textFile = undefined; // pdftotext missing or failed: the original is still saved
  }

  // files with secrets are not kept
  if (SECRET_PATTERNS.some((r) => r.test(txt) || r.test(data.subarray(0, 200_000).toString("latin1")))) {
    for (const f of new Set([dest, textFile])) if (f) fs.rmSync(f, { force: true });
    svc.submit({ kind: "file", byUser: true, text: `Refused to save ${oneLine(title)}: it appears to contain a secret.${source ? ` Link: ${oneLine(source)}` : ""}` });
    return "refused: the file looks like it contains a secret (not saved)";
  }

  const lines = [`title: ${oneLine(title, 200)}`, `path: ${dest}`];
  if (textFile && textFile !== dest) lines.push(`text: ${textFile} (${txt.length} chars; read it in parts of at most 30000 characters)`);
  else if (textFile) lines.push(`(${txt.length} chars; read it in parts of at most 30000 characters)`);
  if (source) lines.push(`source: ${oneLine(source)}`);
  if (note) svc.submit({ kind: "user", byUser: true, text: note }); // the user's caption is their own words, logged as such
  svc.submit({ kind: "file", byUser: true, text: lines.join("\n") });
  return `saved ${dest}${textFile && textFile !== dest ? ` and ${textFile}` : ""}`;
}

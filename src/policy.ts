import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWN_TOOLS, ownToolName } from "./constants.ts";
import { caseFold } from "./platform.ts";

export type Decision = { verdict: "allow"; updatedInput?: any } | { verdict: "deny"; why: string } | { verdict: "ask"; why: string };

export interface PolicyConfig {
  /** Directories the agent may read and edit without asking. */
  work: string;
  /** Read-only without asking. */
  readOnly: string[];
  /** Never touched: the harness code, the chat, the secrets. Always added to, never replaced, by policy.json. */
  protect: string[];
  /** Other users' home folders, never read. */
  otherHomes: string[];
  /** Bash commands allowed without asking when the WHOLE command is plain safe tokens (see analyzeBash). */
  bashAllow: string[];
  /** For expanding "~". */
  home?: string;
  /** The directory `claude` runs in (relative paths in file tools resolve against it). */
  cwd?: string;
}

export class PolicyError extends Error {}

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const OWN_TOOL_NAMES = new Set(OWN_TOOLS.map(ownToolName));

/** Strings longer than this are not examined: the answer is "ask". Keeps every check linear and cheap. */
const MAX_LEN = 4096;

// ---------------------------------------------------------------- names

/** Files that are never read or edited. Checked on the BASENAME only (linear, no backtracking). */
const DENY_NAME = [
  /^\.env$/i,
  /^\.env[.-](?!example$|sample$|template$|dist$|defaults?$)/i,
  /\.env$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.(key|p12|pfx|jks|keystore|ppk)$/i,
  /^\.(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials)$/i,
  /^credentials(\.json)?$/i,
  /^service-account.*\.json$/i,
];
/** Names that may well be secrets: the user decides. */
const ASK_NAME = [/\.pem$/i, /secret/i, /token/i, /credential/i, /password/i, /^\.envrc$/i];

export function nameVerdict(p: string): "deny" | "ask" | null {
  const b = path.basename(p);
  if (b.length > 255) return "ask";
  if (DENY_NAME.some((r) => r.test(b))) return "deny";
  if (ASK_NAME.some((r) => r.test(b))) return "ask";
  return null;
}

/** Writing here can plant code that runs later with the user's rights (git hooks and config, editor tasks, shell rc files). */
const DANGEROUS_SEGMENT = new Set([".git", ".vscode", ".idea", ".claude", ".husky"]);
const DANGEROUS_FILE = new Set([".gitconfig", ".gitmodules", ".gitattributes", ".mcp.json", ".ripgreprc", ".envrc", ".bashrc", ".zshrc", ".profile", ".bash_profile", ".bash_login", ".zprofile", ".zshenv", ".inputrc"]);
const dangerousWrite = (p: string): boolean => p.split("/").some((s) => DANGEROUS_SEGMENT.has(s)) || DANGEROUS_FILE.has(path.basename(p));

// ---------------------------------------------------------------- paths

/**
 * Resolve every symlink on the way, component by component (lstat), the way the kernel does:
 * dangling links are followed to where they would create a file, and ".." is applied to the
 * REAL parent. `p` must be absolute. Linear in the number of components.
 */
export function real(p: string, hops = 0): string {
  const parts = p.split("/").filter((x) => x !== "" && x !== ".");
  let cur = "/";
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = cur === "/" ? `/${part}` : `${cur}/${part}`;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      return path.resolve(cur, ...parts.slice(k)); // does not exist: nothing below it can be a link
    }
    if (st.isSymbolicLink()) {
      if (hops >= 40) return path.resolve(cur, ...parts.slice(k)); // a loop
      let target: string;
      try {
        target = fs.readlinkSync(next);
      } catch {
        return next;
      }
      const base = path.isAbsolute(target) ? target : `${cur}/${target}`;
      return real(`${base}/${parts.slice(k + 1).join("/")}`, hops + 1);
    }
    cur = next;
  }
  return cur;
}

/** The one rule for "never touch this": why a RESOLVED path is off limits, or undefined. */
function denyReason(p: string, cfg: PolicyConfig): string | undefined {
  if (nameVerdict(p) === "deny") return `${path.basename(p)} looks like a secret file`;
  for (const d of cfg.protect) if (inside(p, d)) return `${p} is protected`;
  for (const d of cfg.otherHomes) if (inside(p, d)) return `${p} belongs to another user`;
  return undefined;
}

/** `~` and relative paths as Claude Code itself reads them: against the home folder and against ITS working directory. */
export function expandPath(raw: string, cfg: PolicyConfig): string {
  const home = cfg.home ?? os.homedir();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
  if (path.isAbsolute(raw)) return raw;
  return `${cfg.cwd ?? process.cwd()}/${raw}`;
}

const insideRaw = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
/** Both are resolved; compared case-folded where the file system is case-insensitive. */
const inside = (p: string, dir: string): boolean => {
  const a = caseFold(p);
  return insideRaw(a, caseFold(dir)) || insideRaw(a, caseFold(real(dir)));
};

// ---------------------------------------------------------------- display

/** What the user is asked about: the WHOLE thing, control characters made visible. */
export function show(s: string, max = 2000): string {
  const e = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return e.length > max ? `${e.slice(0, max)} [${e.length - max} more chars]` : e;
}

// ---------------------------------------------------------------- bash

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the command text mention `dir` (a boundary-aware match: /opt/code is not /opt/code-notes)? */
function mentions(cmd: string, dir: string, home: string): boolean {
  const forms = new Set([dir, real(dir)]);
  if (insideRaw(dir, home) && dir !== home) {
    const rel = dir.slice(home.length + 1);
    for (const h of ["~", "$HOME", "${HOME}"]) forms.add(`${h}/${rel}`);
  }
  return [...forms].some((f) => new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(f)}(?![A-Za-z0-9_.-])`).test(cmd));
}

const SUDO = /(^|[;&|(`]|\$\()\s*(\S*\/)?(sudo|doas)(\s|$)/;
/** Only plain tokens: letters, digits and a few path characters. Quotes, braces, globs, ~, $ and the like are not in it. */
const SAFE_TOKEN = /^[A-Za-z0-9_.\/@:=+,%-]+$/;
// git flags that only read. Anything else starting with "-" (--output, --ext-diff, --textconv, -O...) asks.
const GIT_SAFE_FLAG = /^(-[a-zA-Z]|-\d+|--(short|porcelain|branch|stat|name-only|name-status|oneline|cached|staged|no-color|color|graph|decorate|shortstat|numstat|summary|patch|all|abbrev-commit))$/;

/**
 * Auto-allow a Bash command only when it is a bare, allow-listed program with plain arguments, and
 * every path argument is absolute and inside the work folder. Anything else (pipes, quotes, braces,
 * globs, relative paths: the shell's working directory is unknown) asks, with the full command shown.
 */
function bashAutoAllowed(cmd: string, cfg: PolicyConfig): { ok: boolean; deny?: string } {
  if (cmd !== cmd.trim() || /[^ -~]/.test(cmd) || cmd.includes("  ")) return { ok: false };
  const entry = cfg.bashAllow.find((x) => cmd === x || cmd.startsWith(x + " "));
  if (!entry) return { ok: false };
  const tokens = cmd.split(" ");
  if (!tokens.every((t) => SAFE_TOKEN.test(t))) return { ok: false };
  const isGit = entry.startsWith("git ");
  for (const t of tokens.slice(entry.split(" ").length)) {
    if (t.startsWith("-")) {
      if (isGit && !GIT_SAFE_FLAG.test(t)) return { ok: false };
      continue;
    }
    if (/^\d+$/.test(t)) continue;
    if (!t.startsWith("/")) return { ok: false }; // relative or bare name: where it points is unknown
    const r = real(t);
    const dr = denyReason(r, cfg);
    if (dr) return { ok: false, deny: dr };
    if (nameVerdict(r) === "ask" || !inside(r, cfg.work)) return { ok: false };
  }
  return { ok: true };
}

function decideBash(cmd: string, cfg: PolicyConfig): Decision {
  const home = cfg.home ?? os.homedir();
  if (cmd.length > MAX_LEN) return { verdict: "ask", why: `a very long command (${cmd.length} chars): ${show(cmd, 400)}` };
  if (SUDO.test(cmd.replace(/["'\\]/g, ""))) return { verdict: "deny", why: "sudo is not allowed" };
  for (const d of [...cfg.protect, ...cfg.otherHomes]) if (mentions(cmd, d, home)) return { verdict: "deny", why: `touches ${d}` };
  const auto = bashAutoAllowed(cmd, cfg);
  if (auto.deny) return { verdict: "deny", why: auto.deny };
  if (auto.ok) return { verdict: "allow" };
  return { verdict: "ask", why: `run: ${show(cmd)}` };
}

// ---------------------------------------------------------------- file tools

/** Searching with --hidden must not return the lines of secret files: add exclusions to every Grep. */
const GREP_EXCLUDE = ["!**/.env", "!**/.env.*", "!**/*.env", "!**/id_rsa", "!**/id_ed25519", "!**/id_ecdsa", "!**/id_dsa", "!**/*.key", "!**/*.p12", "!**/*.pfx", "!**/.netrc", "!**/.npmrc", "!**/.pypirc", "!**/.pgpass", "!**/.htpasswd", "!**/.git-credentials", "!**/credentials*"];

const hasDotDot = (s: string) => s.split(/[\\/]/).includes("..");

function decideFile(tool: string, input: any, cfg: PolicyConfig): Decision {
  const write = WRITE_TOOLS.has(tool);
  const raws: string[] = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input?.[k] === "string") raws.push(input[k]);
  const isSearch = tool === "Glob" || tool === "Grep";

  if (tool === "Glob" && typeof input?.pattern === "string") {
    const pat: string = input.pattern;
    if (pat.length > MAX_LEN) return { verdict: "ask", why: `${tool}: a very long pattern` };
    if (hasDotDot(pat)) return { verdict: "ask", why: `${tool} pattern with "..": ${show(pat)}` };
    if (pat.startsWith("/") || pat.startsWith("~")) {
      const lead = pat.split(/[*?[{]/)[0];
      raws.push(lead.endsWith("/") ? lead : path.dirname(lead) || "/"); // the folder an absolute pattern names
    }
  }
  if (tool === "Grep" && typeof input?.glob === "string") {
    for (const piece of input.glob.split(/[\s,]+/).filter(Boolean))
      if (piece.length > MAX_LEN || hasDotDot(piece) || piece.startsWith("/") || piece.startsWith("~")) return { verdict: "ask", why: `Grep glob names another place: ${show(input.glob)}` };
  }
  if (!raws.length) {
    if (isSearch) return { verdict: "deny", why: `${tool} needs an explicit path inside ${cfg.work}` }; // it would search Claude's own working directory
    return { verdict: "ask", why: `${tool} without a path` };
  }

  let wantAsk: string | undefined;
  for (const raw of raws) {
    if (raw.length > MAX_LEN) return { verdict: "ask", why: `${tool}: a very long path` };
    const p = real(expandPath(raw, cfg));
    const dr = denyReason(p, cfg);
    if (dr) return { verdict: "deny", why: dr };
    const nv = nameVerdict(p);
    // a folder that CONTAINS protected places (a search of the whole home folder, of /): no
    if (isSearch) for (const d of [...cfg.protect, ...cfg.otherHomes]) if (inside(real(d), p) && real(d) !== p) return { verdict: "deny", why: `${p} contains the protected folder ${d}` };
    if (nv === "ask") wantAsk ??= `${tool} ${show(p)}: the name looks like it holds a secret`;
    if (write && dangerousWrite(p)) wantAsk ??= `${tool} ${show(p)}: files like this can plant code that runs later`;
    const ok = inside(p, cfg.work) || (!write && cfg.readOnly.some((d) => inside(p, d)));
    if (!ok) wantAsk ??= `${tool} ${show(p)}`;
  }
  if (wantAsk) return { verdict: "ask", why: wantAsk };
  if (tool === "Grep") {
    const glob = [typeof input.glob === "string" ? input.glob : "", ...GREP_EXCLUDE].filter(Boolean).join(" ");
    return { verdict: "allow", updatedInput: { ...input, glob } };
  }
  return { verdict: "allow" };
}

// ---------------------------------------------------------------- entry points

/**
 * The harness decides, not the model. Allowed without asking: our own tools, reading/editing inside
 * ~/work, and a few bare read-only commands. Hard deny: sudo, the harness code, the chat and secrets,
 * other users' homes, secret files. Everything else asks, with the whole request shown.
 */
export function decide(tool: string, input: any, cfg: PolicyConfig): Decision {
  if (OWN_TOOL_NAMES.has(tool)) return { verdict: "allow" };
  if (tool === "Bash") return decideBash(String(input?.command ?? ""), cfg);
  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) return decideFile(tool, input, cfg);
  return { verdict: "ask", why: `${show(tool, 80)} ${show(JSON.stringify(input ?? {}))}` };
}

/** Other users' homes: siblings of ours, but only under a real homes folder (not "/" for /root). */
export function otherHomesOf(me: string): string[] {
  const base = path.dirname(me);
  if (base !== "/home" && base !== "/Users") return [];
  try {
    return fs
      .readdirSync(base)
      .filter((d) => d !== "Shared" && d !== "Guest" && !d.startsWith("."))
      .map((d) => path.join(base, d))
      .filter((d) => d !== me && fs.existsSync(d));
  } catch {
    return [];
  }
}

export function defaultPolicy(home: string, codeDir: string, others: string[], root = path.join(home, "optchat")): PolicyConfig {
  return {
    work: path.join(home, "work"),
    readOnly: [path.join(root, "files")],
    protect: [codeDir, path.join(root, "chat"), path.join(root, "secrets"), path.join(root, "run"), path.join(root, "policy.json"), path.join(home, ".claude"), path.join(home, ".ssh")],
    otherHomes: others,
    bashAllow: ["ls", "pwd"],
    home,
    cwd: path.join(root, "run"),
  };
}

const STRING_LISTS = ["readOnly", "protect", "otherHomes", "bashAllow"] as const;

/**
 * Read policy.json. A missing file means the defaults. A file that is there but wrong is an ERROR (the
 * service does not start): silently falling back to the defaults would drop the rules the user wrote.
 * `protect` and `otherHomes` can only be added to.
 */
export function loadPolicy(file: string, base: PolicyConfig): PolicyConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return base;
  }
  let j: any;
  try {
    j = JSON.parse(text);
  } catch (e: any) {
    throw new PolicyError(`${file} is not valid JSON (${e.message}). Fix it or remove it.`);
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new PolicyError(`${file} must be a JSON object.`);
  const out: PolicyConfig = { ...base };
  if (j.work !== undefined) {
    if (typeof j.work !== "string" || !path.isAbsolute(j.work)) throw new PolicyError(`${file}: "work" must be an absolute path.`);
    out.work = j.work;
  }
  for (const k of STRING_LISTS) {
    if (j[k] === undefined) continue;
    if (!Array.isArray(j[k]) || !j[k].every((x: unknown) => typeof x === "string")) throw new PolicyError(`${file}: "${k}" must be a list of strings.`);
    out[k] = k === "protect" || k === "otherHomes" ? [...new Set([...base[k], ...j[k]])] : j[k];
  }
  return out;
}

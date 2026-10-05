import fs from "node:fs";
import path from "node:path";
import type { Memory } from "./memory.ts";
import { flat, span } from "./types.ts";

export const TOOL_DESCRIPTIONS = {
  zoom: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
  date: "The date and time of message id.",
  search:
    "Search the raw log, saved files and the link index for text. Returns matching message ids (with kind, date and a snippet) so you can zoom to them. Use it when zooming cannot find a fact.",
};

const pad = (n: number) => String(n).padStart(2, "0");
export function localStamp(iso: string): string {
  const d = new Date(iso);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

export class Tools {
  constructor(
    private mem: Memory,
    private filesDir: string,
    private linksFile: string,
  ) {}

  zoom(id: number, n: number): string {
    const T = this.mem.store.total;
    const ok = Number.isInteger(id) && Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0 && id >= 0 && id % n === 0 && id + n <= T;
    if (!ok) return `No line ${id}+${n}.`;
    if (n === 1) {
      const m = this.mem.store.msgs[id];
      return `${id}+0|${m.kind}: ${m.text}`;
    }
    const l = Math.log2(n);
    const i = id / n;
    if (!this.mem.store.hasNode(l, i)) return `No line ${id}+${n}.`;
    return [0, 1]
      .map((k) => {
        const c = this.mem.store.node(l - 1, 2 * i + k);
        if (!c) return `${id + k * (n / 2)}+${n / 2}|(not summarized yet: zoom it)`;
        return `${(2 * i + k) * span(l - 1)}+${span(l - 1)}|${c.kinds}|${flat(c.text)}`;
      })
      .join("\n");
  }

  date(id: number): string {
    const m = this.mem.store.msgs[id];
    return m ? localStamp(m.date) : `No message ${id}.`;
  }

  search(query: string, maxChars = 8000): string {
    const q = query.trim().toLowerCase();
    if (!q) return "Empty query.";
    const words = q.split(/\s+/);
    const phrase = (s: string) => s.toLowerCase().includes(q);
    const all = (s: string) => {
      const t = s.toLowerCase();
      return words.every((w) => t.includes(w));
    };
    // The text near the match. `toLowerCase` can change the length (İ), so an index into the lowered copy is
    // only trusted when the lengths agree; and the cut is made BEFORE flattening, so a huge line costs nothing.
    const snippet = (text: string): string => {
      const low = text.toLowerCase();
      let at = low.length === text.length ? low.indexOf(q) : -1;
      if (at < 0 && low.length === text.length) at = Math.max(0, low.indexOf(words[0]));
      const from = Math.max(0, at - 80);
      return flat(text.slice(from, from + 300)).trim().slice(0, 220);
    };
    const matches = (s: string) => phrase(s) || (words.length > 1 && all(s));
    const msgs = this.mem.store.msgs;
    const scan = (match: (s: string) => boolean) => {
      const hits: number[] = [];
      for (let i = msgs.length - 1; i >= 0; i--) if (match(msgs[i].text)) hits.push(i);
      return hits;
    };
    let hits = scan(phrase);
    if (!hits.length && words.length > 1) hits = scan(all);
    const out: string[] = [];
    for (const i of hits.slice(0, 30)) out.push(`${i}|${msgs[i].kind}|${localStamp(msgs[i].date)}|${snippet(msgs[i].text)}`);
    if (hits.length > 30) out.push(`(${hits.length - 30} more messages match; refine the query)`);

    // saved files (the extracted .txt). One unreadable file (a dangling link, a directory, no permission)
    // must not end the search of the others, and the cap stops the reading.
    const fileHits: string[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.filesDir);
    } catch {
      // no files directory yet
    }
    for (const f of names) {
      if (fileHits.length >= 15) break;
      if (!f.endsWith(".txt")) continue;
      try {
        const lines = fs.readFileSync(path.join(this.filesDir, f), "utf8").split("\n");
        for (let n = 0; n < lines.length && fileHits.length < 15; n++)
          if (lines[n].length < 200_000 && matches(lines[n])) fileHits.push(`file ${path.join(this.filesDir, f)}:${n + 1}|${snippet(lines[n])}`);
      } catch {
        // skip this one
      }
    }
    out.push(...fileHits);

    // link index: a torn or odd line is skipped, not fatal
    const linkHits: string[] = [];
    let linkText = "";
    try {
      linkText = fs.readFileSync(this.linksFile, "utf8");
    } catch {
      // no link index yet
    }
    for (const line of linkText.split("\n")) {
      if (linkHits.length >= 15) break;
      if (!line) continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      // match the fields, not the JSON text: the query "url" or "id" must not match every row
      if (matches(`${r.url ?? ""} ${r.context ?? ""}`)) linkHits.push(`link msg ${r.id} ${r.date}|${r.url}|${snippet(String(r.context ?? ""))}`);
    }
    out.push(...linkHits);

    if (!out.length) return `No match for "${query}".`;
    let text = out.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars) + "\n(output cut)";
    return text.toWellFormed();
  }
}

export const KINDS = ["user", "talk", "step", "work", "file", "note", "fwd"] as const;
export type Kind = (typeof KINDS)[number];

// One letter per kind, in a fixed order. Shown in the `k` column of the view.
export const LETTERS = "utswfnx";
export const KIND_LETTER: Record<Kind, string> = {
  user: "u",
  talk: "t",
  step: "s",
  work: "w",
  file: "f",
  note: "n",
  fwd: "x",
};

export interface Msg {
  i: number;
  kind: Kind;
  text: string;
  size: number; // bytes of `kind + ": " + text`
  date: string; // ISO
}

export interface Node {
  l: number;
  i: number;
  text: string;
  size: number;
  kinds: string; // letters, fixed order: union of the kinds of the covered messages
}

export interface Part {
  l: number;
  i: number;
}

export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
/** Newlines (and the blanks around them) become single spaces. Linear: no regex that backtracks on long whitespace. */
export const flat = (s: string): string => (s.includes("\n") ? s.split("\n").map((l) => l.trim()).filter(Boolean).join(" ") : s);
export const key = (l: number, i: number): string => `${l}:${i}`;
export const span = (l: number): number => 2 ** l;
export const startOf = (l: number, i: number): number => i * 2 ** l;

export function unionKinds(a: string, b: string): string {
  let out = "";
  for (const c of "utswfnx") if (a.includes(c) || b.includes(c)) out += c;
  return out;
}

/** Cut `s` to at most `max` bytes without splitting a UTF-8 character. */
export function cutBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let out = buf.subarray(0, max).toString("utf8");
  if (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

/** Keep the head and tail of a long string, with a note of what was cut. */
export function capHeadTail(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 80) / 2);
  const cut = s.length - 2 * keep;
  // a cut inside a surrogate pair would leave a lone surrogate, which the API may reject
  return `${s.slice(0, keep)}\n[... ${cut} chars cut ...]\n${s.slice(s.length - keep)}`.toWellFormed();
}

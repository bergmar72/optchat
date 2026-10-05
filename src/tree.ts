import { NODE } from "./constants.ts";
import { bytes, KIND_LETTER, type Msg, type Node, unionKinds } from "./types.ts";

/** The text a level-0 node stands for. */
export const leafLine = (m: Msg): string => `${m.kind}: ${m.text}`;

/** A short message IS its node: no model call. */
export function freeLeaf(m: Msg): Node | null {
  if (m.size > NODE) return null; // size is the byte length of the line: no need to build the string to know
  const text = leafLine(m);
  const size = bytes(text);
  if (size > NODE) return null;
  return { l: 0, i: m.i, text, size, kinds: KIND_LETTER[m.kind] };
}

/** Two children that fit together in NODE bytes ARE the parent. */
export function freeMerge(l: number, i: number, a: Node, b: Node): Node | null {
  const text = `${a.text}\n${b.text}`;
  const size = bytes(text);
  if (size > NODE) return null;
  return { l, i, text, size, kinds: unionKinds(a.kinds, b.kinds) };
}

export function mergeNode(l: number, i: number, text: string, a: Node, b: Node): Node {
  return { l, i, text, size: bytes(text), kinds: unionKinds(a.kinds, b.kinds) };
}

export function leafNode(m: Msg, text: string): Node {
  return { l: 0, i: m.i, text, size: bytes(text), kinds: KIND_LETTER[m.kind] };
}

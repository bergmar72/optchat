import fs from "node:fs";
import { appendDurable } from "./fsx.ts";

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

export interface LinkRow {
  date: string;
  id: number;
  url: string;
  context: string;
}

/** The rows for one message: one per URL, with the words around it. No model. */
export function linkRows(id: number, date: string, text: string): LinkRow[] {
  const rows: LinkRow[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - 80), at) + " " + text.slice(at + m[0].length, at + m[0].length + 80);
    rows.push({ date, id, url, context: around.replace(/\s+/g, " ").trim().toWellFormed() });
  }
  return rows;
}

/** Append the rows of one message in ONE write (one fsync, however many URLs). */
export function indexLinks(file: string, id: number, date: string, text: string): number {
  const rows = linkRows(id, date, text);
  if (rows.length) appendDurable(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows.length;
}


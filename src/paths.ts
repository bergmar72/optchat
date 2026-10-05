import path from "node:path";

export interface Paths {
  root: string;
  chat: string;
  files: string;
  run: string;
  secrets: string;
  sock: string;
  links: string;
  redactions: string;
  agents: string;
  policy: string;
  inbox: string;
  token: string;
}

export function pathsFor(root: string): Paths {
  return {
    root,
    chat: path.join(root, "chat"),
    files: path.join(root, "files"),
    run: path.join(root, "run"),
    secrets: path.join(root, "secrets"),
    sock: path.join(root, "run", "sock"),
    links: path.join(root, "links.jsonl"),
    redactions: path.join(root, "chat", "redactions.jsonl"),
    agents: path.join(root, "AGENTS.md"),
    policy: path.join(root, "policy.json"),
    inbox: path.join(root, "run", "inbox.jsonl"),
    token: path.join(root, "secrets", "client-token"),
  };
}


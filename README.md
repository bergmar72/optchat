# OptChat

One endless chat with an AI agent that remembers all of it. The log keeps every message word for word;
a cheap model compresses it into a binary tree of one-line summaries; each turn the agent starts fresh
with a ~128 KB view of the whole history and zooms into lines when it needs detail.

Design: [optchat.md](optchat.md) (base spec), the setup spec PDF, and [PLAN.md](PLAN.md) (decisions, platforms, status).
Measured behaviour of the Claude Code CLI: [docs/cli-findings.md](docs/cli-findings.md).

## Quick start (one user, Linux or macOS)

```bash
npm ci
node bin/optchat.mjs doctor                   # what is installed, what is missing
mkdir -p ~/optchat/secrets && chmod 700 ~/optchat ~/optchat/secrets
echo "$ANTHROPIC_API_KEY" > ~/optchat/secrets/api && chmod 600 ~/optchat/secrets/api   # compactor only
claude                                        # log in with your subscription (the master runs on it)
printf 'Who I am, my folders, how I want work done.\n' > ~/optchat/AGENTS.md
node bin/optchat.mjs serve &                  # or: optchat install-service <user>
node bin/optchat.mjs attach                   # plain terminal client; /help for commands
```

Clients (`attach`, `status`, `redact`, ...) read `secrets/client-token` (made at first start) to talk to the service.

Commands: `attach`, `status`, `view`, `stop`, `file <path|url>`, `redact <id> --literal|--whole`,
`browse`, `import`, `backup`, `restore-test`, `install-service <user>`, `doctor`.
`serve --dev-model` replaces the compactor with truncation: for testing only, never on a real chat.

## Layout

```
~/optchat/chat/main|tree/   the log and the tree (append-only; git commit per turn, no remote)
~/optchat/files/            saved papers and files, plus extracted .txt
~/optchat/run/              socket, system prompt, turn journal, usage.jsonl
~/optchat/secrets/          api, oauth, restic.env (mode 600; never backed up)
~/work/                     where the agent works (policy.json can change it)
```

## Tests

`npm test` (unit, no network, ~5 s) · `node test/e2e.mjs` and `node test/probe-cache.mjs` (real `claude`, a few requests each: saved papers, confirmations, Grep exclusions, cross-turn caching).
For the git-history part of redaction, put `git-filter-repo` on PATH before `npm test`.

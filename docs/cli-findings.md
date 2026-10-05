# Phase 0: what the Claude Code CLI does (measured)

Tested on Linux x64, `claude` 2.1.285, Node 22, 2026-10-05, on a subscription login.
Probes: `test/e2e.mjs`, `test/probe-cache.mjs`. Re-run both after every `claude` update
(the service sets `DISABLE_AUTOUPDATER=1`, so updates are deliberate).

| # | Question | Result |
|---|---|---|
| S1 | Are stdin messages sent mid-run delivered between tool calls? | **Yes.** A message written during a `sleep 12` tool call was delivered right after that call's result, and the model used it. `--replay-user-messages` echoes it as `{type:"user", isReplay:true, uuid:<ours>}` at the moment it is consumed, so the harness logs it then (and re-queues anything never echoed). The first message is echoed too; it is ignored because its uuid is not in the mid-run map. |
| S2a | Does `cache_control` on user content blocks reach the API? | **Yes, but only ONE view mark fits.** Claude Code places 3 of the 4 allowed breakpoints itself (an extra one gives `400 A maximum of 4 blocks with cache_control`). The mark must carry `ttl:"1h"`: a plain 5-minute mark before Claude Code's 1h marks gives `400 a ttl='1h' cache_control block must not come after a ttl='5m'`. |
| S2b | Is the system prompt + tools prefix stable? | **Yes.** `--system-prompt-file` replaces the default prompt; `cache_read` was 11,740 tokens (tools + system) on every turn of every run, across different working directories and data folders. The 11.7k is Claude Code's built-in tool definitions; the master now gets `--tools Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch` (see below). |
| S2c | Cache lifetime on the subscription? | **1 hour.** Claude Code writes `ephemeral_1h` entries by itself. (Base spec §8 advises against 1h entries; that advice is for the direct API. Here it is not our choice.) |
| S2 end-to-end | Does the view get cache hits across turns? | **Yes.** View 127,734 bytes (700 messages). Turn 1 wrote 50,580 tokens. Turn 2, 5 s later: `cache_read` 31,600 (11,740 tools+system + ~19,860 view tokens up to the mark at 50,000 chars), `cache_write` 30,752 (the rest). Within a turn, step k reads exactly what step k-1 wrote (14,862 = 11,740 + 3,122). So D4 holds: stay on the subscription. The mark is now 64,000 chars; tune it from `run/usage.jsonl` in the pilot. |
| S3 | What does the CLI add to the prompt? | Nothing volatile was visible in the cache behaviour. `--setting-sources ""` and `--strict-mcp-config` keep user/project settings and other MCP servers out. Run in `~/optchat/run`, which is not a git repo. `--exclude-dynamic-system-prompt-sections` is ignored with a custom prompt (documented), so it is not needed. |
| S4 | Subscription login from a background service? | **Partly verified.** With an environment of only `HOME PATH USER LANG`, `claude -p` answers on the subscription: the init event shows `apiKeySource: "none"`. NOT yet verified: after a cold reboot with the user never logged in (needs the real host; see PLAN.md, Phase 0). `CLAUDE_CODE_OAUTH_TOKEN` is wired but untested here. |
| S5 | `--permission-prompt-tool` | **Works.** Claude Code calls the MCP tool with `{tool_name, input, tool_use_id}` and accepts a text result of `{"behavior":"allow","updatedInput":{...}}` or `{"behavior":"deny","message":"..."}`. **But** Claude Code's own "safe command" rules (e.g. `echo`) allow some calls without ever consulting it. So every call also goes through a **PreToolUse hook** (`--settings run/settings.json`) that asks the same policy first: `allow`/`deny` there are final, `ask` falls through to the prompt tool, which asks the user. |
| S6 | Stream shapes | `system/init` (has `apiKeySource`, `model`, `tools`), one `assistant` event per content block (`text`, `thinking`, `tool_use`), `user` events carrying `tool_result` blocks (not replays), `user` + `isReplay:true` for echoes, `result` (has `is_error`, `terminal_reason`, `usage`), plus `rate_limit_event`, `system/task_*` and `command_lifecycle` noise that is ignored. `--no-session-persistence` works. `--autocompact <auto|tokens>` exists; not needed because every turn starts fresh. |

## Added in the review round (measured live, 2026-10-05)

| Question | Result |
|---|---|
| Does Claude Code honour `updatedInput` from a PreToolUse hook? | **Yes.** The hook adds `!**/.env` and similar globs to every `Grep`. With a `.env` and a `readme.txt` that both contain the search string, the real `Grep` returned "Found 1 file" (the readme). Claude's Grep searches hidden files, so without this the `.env` line would come back. |
| Cached prefix with the fixed tool list | `--tools Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch` shrinks tools + system from 11,740 to **6,458 tokens**. |
| Cross-turn cache with the mark at 64,000 chars | Turn 2, 4 s after turn 1, view 127,798 bytes: `cache_read` 31,622 (6,458 prefix + ~25,200 view tokens), `cache_write` 23,443. (At 50,000 chars it was ~19,900 view tokens.) |
| Hook start-up cost | 109 ms wall / 0.12 CPU-s (was ~200 ms / 0.45 CPU-s) after the CLI stopped importing both SDKs for `hook` and `mcp`. The hook matcher now lists only the built-in tools, so our own `zoom`/`date`/`search` start no hook process at all. |
| Relative `Glob`/`Grep` `path` and `cwd` | The PreToolUse payload carries `cwd`; `Read`/`Write` `file_path` arrives absolute, `Glob`/`Grep` `path` arrives raw (`".."`, `"~/x"`). The hook forwards `cwd` and the policy resolves against it. |

## Still open (needs the real host)

- `... hook || exit 2` making a crashed hook a BLOCKING error is taken from the Claude Code docs; not forced in a live run.

- S4 after a cold reboot (macOS: FileVault unlock by the admin; Linux: LUKS unlock), user never logged in.
- `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and whether the current terms allow it for this use (setup spec §5).
- How subscription usage limits weigh cache writes: measure over the 2-week pilot.
- The compactor against the live API: see "Not verified" in PLAN.md section 0.

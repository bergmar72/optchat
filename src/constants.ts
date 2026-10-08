// Sizes are UTF-8 bytes (or characters, for cache marks), never tokens.
export const NODE = 512; // target size of one summary line
export const VIEW = 128_000; // the view is merged down from here ...
export const VIEW_LOW = 64_000; // ... to here, in one batch (the sawtooth)
export const JOBS = 8; // compactor calls at once
export const TRIES = 5; // attempts per node to get under NODE
export const RETRY_MS = 10_000; // wait before retrying a failed node
export const CAP = 30_000; // max chars of one tool result (head + tail kept)
export const STEP_INPUT_CAP = 4_000; // max chars of a logged tool-call input
export const PLACEHOLDER = "(not summarized yet: zoom it)";

// Through `claude -p` only ONE view mark fits: Claude Code uses 3 of the 4
// allowed breakpoints itself (docs/cli-findings.md, S2a).
// Measured: with one mark the next turn re-reads the view up to it (docs/cli-findings.md).
// 64k is below the typical shared prefix of consecutive views; tune it from run/usage.jsonl.
export const MASTER_MARKS = [64_000];

// The master's built-in tools. Claude Code ships ~28 (Cron*, RemoteTrigger, PushNotification,
// Artifact*, ...): anything that can act outside the harness's reach stays off.
export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

/** Our own MCP tools. Always allowed by the policy and by --allowedTools; listed here once. */
export const OWN_TOOLS = ["zoom", "date", "search"] as const;
export const ownToolName = (n: string): string => `mcp__optchat__${n}`;

/** View files are saved this long after the last change (a flush at turn end and at shutdown saves the rest). */
export const SAVE_DELAY_MS = 1000;

export const AUTONOMY_LIMIT = 3; // consecutive turns not started by the user
export const CONFIRM_TIMEOUT_MS = 15 * 60_000;
/** A child that ignores SIGINT gets SIGTERM after this, and SIGKILL after twice this. */
export const KILL_GRACE_MS = 4_000;

/** Compactions: a cheap model (optchat.md section 4). Haiku 4.5 takes no `effort` setting and no fallbacks. */
export const COMPACTOR_MODEL = "claude-haiku-4-5";
/** A message's node starts once fewer than this many messages before it are still unbuilt. */
export const UNBUILT_AHEAD = 8;
/** The compaction view (what a compaction reads), sawtooth from 32 KB down to 16 KB. */
export const COMPACTION_VIEW_HIGH = 32_000;
export const COMPACTION_VIEW_LOW = 16_000;
export const MASTER_MODEL = "opus";

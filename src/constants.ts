// Sizes are UTF-8 bytes (or characters, for cache marks), never tokens.
export const NODE = 512; // target size of one summary line
export const VIEW = 128_000; // budget of the view
export const JOBS = 8; // compactor calls at once
export const TRIES = 5; // attempts per node to get under NODE
export const RETRY_MS = 10_000; // wait before retrying a failed node
export const CAP = 30_000; // max chars of one tool result (head + tail kept)
export const STEP_INPUT_CAP = 4_000; // max chars of a logged tool-call input
export const PLACEHOLDER = "(not summarized yet: zoom it)";

// Cache breakpoints inside the view, in characters.
// The compactor calls the API directly (system + 3 view marks = 4 breakpoints).
export const COMPACTOR_MARKS = [50_000, 80_000, 100_000];
// Through `claude -p` only ONE view mark fits: Claude Code uses 3 of the 4
// allowed breakpoints itself (docs/cli-findings.md, S2a).
// Measured: with one mark the next turn re-reads the view up to it (docs/cli-findings.md).
// 64k is below the typical shared prefix of consecutive views; tune it from run/usage.jsonl.
export const MASTER_MARKS = [64_000];

// The master's built-in tools. Claude Code ships ~28 (Cron*, RemoteTrigger, PushNotification,
// Artifact*, ...): anything that can act outside the harness's reach stays off.
export const MASTER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

export const AUTONOMY_LIMIT = 3; // consecutive turns not started by the user
export const CONFIRM_TIMEOUT_MS = 15 * 60_000;
/** A child that ignores SIGINT gets SIGTERM after this, and SIGKILL after twice this. */
export const KILL_GRACE_MS = 4_000;

export const COMPACTOR_MODEL = "claude-sonnet-5-5";
export const MASTER_MODEL = "opus";

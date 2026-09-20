// The one place the coordination channel's issue number lives (#3182).
//
// AGENTS.md § Cross-session agent coordination is the protocol; this file is
// the protocol's one machine-readable fact — WHICH issue is the standing
// channel — so that rotating the channel is a one-line change here plus the
// prose, instead of a hunt through every script that reads or writes it
// (`claim-collision.mjs`, `release-on-merge.mjs`, `pr-ownership-gate.mjs`,
// `claim-assignee.mjs` all import it).
//
// ## Why the channel rotates
//
// Every collision check reads the whole channel (`gh api … /comments
// --paginate`), and the first channel, #1289, had grown to 1,394 comments /
// 1.46 MB by 2026-09-20 — forty days of history paged through to find the last
// twenty-four hours, and past `execFileSync`'s default 1 MiB buffer
// (ENOBUFS, fixed by raising it in #3177). Rotating keeps that read cheap.
// The retired channel stays OPEN and unwritten: its history is greppable and
// its comment links keep resolving, but nothing reads it for live state.
//
// A claim posted on the retired channel in the 24 h before rotation is not
// invisible: the assignee projection (`claim-assignee.yml`) had already
// assigned the holder, and `liveHolders()` counts assignees as holders. What
// is lost is only the channel-side ACTIVITY timestamp for that one day.

/** The standing agent coordination channel. */
export const CHANNEL_ISSUE = 3193

/**
 * Retired channels, newest first. Read-only history: no script writes to or
 * reads live state from these; they are listed so a reader of a `#1289` link
 * in an old comment knows what it was.
 */
export const RETIRED_CHANNEL_ISSUES = Object.freeze([1289])

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
// --paginate`), and the first channel, #1289, had grown to ~1,400 comments
// (1,396 on 2026-09-20; ~1.46 MB of comment bodies) — forty days of history
// paged through to find the last twenty-four hours, and past `execFileSync`'s default 1 MiB buffer
// (ENOBUFS, fixed by raising it in #3177). Rotating keeps that read cheap.
// The retired channel stays OPEN and unwritten: its history is greppable and
// its comment links keep resolving, but nothing reads it for live state.
//
// ## The transition day is a real gap, and this is what closes it
//
// A claim that lives ONLY on the retired channel (posted there in the 24 h
// before rotation, never on the issue) is invisible to `claim-collision.mjs`
// after the switch: its assignee is still on the issue, but a holder is a
// claim COMMENT in force, and the comment is on a thread nobody reads any
// more — so a second session's claim on that issue is accepted, not refused
// (measured in review of #3182: assignees alone yield `others` but no `live`).
// The backstop is the `PR ownership gate` (#3179), which fails on a foreign
// ASSIGNEE regardless of comments, so the exposure is a silent double claim
// for at most one day, never a merge over someone's work. The rotation
// procedure closes even that: the pointer comment posted on the retired
// channel at rotation lists every claim still live there and asks its holder
// to re-post it on the new channel (a claim on the issue itself is read
// either way).

/** The standing agent coordination channel. */
export const CHANNEL_ISSUE = 3193

/**
 * Retired channels, newest first. Read-only history: no script writes to or
 * reads live state from these; they are listed so a reader of a `#1289` link
 * in an old comment knows what it was.
 */
export const RETIRED_CHANNEL_ISSUES = Object.freeze([1289])

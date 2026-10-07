- **Hosted MCP: agent identity before tool dispatch** — every hosted tool
  dispatch now resolves the request's agent API key to an agent
  (`haven.getAgent()`) before the tool's handler runs, and refuses with the
  typed `AGENT_IDENTITY_UNVERIFIED` (`next_action: stop_and_tell_user`) when
  that read fails — a rejected key and an unreachable backend alike. Until
  now the HTTP transport (`packages/mcp-server/src/http.ts`) checked that a
  bearer token was present and left validity to whichever Haven call a tool
  made first; several tools make an outbound merchant request (quote probes,
  MCP handshakes, merchant discovery) before any Haven call of their own.
  The gate lives in `buildHostedMcpServer`'s registration loop
  (`packages/mcp-server/src/server.ts`), so it covers every tool, including
  any added later; the only exemption is `haven_verify_receipt`, which makes
  no network request at all.

  **No custody or authority change:** the gate only refuses earlier. Nothing
  is signed, built, moved or retried; the hosted server stays keyless; the
  caveat enforcers in the delegation remain the spend control, and an API
  key remains identity, never authority. No key, signature, delegation,
  caveat, budget or recipient pin changes; no backend file, route or
  on-chain surface moves. Perimeter unchanged.

  **Verified:** `strict-tool-input.test.ts` runs every gated tool, with its
  own valid arguments over the real MCP transport, against a Haven that
  answers the agent read 401, 403 and 503, and pins that the only request
  made is that read and that the refusal is the typed one; removing the gate
  fails 83 tests. A second test pins the exemption list to the tools that are
  offline by design. The two #2349 cap-refusal tests now expect exactly the
  identity read. Full `packages/mcp-server` suite green.

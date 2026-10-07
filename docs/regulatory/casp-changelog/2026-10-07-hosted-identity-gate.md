- **Hosted MCP: agent identity before tool dispatch** — every hosted tool
  dispatch now resolves the agent API key to an agent (`haven.getAgent()`)
  before the tool's handler runs, so no tool issues any request, to Haven or
  a third party, for a key Haven does not accept. The gate lives in
  `packages/mcp-server/src/tools/identity-gate.ts` and runs from
  `buildHostedMcpServer`'s registration loop, so it covers every tool,
  including any added later. A 401 on that read refuses with the typed
  `AGENT_IDENTITY_UNVERIFIED` (`next_action: stop_and_tell_user`); any other
  failure is relayed through `normalizeError` unchanged, so a paused or
  pending-approval agent still sees the backend's own reason. Two tools are
  exempt: `haven_verify_receipt`, which makes no request, and
  `haven_sweep_delegate`, which calls only the sweep routes the backend keeps
  open to revoked, paused and archived keys, so stranded delegate funds stay
  recoverable through hosted MCP.

  **No custody or authority change:** the gate adds a refusal before a
  handler runs and removes none; the recovery path is exempted so it is
  unchanged. Nothing is signed, built, moved or retried; the hosted server
  stays keyless; the caveat enforcers in the delegation remain the spend
  control, and an API key remains identity, never authority. No key,
  signature, delegation, caveat, budget or recipient pin changes; no backend
  file, route or on-chain surface moves.

  **Verified:** `strict-tool-input.test.ts` runs every gated tool, with its
  own valid arguments over the real MCP transport, against a Haven that
  answers the agent read 401, 403 and 503, and pins that the only request
  made is that read; a 401 yields the typed refusal and a 403 keeps the
  backend's reason. Further tests pin that `haven_verify_receipt` makes no
  request and that `haven_sweep_delegate` reaches `/sweep/prepare` with a key
  the agent read refuses. The refusal census gains the gate's one
  `refusalNextStep` site and fixture. Full `packages/mcp-server` suite green.
  Perimeter unchanged.

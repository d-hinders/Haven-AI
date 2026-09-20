import type { SignerOptions } from './server.js'
import { registeredSignerToolNames } from './consent.js'

/**
 * #3173: the signer's argument parser, testable without spawning a process.
 * Every result is a decision, never a side effect — the CLI entry turns
 * `help` into stdout + exit 0 and `unknown-option` into one stderr line + exit 2.
 */
export type CliDecision =
  | { kind: 'run'; options: SignerOptions }
  | { kind: 'help'; text: string }
  | { kind: 'unknown-option'; option: string; text: string }

export const CONNECTOR_DOCTOR_COMMAND = 'npx @haven_ai/connect --doctor'

export function parseSignerArgs(argv: readonly string[]): CliDecision {
  const options: SignerOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--credentials' || arg === '--credentials-path') {
      options.credentialsPath = argv[i + 1]
      i += 1
    } else if (arg === '--ack') {
      options.writeAck = true
    } else if (arg === '--help' || arg === '-h') {
      return { kind: 'help', text: helpText() }
    } else {
      // #3173: before this, an unknown flag — including `--ack-local-tools`,
      // which the CONNECTOR's doctor tells the operator to pass to the
      // CONNECTOR — was silently ignored, so the user saw the consent wall and
      // exit 1 with no hint that the flag went to the wrong program.
      return {
        kind: 'unknown-option',
        option: arg,
        text:
          `haven-signer: unknown option ${arg}. Run with --help for the options this signer takes` +
          (arg === '--ack-local-tools'
            ? ` — --ack-local-tools belongs to the connector (${CONNECTOR_DOCTOR_COMMAND}), not the signer.`
            : '.'),
      }
    }
  }
  return { kind: 'run', options }
}

export function helpText(): string {
  const tools = registeredSignerToolNames()
  return [
    'Haven edge signer (local, holds the delegate key)',
    '',
    'Runs a local stdio MCP server exposing sign-only tools:',
    ...tools.map((name) => `  - ${name}`),
    'Pair it with the hosted, keyless Haven MCP server: the hosted server',
    'constructs and relays, this one signs.',
    '',
    'Usage:',
    '  npx @haven_ai/signer --credentials /path/to/agent.json',
    '',
    'Options:',
    '  --credentials <path>   Haven credential JSON (delegate_key is read from it).',
    '                         Alias: --credentials-path. Also supported: HAVEN_CREDENTIALS,',
    '                         or HAVEN_DELEGATE_KEY.',
    '  --ack                  Acknowledge the first-launch consent block and write',
    '                         a signer sidecar acknowledgement next to the credential.',
    '  --help, -h             This text. Any other option is refused (exit 2).',
    '',
    'Consent:',
    '  On first launch the signer prints the sign-only tool list and delegate',
    '  address, then refuses to start unless acknowledged. Its only Haven API call',
    '  is a read-only fetch of the signing payload for one pending payment, so it',
    '  cannot show a live allowance summary.',
    '  Acknowledge with EITHER --ack OR HAVEN_SIGNER_ACK=<hash> in your environment.',
    '',
    'Connector-wired (the usual case)?',
    `  Diagnose and repair with: ${CONNECTOR_DOCTOR_COMMAND}`,
    "  (an unacknowledged signer shows there as a failed 'Signer stdio handshake'",
    '  check, and in the connector\'s setup outcome as local_signer_ack_required;',
    '  the repair is the connector\'s --ack-local-tools, not a signer flag).',
    '',
  ].join('\n')
}

'use client'

import { CodeBlock } from '@/components/ui/CodeBlock'

/**
 * The page's one action, with a copy button. `CodeBlock` only renders its
 * header and copy button when it has a `filename` or an `onCopy` — and a
 * server component cannot pass a function — so this thin client wrapper
 * supplies both (#3304 design review).
 */
export function UpdateCommand({ command }: { command: string }) {
  return (
    <CodeBlock filename="Update command" onCopy={() => undefined}>
      {command}
    </CodeBlock>
  )
}

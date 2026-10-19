'use client'

/**
 * Re-export shim (#3508). `useCopyTimeout` moved to `@haven_ai/ui`
 * (`packages/ui/src/hooks/useCopyTimeout.ts`) — `CodeBlock` still consumes
 * it from here (its other consumer, `AgentOnboardingPromptCard`, was deleted
 * by #4065). New code imports the package directly.
 */
export { useCopyTimeout } from '@haven_ai/ui/hooks/useCopyTimeout'

'use client'

/**
 * Re-export shim (#3508). `useCopyTimeout` moved to `@haven_ai/ui`
 * (`packages/ui/src/hooks/useCopyTimeout.ts`) — `CodeBlock` and
 * `AgentOnboardingPromptCard` still consume it from here. New code imports
 * the package directly.
 */
export { useCopyTimeout } from '@haven_ai/ui/hooks/useCopyTimeout'

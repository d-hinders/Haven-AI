'use client'

/**
 * Re-export shim (#3508). `CopyButton` moved to `@haven_ai/ui`
 * (`packages/ui/src/CopyButton.tsx`) as part of the shared ops-console design
 * system; it and `useCopyTimeout` moved together. This shim keeps every existing
 * `@/components/ui/CopyButton` import working. New code imports the package
 * directly.
 */
export * from '@haven_ai/ui/CopyButton'

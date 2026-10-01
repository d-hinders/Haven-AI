'use client'

/**
 * Re-export shim (#3508). `Input` moved to `@haven_ai/ui`
 * (`packages/ui/src/Input.tsx`) as part of the shared ops-console design
 * system; the primitives the ops console consumes moved to the shared package. This shim keeps every existing
 * `@/components/ui/Input` import working. New code imports the package
 * directly.
 */
export * from '@haven_ai/ui/Input'
export { default } from '@haven_ai/ui/Input'

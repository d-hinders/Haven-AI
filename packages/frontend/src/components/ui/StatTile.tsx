'use client'

/**
 * Re-export shim (#3508). `StatTile` moved to `@haven_ai/ui`
 * (`packages/ui/src/StatTile.tsx`) as part of the shared ops-console design
 * system; the primitives the ops console consumes moved to the shared package. This shim keeps every existing
 * `@/components/ui/StatTile` import working. New code imports the package
 * directly.
 */
export * from '@haven_ai/ui/StatTile'
export { default } from '@haven_ai/ui/StatTile'

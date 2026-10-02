/**
 * Re-export shim (#3508). `Card` moved to `@haven_ai/ui`
 * (`packages/ui/src/Card.tsx`) as part of the shared ops-console design
 * system; the primitives the ops console consumes moved to the shared package. This shim keeps every existing
 * `@/components/ui/Card` import working. New code imports the package
 * directly.
 */
export * from '@haven_ai/ui/Card'

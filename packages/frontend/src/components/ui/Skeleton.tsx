/**
 * Re-export shim (#3508). `Skeleton` moved to `@haven_ai/ui`
 * (`packages/ui/src/Skeleton.tsx`) as part of the shared ops-console design
 * system; the primitives the ops console consumes moved to the shared package. This shim keeps every existing
 * `@/components/ui/Skeleton` import working. New code imports the package
 * directly.
 */
export * from '@haven_ai/ui/Skeleton'
export { default } from '@haven_ai/ui/Skeleton'

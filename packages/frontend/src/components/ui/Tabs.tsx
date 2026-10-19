/**
 * Re-export shim (#3508). `Tabs` lives in `@haven_ai/ui`
 * (`packages/ui/src/Tabs.tsx`) as part of the shared design system the ops
 * console consumes. This shim keeps `@/components/ui/Tabs` imports working;
 * new code imports the package directly.
 */
export * from '@haven_ai/ui/Tabs'

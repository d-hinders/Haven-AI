export function CodeBlock({
  language = 'bash',
  children,
  filename,
}: {
  language?: string
  children: string
  filename?: string
}) {
  return (
    <div className="rounded-[10px] overflow-hidden border border-[var(--v2-border)] shadow-[var(--v2-shadow-card)] bg-[var(--v2-surface-code)]">
      {filename && (
        <div className="flex items-center justify-between px-4 h-9 border-b border-white/10 text-[12px] text-white/60 font-mono">
          <span>{filename}</span>
          <span className="uppercase tracking-wider text-[10px]">{language}</span>
        </div>
      )}
      <pre className="px-5 py-4 text-[13px] leading-[1.65] text-white/90 font-mono overflow-x-auto v2-tabular">
        <code>{children}</code>
      </pre>
    </div>
  )
}

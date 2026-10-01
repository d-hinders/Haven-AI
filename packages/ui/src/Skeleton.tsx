type SkeletonProps = {
  className?: string
  variant?: 'text' | 'rect' | 'circle'
}

export function Skeleton({ className = '', variant = 'rect' }: SkeletonProps) {
  // Default background applies only when the caller hasn't supplied one.
  const hasCustomBg = /(^|\s)bg-/.test(className)
  const bgClass = hasCustomBg ? '' : 'bg-[var(--v2-surface-2)]'
  // Height/width are caller-controlled via `className`. Variant only sets the corner radius.
  const variantClass =
    variant === 'circle' ? 'rounded-full' :
    variant === 'text' ? 'rounded' :
    'rounded-md'
  return <div className={`${bgClass} animate-pulse ${variantClass} ${className}`} aria-hidden="true" />
}

export default Skeleton

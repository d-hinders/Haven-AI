import { ImageResponse } from 'next/og'
import { AppIconArtwork } from '@/components/brand/AppIconArtwork'
import { havenEnvironment } from '@/lib/env'
import { APP_ICONS } from '@/lib/installed-app'

// Generated home-screen icon (#2729) — see `lib/installed-app.ts` for which
// consumer reads this size. Rendered once at build; the environment badge
// comes from the same helper as the manifest name, so they cannot disagree.
const icon = APP_ICONS.apple

export const size = { width: icon.size, height: icon.size }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(<AppIconArtwork size={icon.size} environment={havenEnvironment()} />, size)
}

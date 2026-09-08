import type { MetadataRoute } from 'next'
import { havenEnvironment } from '@/lib/env'
import { buildWebManifest } from '@/lib/installed-app'

/**
 * `/manifest.webmanifest` (#2729). Next emits the `<link rel="manifest">` for
 * this file on every page and prerenders the body at build time — the only
 * input is the build-inlined `NEXT_PUBLIC_HAVEN_ENV`, read through the same
 * helper `EnvBadge` uses, so the chip in the top bar and the name on the home
 * screen cannot disagree about which deployment this is.
 */
export default function manifest(): MetadataRoute.Manifest {
  return buildWebManifest(havenEnvironment())
}

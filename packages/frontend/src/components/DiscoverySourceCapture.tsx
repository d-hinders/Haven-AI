'use client'

import { useEffect } from 'react'
import { captureDiscoverySource } from '@/lib/discovery'

/**
 * Invisible first-touch capture for connect attribution (#2302). Mounted once
 * in the root layout so a `?src=` slug on ANY entry page (login, signup,
 * marketing routes served by this app) is remembered until the user reaches
 * the authenticated connect flow. Renders nothing; never throws.
 */
export default function DiscoverySourceCapture(): null {
  useEffect(() => {
    captureDiscoverySource(window.location.search)
  }, [])
  return null
}

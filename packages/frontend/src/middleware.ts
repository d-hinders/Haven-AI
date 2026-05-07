import { NextRequest, NextResponse } from 'next/server'

const INVESTOR_HOST_PREFIXES = ['briefing.', 'investor.', 'investors.']

function configuredInvestorHosts() {
  return (process.env.INVESTOR_BRIEFING_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

function normalizedHost(request: NextRequest) {
  return (request.headers.get('host') ?? '').split(':')[0]?.toLowerCase() ?? ''
}

function isInvestorHost(host: string) {
  if (!host) return false
  if (configuredInvestorHosts().includes(host)) return true
  return INVESTOR_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))
}

function isStaticAsset(pathname: string) {
  return (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname.match(/\.(?:css|js|map|png|jpg|jpeg|gif|webp|svg|ico|txt|woff2?)$/)
  )
}

export function middleware(request: NextRequest) {
  const host = normalizedHost(request)
  if (!isInvestorHost(host)) return NextResponse.next()

  const { pathname } = request.nextUrl
  if (isStaticAsset(pathname)) return NextResponse.next()

  if (pathname === '/') {
    const url = request.nextUrl.clone()
    url.pathname = '/investor-briefing'
    return NextResponse.rewrite(url)
  }

  if (pathname === '/investor-briefing') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return new NextResponse('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

export const config = {
  matcher: ['/:path*'],
}

/** USDC on Base mainnet */
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
export const CHAIN_ID = 8453

export type ProductId =
  | 'vpn_basic'
  | 'vpn_pro'
  | 'vpn_ultra'
  | 'storage_50gb'
  | 'storage_200gb'
  | 'storage_1tb'

export interface Product {
  id: ProductId
  name: string
  description: string
  /** Price in USDC base units (6 decimals). E.g. $1.00 = 1_000_000n */
  price_usdc: bigint
  category: 'vpn' | 'storage'
}

export const PRODUCTS: Record<ProductId, Product> = {
  vpn_basic: {
    id: 'vpn_basic',
    name: 'NordShield VPN Basic',
    description: 'Grundläggande VPN-skydd. Upp till 10 enheter. Standardhastigheter. 50+ serverplatser.',
    price_usdc: 1_000n,
    category: 'vpn',
  },
  vpn_pro: {
    id: 'vpn_pro',
    name: 'NordShield VPN Pro',
    description: 'Premium VPN. Obegränsade enheter. Höghastighetsservrar. Dubbel-VPN. 90+ länder.',
    price_usdc: 3_000n,
    category: 'vpn',
  },
  vpn_ultra: {
    id: 'vpn_ultra',
    name: 'NordShield VPN Ultra',
    description: 'Ultimat sekretess. Onion-routing. Dedikerade IP-adresser. Prioritetssupport dygnet runt.',
    price_usdc: 5_000n,
    category: 'vpn',
  },
  storage_50gb: {
    id: 'storage_50gb',
    name: 'CloudNest 50 GB',
    description: 'Säker krypterad molnlagring. 50 GB. Fildelning och automatisk synk ingår.',
    price_usdc: 500n,
    category: 'storage',
  },
  storage_200gb: {
    id: 'storage_200gb',
    name: 'CloudNest 200 GB',
    description: 'Utökad lagring. 200 GB. Versionshantering, automatisk backup och prioritetsbandbredd.',
    price_usdc: 1_500n,
    category: 'storage',
  },
  storage_1tb: {
    id: 'storage_1tb',
    name: 'CloudNest 1 TB',
    description: 'Affärsklass molnlagring. 1 TB. API-åtkomst, teamdelning och SLA 99,9% drifttid.',
    price_usdc: 4_000n,
    category: 'storage',
  },
}

/** Format USDC base units as a human-readable USD string.
 *  Strips trailing zeros so micropayments show correctly (e.g. 0.001 not 0.00). */
export function formatUsdc(units: bigint): string {
  const dollars = Number(units) / 1_000_000
  return parseFloat(dollars.toFixed(6)).toString()
}

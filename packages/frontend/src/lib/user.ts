import type { User } from '@/context/AuthContext'

export function displayName(user: Pick<User, 'name' | 'email'> | null | undefined): string {
  const name = user?.name?.trim()
  return name || user?.email || 'Haven user'
}

export function userInitial(user: Pick<User, 'name' | 'email'> | null | undefined): string {
  return displayName(user).charAt(0).toUpperCase()
}

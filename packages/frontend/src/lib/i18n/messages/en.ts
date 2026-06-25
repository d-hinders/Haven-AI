/**
 * English message catalog — the source of truth for the app's copy.
 *
 * Leaves are plain strings, or functions when a value needs interpolation
 * (e.g. a count). The shape of this object is the `Messages` type every other
 * locale must satisfy (see ../index.ts), so a missing or mistyped key in
 * another locale is a compile error, not a silent fallback.
 */
export const en = {
  common: {
    comingSoon: 'Coming soon',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Manage preferences, account access, notifications, and data controls.',
    viewProfile: 'View profile',

    preferences: {
      title: 'Preferences',
      description: 'Choose how Haven displays values and future alerts.',
    },
    currency: {
      label: 'Preferred currency',
      detail: 'Used for balances, spending limits, and portfolio totals.',
    },
    language: {
      label: 'Language',
      detail: "Choose the language Haven's interface is shown in.",
      english: 'English',
      swedish: 'Svenska',
    },
    approvalAlerts: {
      label: 'Approval alerts',
      detail: 'Get notified when a transaction needs approval.',
    },
    agentSpendAlerts: {
      label: 'Agent spend alerts',
      detail: 'Receive updates when agents use their budget.',
    },

    access: {
      title: 'Access',
      description: 'How you sign in to Haven and approve actions on your accounts.',
    },
    passkey: {
      label: 'Passkey status',
      enrolled: 'Enrolled',
      none: 'No passkey',
      detailEnrolled: (n: number) =>
        `${n} passkey${n !== 1 ? 's' : ''} registered for approving actions in Haven.`,
      detailNone: 'Set up a passkey during onboarding for faster approvals.',
    },
    password: {
      label: 'Password',
      detail: 'Password changes are not available yet.',
    },

    approvers: {
      title: 'Approvers',
      description:
        'Wallets and passkeys that can approve actions, managed per account. Threshold stays at 1.',
    },

    recovery: {
      title: 'Recovery and safety',
      description: 'Know what Haven can and cannot recover.',
      limitationsLabel: 'Recovery limitations',
      limitationsDetail:
        'Haven can help you find account details, but it cannot bypass your wallets or passkeys or recover funds sent on the wrong network.',
      backupLabel: 'Backup approver',
      backupDetail: 'Adding backup approvers is not available yet.',
      sessionsLabel: 'Active sessions',
      sessionsDetail: 'Review signed-in devices and revoke sessions.',
    },

    data: {
      title: 'Data and privacy',
      description: 'Controls for activity history and product preferences.',
      exportLabel: 'Export transactions',
      exportDetail: 'Download a CSV of account and agent activity.',
      privacyLabel: 'Privacy controls',
      privacyDetail: 'Manage analytics and product improvement preferences.',
    },
  },
}

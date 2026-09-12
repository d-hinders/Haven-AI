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
  /** The per-transaction accounting badge (#2870). */
  accountingBadge: {
    /** `provider` is the display name, e.g. "Fortnox". */
    inProvider: (provider: string) => `In ${provider}`,
    feeding: 'Feeding…',
    notFed: 'Not fed',
    /** Accessible name for the badge link — the label, then where it goes. */
    openAccounting: (label: string) => `${label}. Open accounting.`,
  },
  /** The `/accounting` feed page's pointer to where the connection lives (#2868). */
  accountingPage: {
    manageInSettings: 'Manage your accounting connection in Settings.',
    openSettings: 'Open Settings',
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

    recovery: {
      title: 'Recovery and safety',
      description: 'Know what Haven can and cannot recover.',
      limitationsLabel: 'Recovery limitations',
      limitationsDetail:
        'Haven can help you find account details, but it cannot bypass your wallets or passkeys or recover funds sent on the wrong network.',
      backupLabel: 'Backup and recovery',
      backupDetail: 'Backups are managed per account, under Backup and recovery on any of its agents.',
      sessionsLabel: 'Active sessions',
      sessionsDetail: 'Review signed-in devices and revoke sessions.',
      exitPathLabel: 'Your exit path',
      exitPathDetail: 'Inspect and revoke your agent budgets directly on-chain — without Haven. Opens the independent exit page.',
    },

    /**
     * The Accounting connections card (#2868, epic #2858). Copy follows the
     * accounting guardrail: a payment APPEARS in the ledger with its payment
     * evidence attached and the accountant books it — Haven never books,
     * codes or asserts anything.
     */
    accounting: {
      title: 'Accounting',
      description:
        'Connect the accounting tool your company uses. Settled agent payments appear there with payment evidence attached; your accountant books them.',
      /**
       * Carried over from the feed page's connect card, which this section
       * replaced: the responsibility line the accounting guardrail requires.
       */
      disclaimer:
        'Haven provides data tooling, not accounting or tax advice. Payments are fed as drafts — you and your accountant remain responsible for coding, correctness, and filing.',
      loadError: 'We could not load accounting connections. Try again in a moment.',
      /**
       * One line per coming-soon provider — listed, never endorsed. The chip
       * and the disabled action already say it is not connectable, so the
       * line does not repeat that. A provider without a line gets none.
       */
      comingSoonDescription: {
        accounted: 'Swedish online accounting.',
        light: 'Accounting for small companies.',
        igdrasil: 'Bookkeeping and invoicing.',
      } as Record<string, string>,
      /**
       * Human labels for the provider scope identifiers `missingScopes`
       * carries (Fortnox's, today). An identifier without a label is shown
       * raw rather than hidden — the sentence must still name what a
       * reconnect adds.
       */
      scopeLabels: {
        companyinformation: 'company information',
        connectfile: 'file attachments',
        inbox: 'inbox',
        supplierinvoice: 'supplier invoices',
        supplier: 'suppliers',
        archive: 'archive',
        bookkeeping: 'bookkeeping',
      } as Record<string, string>,
      notConfigured: 'Not available on this deployment yet.',
      status: {
        connected: 'Connected',
        needs_reauthorisation: 'Sign-in expired',
        scope_missing: 'Needs more access',
        revoked_at_provider: 'Access revoked',
        disconnected: 'Not connected',
      },
      detail: {
        connectedTo: (company: string) => `Connected to ${company}`,
        connectedNoCompany: 'Connected',
        lastPush: (date: string) => `Last fed ${date}`,
        nothingFedYet: 'Nothing fed yet',
        needsReauthorisation: (provider: string) =>
          `Your ${provider} sign-in has expired. Reconnect to keep feeding payments.`,
        scopeMissing: (provider: string, scopes: string) =>
          `${provider} needs more access than it granted (${scopes}). Reconnect to grant it.`,
        scopeMissingUnnamed: (provider: string) =>
          `${provider} needs more access than it granted. Reconnect to grant it.`,
        revoked: (provider: string) => `Access was revoked in ${provider}. Reconnect to resume feeding.`,
        /** Never connected: guide the action. */
        notConnected: (provider: string) => `Connect to feed settled payments to ${provider}.`,
        /** Disconnected after a connection: say what happened to the history. */
        disconnected: (provider: string) =>
          `Nothing is fed to ${provider}. What was fed earlier stays in Haven.`,
      },
      actions: {
        connect: 'Connect',
        reconnect: 'Reconnect',
        disconnect: 'Disconnect',
        settings: 'Settings',
        hideSettings: 'Hide settings',
        working: 'Working…',
      },
      connectError: (provider: string) => `We could not start the ${provider} connection. Try again in a moment.`,
      disconnect: {
        title: (provider: string) => `Disconnect ${provider}?`,
        body: (provider: string) =>
          `Haven stops feeding payments to ${provider}. What was already fed stays in ${provider}, and the feed history stays in Haven. You can reconnect at any time.`,
        confirm: 'Disconnect',
        cancel: 'Keep connected',
        error: 'We could not disconnect. Try again in a moment.',
      },
      settings: {
        title: 'Feed settings',
        suggestedAccountLabel: 'Suggested account',
        suggestedAccountHelp:
          'A hint carried on each fed document, such as 6540. It only suggests — it never books, and your accountant still chooses the account.',
        suggestedAccountPlaceholder: 'e.g. 6540',
        autoFeedLabel: 'Feed settled payments automatically',
        autoFeedHelp:
          'Off means manual only: payments are fed when you press Sync now on the Accounting page.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        invalidSuggestedAccount: 'Enter a four-digit account between 1000 and 8999, or leave it empty.',
        invalidSetting: (key: string) => `${key} was not accepted. Check the value and try again.`,
        error: 'We could not save these settings. Try again in a moment.',
      },
      backfill: {
        title: 'Include earlier payments?',
        intro: (provider: string) =>
          `${provider} is connected. From now on, settled agent payments appear there with payment evidence attached; your accountant books them.`,
        fromNow: 'Feed from now',
        fromNowHelp: 'Only payments settled from now on are fed.',
        since: 'Include payments since',
        sinceHelp:
          'Earlier payments are fed too, up to 200 at a time — press Sync now on the Accounting page for the rest.',
        sinceLabel: 'Date (YYYY-MM-DD)',
        confirm: 'Continue',
        /** The footer's way out — the same no-op as "Feed from now". */
        notNow: 'Not now',
        working: 'Feeding…',
        /**
         * #2915: `fed` is what the sync actually pushed, `total` what it
         * enumerated — the sentence never claims a payment that did not land.
         */
        done: (fed: number, total: number) => `${fed} of ${total} earlier payment${total === 1 ? '' : 's'} fed.`,
        /** Under `done` when some enumerated payments were not pushed. */
        partial: 'Some of the earlier payments were not fed. Press Sync now on the Accounting page to try them again.',
        close: 'Done',
        errors: {
          SINCE_INVALID: 'Enter a past date as YYYY-MM-DD, not before 2020-01-01.',
          SINCE_NOT_EARLIER: 'That date is not earlier than what is already being fed.',
          NOT_ACTIVE: 'This connection is not where payments are fed, so no history can be included.',
          generic: 'We could not include earlier payments. Try again in a moment.',
        },
      },
      /** What the OAuth callback redirect says on return (`?provider=…&connect=…`). */
      outcome: {
        connected: (provider: string) => `${provider} is connected.`,
        denied: (provider: string) => `You declined the ${provider} consent. Nothing was connected.`,
        unsupportedCurrency:
          'Haven currently feeds SEK ledgers only. Choose a company that books in SEK and try again.',
        error: (provider: string) => `We could not connect ${provider}. Try again in a moment.`,
      },
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

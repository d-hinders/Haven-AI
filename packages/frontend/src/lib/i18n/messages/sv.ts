import type { Messages } from '../index'

/**
 * Swedish message catalog. Typed as `Messages`, so it must mirror the English
 * catalog's shape exactly — any missing or mistyped key fails the build.
 */
export const sv: Messages = {
  common: {
    comingSoon: 'Kommer snart',
  },
  accountingBadge: {
    inProvider: (provider: string) => `I ${provider}`,
    feeding: 'Matas…',
    notFed: 'Inte matad',
    openAccounting: (label: string) => `${label}. Öppna bokföring.`,
  },
  accountingPage: {
    manageInSettings: 'Hantera din bokföringskoppling under Inställningar.',
    openSettings: 'Öppna Inställningar',
  },
  settings: {
    title: 'Inställningar',
    subtitle: 'Hantera inställningar, kontoåtkomst, notiser och datakontroller.',
    viewProfile: 'Visa profil',

    preferences: {
      title: 'Inställningar',
      description: 'Välj hur Haven visar värden och framtida aviseringar.',
    },
    currency: {
      label: 'Föredragen valuta',
      detail: 'Används för saldon, spendergränser och portföljsummor.',
    },
    language: {
      label: 'Språk',
      detail: 'Välj vilket språk Havens gränssnitt visas på.',
      english: 'English',
      swedish: 'Svenska',
    },
    agentSpendAlerts: {
      label: 'Aviseringar om agentutgifter',
      detail: 'Få uppdateringar när agenter använder sin budget.',
    },

    access: {
      title: 'Åtkomst',
      description: 'Hur du loggar in i Haven och godkänner åtgärder på dina konton.',
    },
    passkey: {
      label: 'Passkey-status',
      enrolled: 'Registrerad',
      none: 'Ingen passkey',
      detailEnrolled: (n: number) =>
        `${n} passkey${n !== 1 ? 's' : ''} registrerade för att godkänna åtgärder i Haven.`,
      detailNone: 'Skapa en passkey under onboarding för snabbare godkännanden.',
    },
    password: {
      label: 'Lösenord',
      detail: 'Lösenordsbyte är inte tillgängligt ännu.',
    },

    recovery: {
      title: 'Återställning och säkerhet',
      description: 'Få klart för dig vad Haven kan och inte kan återställa.',
      limitationsLabel: 'Begränsningar för återställning',
      limitationsDetail:
        'Haven kan hjälpa dig hitta kontouppgifter, men kan inte kringgå dina plånböcker eller passkeys, eller återställa medel som skickats på fel nätverk.',
      backupLabel: 'Säkerhetskopiering och återställning',
      backupDetail: 'Säkerhetskopior hanteras per konto, under Säkerhetskopiering och återställning på någon av dess agenter.',
      sessionsLabel: 'Aktiva sessioner',
      sessionsDetail: 'Granska inloggade enheter och återkalla sessioner.',
      exitPathLabel: 'Din exit-väg',
      exitPathDetail: 'Inspektera och återkalla dina agentbudgetar direkt på kedjan — utan Haven. Öppnar den fristående exit-sidan.',
    },

    accounting: {
      title: 'Bokföring',
      description:
        'Anslut bokföringsprogrammet ditt företag använder. Avklarade agentbetalningar dyker upp där med betalningsunderlag bifogat; din redovisningskonsult bokför dem.',
      disclaimer:
        'Haven tillhandahåller dataverktyg, inte bokförings- eller skatterådgivning. Betalningar matas som utkast — du och din redovisningskonsult ansvarar fortfarande för kontering, riktighet och inlämning.',
      loadError: 'Vi kunde inte läsa in bokföringskopplingar. Försök igen om en stund.',
      comingSoonDescription: {
        accounted: 'Svensk bokföring online.',
        light: 'Bokföring för små företag.',
        igdrasil: 'Bokföring och fakturering.',
      } as Record<string, string>,
      scopeLabels: {
        companyinformation: 'företagsinformation',
        connectfile: 'filbilagor',
        inbox: 'inkorg',
        supplierinvoice: 'leverantörsfakturor',
        supplier: 'leverantörer',
        archive: 'arkiv',
        bookkeeping: 'bokföring',
      } as Record<string, string>,
      notConfigured: 'Inte tillgängligt i den här installationen ännu.',
      status: {
        connected: 'Ansluten',
        needs_reauthorisation: 'Inloggning utgången',
        scope_missing: 'Behöver mer åtkomst',
        revoked_at_provider: 'Åtkomst återkallad',
        disconnected: 'Inte ansluten',
      },
      detail: {
        connectedTo: (company: string) => `Ansluten till ${company}`,
        connectedNoCompany: 'Ansluten',
        lastPush: (date: string) => `Senast matad ${date}`,
        nothingFedYet: 'Inget matat ännu',
        needsReauthorisation: (provider: string) =>
          `Din inloggning i ${provider} har gått ut. Återanslut för att fortsätta mata betalningar.`,
        scopeMissing: (provider: string, scopes: string) =>
          `${provider} behöver mer åtkomst än vad som beviljades (${scopes}). Återanslut för att ge den.`,
        scopeMissingUnnamed: (provider: string) =>
          `${provider} behöver mer åtkomst än vad som beviljades. Återanslut för att ge den.`,
        revoked: (provider: string) => `Åtkomsten återkallades i ${provider}. Återanslut för att mata igen.`,
        notConnected: (provider: string) => `Anslut för att mata avklarade betalningar till ${provider}.`,
        disconnected: (provider: string) =>
          `Inget matas till ${provider}. Det som matats tidigare finns kvar i Haven.`,
      },
      actions: {
        connect: 'Anslut',
        reconnect: 'Återanslut',
        disconnect: 'Koppla från',
        settings: 'Inställningar',
        hideSettings: 'Dölj inställningar',
        working: 'Arbetar…',
      },
      connectError: (provider: string) => `Vi kunde inte starta anslutningen till ${provider}. Försök igen om en stund.`,
      disconnect: {
        title: (provider: string) => `Koppla från ${provider}?`,
        body: (provider: string) =>
          `Haven slutar mata betalningar till ${provider}. Det som redan matats finns kvar i ${provider}, och matningshistoriken finns kvar i Haven. Du kan återansluta när som helst.`,
        confirm: 'Koppla från',
        cancel: 'Behåll anslutningen',
        error: 'Vi kunde inte koppla från. Försök igen om en stund.',
      },
      settings: {
        title: 'Matningsinställningar',
        suggestedAccountLabel: 'Föreslaget konto',
        suggestedAccountHelp:
          'En ledtråd som följer med varje matat underlag, till exempel 6540. Den föreslår bara — den bokför aldrig, och din redovisningskonsult väljer fortfarande konto.',
        suggestedAccountPlaceholder: 't.ex. 6540',
        autoFeedLabel: 'Mata avklarade betalningar automatiskt',
        autoFeedHelp:
          'Av betyder endast manuellt: betalningar matas när du trycker på Synka nu på bokföringssidan.',
        save: 'Spara',
        saving: 'Sparar…',
        saved: 'Sparat.',
        invalidSuggestedAccount: 'Ange ett fyrsiffrigt konto mellan 1000 och 8999, eller lämna tomt.',
        invalidSetting: (key: string) => `${key} godtogs inte. Kontrollera värdet och försök igen.`,
        error: 'Vi kunde inte spara inställningarna. Försök igen om en stund.',
      },
      backfill: {
        title: 'Ta med tidigare betalningar?',
        intro: (provider: string) =>
          `${provider} är anslutet. Från och med nu dyker avklarade agentbetalningar upp där med betalningsunderlag bifogat; din redovisningskonsult bokför dem.`,
        fromNow: 'Mata från och med nu',
        fromNowHelp: 'Bara betalningar som avklaras från och med nu matas.',
        since: 'Ta med betalningar sedan',
        sinceHelp:
          'Tidigare betalningar matas också, upp till 200 åt gången — tryck på Synka nu på bokföringssidan för resten.',
        sinceLabel: 'Datum (ÅÅÅÅ-MM-DD)',
        confirm: 'Fortsätt',
        notNow: 'Inte nu',
        working: 'Matar…',
        done: (fed: number, total: number) => `${fed} av ${total} tidigare betalning${total === 1 ? '' : 'ar'} matade.`,
        partial: 'Några av de tidigare betalningarna matades inte. Tryck på Synka nu på bokföringssidan för att försöka igen.',
        close: 'Klart',
        errors: {
          SINCE_INVALID: 'Ange ett datum bakåt i tiden som ÅÅÅÅ-MM-DD, inte före 2020-01-01.',
          SINCE_NOT_EARLIER: 'Datumet är inte tidigare än det som redan matas.',
          NOT_ACTIVE: 'Den här kopplingen är inte dit betalningar matas, så ingen historik kan tas med.',
          generic: 'Vi kunde inte ta med tidigare betalningar. Försök igen om en stund.',
        },
      },
      outcome: {
        connected: (provider: string) => `${provider} är anslutet.`,
        denied: (provider: string) => `Du avböjde samtycket för ${provider}. Inget anslöts.`,
        unsupportedCurrency:
          'Haven matar för närvarande bara SEK-bokföring. Välj ett företag som bokför i SEK och försök igen.',
        error: (provider: string) => `Vi kunde inte ansluta ${provider}. Försök igen om en stund.`,
      },
    },

    data: {
      title: 'Data och integritet',
      description: 'Kontroller för aktivitetshistorik och produktinställningar.',
      exportLabel: 'Exportera transaktioner',
      exportDetail: 'Ladda ner en CSV med konto- och agentaktivitet.',
      privacyLabel: 'Integritetskontroller',
      privacyDetail: 'Hantera inställningar för analys och produktförbättring.',
    },
  },
}

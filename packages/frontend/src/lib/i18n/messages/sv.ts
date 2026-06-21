import type { Messages } from '../index'

/**
 * Swedish message catalog. Typed as `Messages`, so it must mirror the English
 * catalog's shape exactly — any missing or mistyped key fails the build.
 */
export const sv: Messages = {
  common: {
    comingSoon: 'Kommer snart',
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
    approvalAlerts: {
      label: 'Godkännandeaviseringar',
      detail: 'Få en notis när en transaktion behöver godkännas.',
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

    approvers: {
      title: 'Godkännare',
      description:
        'Plånböcker och passkeys som kan godkänna åtgärder, hanteras per konto. Tröskeln är kvar på 1.',
    },

    recovery: {
      title: 'Återställning och säkerhet',
      description: 'Få klart för dig vad Haven kan och inte kan återställa.',
      limitationsLabel: 'Begränsningar för återställning',
      limitationsDetail:
        'Haven kan hjälpa dig hitta kontouppgifter, men kan inte kringgå dina plånböcker eller passkeys, eller återställa medel som skickats på fel nätverk.',
      backupLabel: 'Reservgodkännare',
      backupDetail: 'Att lägga till reservgodkännare är inte tillgängligt ännu.',
      sessionsLabel: 'Aktiva sessioner',
      sessionsDetail: 'Granska inloggade enheter och återkalla sessioner.',
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

// Element names that make an action hard to undo (safety-policy §4). Clicking or invoking a
// control with one of these names is high risk: it always confirms and is never grantable.
// One entry per UI language (English, Dutch, German, French, Spanish: the Gmail and Outlook
// strings). Every language is matched at once: whole-word matching keeps false hits rare, and
// the UI language of a web app is not known up front. Accents are ignored when matching.

interface LocaleNames {
  /** Send buttons (allowSendWithoutReview makes these medium). */
  send: string[]
  /** Other hard-to-undo controls, high everywhere. */
  high: string[]
  /** High only in an email app: too generic elsewhere (Outlook Ignore / Sweep / Clean Up). */
  mail: string[]
  /** To / Cc / Bcc box names, matched at the start of the field name. */
  recipientStart: string[]
  /** Words that make a field a recipient box anywhere in its name ("To recipients"). */
  recipientWord: string[]
  /** Subject and search boxes: Enter there does not send. */
  noSend: string[]
}

const LOCALES: Record<string, LocaleNames> = {
  en: {
    send: ['send', 'send now'],
    high: [
      'submit',
      'post',
      'publish',
      'tweet',
      'reply all',
      'pay',
      'pay now',
      'buy',
      'buy now',
      'purchase',
      'place order',
      'checkout',
      'check out',
      'confirm payment',
      'delete',
      'delete forever',
      'permanently delete',
      'move to trash',
      'discard',
      'discard draft',
      'report spam',
      'report junk',
      'report phishing',
      'block sender',
      'empty folder',
      'empty trash',
      'remove',
      'erase',
      'empty recycle bin',
      'unsubscribe',
      'transfer',
      'sign',
      'accept terms',
      'uninstall',
      'format',
      'reset',
      'factory reset',
      'deactivate',
      'close account',
      'delete account'
    ],
    mail: ['ignore', 'ignore conversation', 'sweep', 'clean up'],
    recipientStart: ['to', 'cc', 'bcc'],
    recipientWord: ['recipient', 'recipients'],
    noSend: ['subject', 'search']
  },
  nl: {
    send: ['verzenden', 'versturen', 'verstuur', 'nu verzenden'],
    high: [
      'verwijderen',
      'definitief verwijderen',
      'permanent verwijderen',
      'naar prullenbak verplaatsen',
      'prullenbak legen',
      'map leegmaken',
      'concept verwijderen',
      'concept weggooien',
      'weggooien',
      'spam melden',
      'als spam melden',
      'phishing melden',
      'ongewenste e-mail melden',
      'afzender blokkeren',
      'allen beantwoorden'
    ],
    mail: ['negeren', 'gesprek negeren', 'opruimen', 'opschonen'],
    recipientStart: ['aan', 'cc', 'bcc'],
    recipientWord: ['ontvanger', 'ontvangers'],
    noSend: ['onderwerp', 'zoeken']
  },
  de: {
    send: ['senden', 'absenden', 'jetzt senden'],
    high: [
      'löschen',
      'endgültig löschen',
      'in den papierkorb',
      'papierkorb leeren',
      'ordner leeren',
      'entwurf verwerfen',
      'verwerfen',
      'spam melden',
      'als spam melden',
      'phishing melden',
      'absender blockieren',
      'allen antworten'
    ],
    mail: ['ignorieren', 'unterhaltung ignorieren', 'aufräumen'],
    recipientStart: ['an', 'cc', 'bcc'],
    recipientWord: ['empfänger'],
    noSend: ['betreff', 'suchen', 'durchsuchen']
  },
  fr: {
    send: ['envoyer', 'envoyer maintenant'],
    high: [
      'supprimer',
      'supprimer définitivement',
      'supprimer le brouillon',
      'vider la corbeille',
      'vider le dossier',
      'signaler comme spam',
      'signaler comme indésirable',
      "signaler l'hameçonnage",
      "bloquer l'expéditeur",
      'répondre à tous'
    ],
    mail: ['ignorer', 'ignorer la conversation', 'nettoyer', 'balayer'],
    recipientStart: ['à', 'cc', 'cci'],
    recipientWord: ['destinataire', 'destinataires'],
    noSend: ['objet', 'rechercher']
  },
  es: {
    send: ['enviar', 'enviar ahora'],
    high: [
      'eliminar',
      'eliminar definitivamente',
      'eliminar para siempre',
      'borrar',
      'descartar',
      'descartar borrador',
      'vaciar papelera',
      'vaciar carpeta',
      'denunciar spam',
      'notificar spam',
      'notificar como correo no deseado',
      'bloquear remitente',
      'responder a todos'
    ],
    mail: ['omitir', 'ignorar', 'ignorar conversación', 'limpiar', 'barrer'],
    recipientStart: ['para', 'cc', 'cco'],
    recipientWord: ['destinatario', 'destinatarios'],
    noSend: ['asunto', 'buscar']
  }
}

const all = (k: keyof LocaleNames): string[] => [
  ...new Set(Object.values(LOCALES).flatMap((l) => l[k]))
]

/** Lower case, no accents, curly apostrophes straightened: "Löschen" → "loschen". */
const fold = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase()

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whole words only ("Sender" or "Signal" are not "Send" / "Sign"); spaces match any gap.
// Longest first, so "Discard draft" is reported as that rather than as "discard".
function wordsRe(names: string[]): RegExp {
  const byLength = [...new Set(names.map(fold))].sort((a, b) => b.length - a.length)
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])(${byLength.map((n) => escape(n).replace(/ /g, '[\\s_-]+')).join('|')})(?=$|[^\\p{L}\\p{N}])`,
    'iu'
  )
}

const SEND = new Set(all('send').map(fold))
const NAME_RE = wordsRe([...all('send'), ...all('high')])
const MAIL_RE = wordsRe(all('mail'))
/** Folded form → the name as listed ("loschen" → "löschen"), for the confirm card. */
const SHOWN = new Map(
  (['send', 'high', 'mail'] as const).flatMap((k) => all(k).map((n) => [fold(n), n] as const))
)

function match(re: RegExp, name: string | undefined): string | null {
  if (!name) return null
  const m = re.exec(fold(name.trim()))
  if (!m) return null
  const word = m[1].replace(/[\s_-]+/g, ' ')
  return SHOWN.get(word) ?? word
}

/** The risky word in a control name ("Send", "Place order", "Verzenden"), or null. */
export function riskyName(name: string | undefined): string | null {
  return match(NAME_RE, name)
}

/** A word riskyName returned is a Send button. */
export function isSendName(word: string): boolean {
  return SEND.has(fold(word))
}

/** Names that delete or move mail in bulk in an email app only (Ignore, Sweep, Clean Up). */
export function mailRiskyName(name: string | undefined): string | null {
  return match(MAIL_RE, name)
}

const B = '(?=$|[^\\p{L}\\p{N}])'
const START = `^(?:${all('recipientStart').map(escape).join('|')})${B}`
const ANYWHERE = `(?:^|[^\\p{L}\\p{N}])(?:${all('recipientWord').map(escape).join('|')})${B}`
const RECIPIENT_RE = new RegExp(`${START}|${ANYWHERE}`, 'iu')
const NO_SEND_RE = new RegExp(
  `${START}|${ANYWHERE}|(?:^|[^\\p{L}\\p{N}])(?:${all('noSend').map(escape).join('|')})${B}`,
  'iu'
)

/** To / Cc / Bcc boxes in any listed language ("To recipients", "Aan", "An", "À", "Para"). */
export function isRecipientName(name: string | undefined): boolean {
  return !!name && RECIPIENT_RE.test(name.trim())
}

/** Recipient, subject and search boxes: Enter there picks or searches, it does not send. */
export function isNoSendFieldName(name: string | undefined): boolean {
  return !!name && NO_SEND_RE.test(name.trim())
}

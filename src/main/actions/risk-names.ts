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

// ---- checkout, payment and personal-detail fields (05 T41) ----

interface CheckoutNames {
  /** Buttons that book, buy or pay. One word: only at the start of the name ("Book now",
   * "Pay €120", not "Address book"); several words: anywhere as whole words. */
  checkout: string[]
  /** Fields only the user fills: card number, holder, expiry, CVC, IBAN, account number. */
  payment: string[]
  /** Personal-detail fields, matched anywhere as whole words ("Billing address", "First name"). */
  personal: string[]
  /** Personal-detail fields that must be the whole field name ("Name", "Address": Edge's
   * "Address and search bar" and "File name" are not). */
  personalExact: string[]
}

const CHECKOUT: Record<string, CheckoutNames> = {
  en: {
    checkout: [
      'book',
      'book now',
      'book it',
      'reserve',
      'reserve now',
      'pay',
      'pay now',
      'confirm booking',
      'complete booking',
      'confirm reservation',
      'complete reservation',
      'place order',
      'buy now',
      'buy',
      'purchase',
      'complete purchase',
      'confirm purchase',
      'confirm and pay',
      'confirm order',
      'submit order',
      'confirm payment',
      'checkout',
      'check out',
      'proceed to checkout',
      'proceed to payment'
    ],
    payment: [
      'card number',
      'credit card number',
      'debit card number',
      'cardholder',
      'card holder',
      'cardholder name',
      'name on card',
      'expiry',
      'expiry date',
      'expiration',
      'expiration date',
      'exp date',
      'mm yy',
      'mm/yy',
      'cvc',
      'cvv',
      'cvc2',
      'cvv2',
      'csc',
      'security code',
      'card verification',
      'card verification code',
      'iban',
      'account number',
      'bank account',
      'sort code',
      'routing number',
      'cc number',
      'cc exp',
      'cc csc',
      'cc name'
    ],
    personal: [
      'first name',
      'last name',
      'full name',
      'given name',
      'family name',
      'surname',
      'email',
      'e-mail',
      'email address',
      'phone',
      'phone number',
      'mobile number',
      'telephone',
      'street',
      'street address',
      'billing address',
      'delivery address',
      'shipping address',
      'house number',
      'postcode',
      'postal code',
      'zip code',
      'date of birth'
    ],
    personalExact: ['name', 'your name', 'address', 'city', 'town', 'zip', 'mobile', 'birthday']
  },
  nl: {
    checkout: [
      'boeken',
      'nu boeken',
      'reserveren',
      'nu reserveren',
      'betalen',
      'nu betalen',
      'boeking bevestigen',
      'boeking afronden',
      'reservering bevestigen',
      'bestelling plaatsen',
      'bestellen',
      'nu kopen',
      'kopen',
      'afrekenen',
      'bevestigen en betalen'
    ],
    payment: [
      'kaartnummer',
      'kaarthouder',
      'naam op de kaart',
      'naam op kaart',
      'vervaldatum',
      'geldig tot',
      'beveiligingscode',
      'rekeningnummer'
    ],
    personal: [
      'voornaam',
      'achternaam',
      'e-mailadres',
      'emailadres',
      'telefoonnummer',
      'telefoon',
      'mobiel nummer',
      'straat',
      'straatnaam',
      'huisnummer',
      'postcode',
      'woonplaats',
      'factuuradres',
      'afleveradres',
      'geboortedatum'
    ],
    personalExact: ['naam', 'adres', 'plaats', 'mobiel']
  },
  de: {
    checkout: [
      'buchen',
      'jetzt buchen',
      'reservieren',
      'jetzt reservieren',
      'bezahlen',
      'jetzt bezahlen',
      'zahlungspflichtig buchen',
      'zahlungspflichtig bestellen',
      'buchung bestätigen',
      'buchung abschließen',
      'reservierung bestätigen',
      'bestellung abschicken',
      'jetzt kaufen',
      'kaufen',
      'zur kasse',
      'bestätigen und bezahlen'
    ],
    payment: [
      'kartennummer',
      'karteninhaber',
      'name auf der karte',
      'ablaufdatum',
      'gültig bis',
      'prüfnummer',
      'kartenprüfnummer',
      'sicherheitscode',
      'kontonummer'
    ],
    personal: [
      'vorname',
      'nachname',
      'e-mail-adresse',
      'telefonnummer',
      'handynummer',
      'straße',
      'hausnummer',
      'postleitzahl',
      'rechnungsadresse',
      'lieferadresse',
      'geburtsdatum'
    ],
    personalExact: ['name', 'adresse', 'ort', 'stadt', 'plz', 'telefon', 'handy']
  },
  fr: {
    checkout: [
      'réserver',
      'réserver maintenant',
      'payer',
      'payer maintenant',
      'confirmer la réservation',
      'finaliser la réservation',
      'passer la commande',
      'valider la commande',
      'commander',
      'acheter',
      'acheter maintenant',
      'confirmer et payer'
    ],
    payment: [
      'numéro de carte',
      'titulaire de la carte',
      "date d'expiration",
      'cryptogramme',
      'cryptogramme visuel',
      'code de sécurité',
      'numéro de compte'
    ],
    personal: [
      'prénom',
      'nom de famille',
      'adresse e-mail',
      'adresse électronique',
      'courriel',
      'téléphone',
      'numéro de téléphone',
      'rue',
      'code postal',
      'adresse de facturation',
      'adresse de livraison',
      'date de naissance'
    ],
    personalExact: ['nom', 'adresse', 'ville', 'portable']
  },
  es: {
    checkout: [
      'reservar',
      'reservar ahora',
      'pagar',
      'pagar ahora',
      'confirmar reserva',
      'completar reserva',
      'realizar pedido',
      'hacer pedido',
      'tramitar pedido',
      'finalizar compra',
      'comprar',
      'comprar ahora',
      'confirmar y pagar'
    ],
    payment: [
      'número de tarjeta',
      'titular de la tarjeta',
      'fecha de caducidad',
      'fecha de vencimiento',
      'código de seguridad',
      'número de cuenta'
    ],
    personal: [
      'apellido',
      'apellidos',
      'correo electrónico',
      'teléfono',
      'número de teléfono',
      'calle',
      'código postal',
      'dirección de facturación',
      'dirección de envío',
      'fecha de nacimiento'
    ],
    personalExact: ['nombre', 'dirección', 'ciudad', 'móvil', 'correo']
  }
}

const allOf = (k: keyof CheckoutNames): string[] => [
  ...new Set(Object.values(CHECKOUT).flatMap((l) => l[k]))
]

const altOf = (names: string[]): string =>
  [...new Set(names.map(fold))]
    .sort((a, b) => b.length - a.length)
    .map((n) => escape(n).replace(/ /g, '[\\s_-]+'))
    .join('|')

const CHECKOUT_ALL = allOf('checkout')
const CHECKOUT_SHOWN = new Map(CHECKOUT_ALL.map((n) => [fold(n), n] as const))
// Any listed name at the start (after symbols: "→ Pay"), or a several-word name anywhere.
const CHECKOUT_RE = new RegExp(
  `^[^\\p{L}\\p{N}]*(${altOf(CHECKOUT_ALL)})${B}|(?:^|[^\\p{L}\\p{N}])(${altOf(CHECKOUT_ALL.filter((n) => n.includes(' ')))})${B}`,
  'iu'
)

/** The book / reserve / pay / order words of a button name ("Book now", "Pay €120"), or null. */
export function checkoutName(name: string | undefined): string | null {
  if (!name) return null
  const m = CHECKOUT_RE.exec(fold(name.trim()))
  if (!m) return null
  const word = (m[1] ?? m[2]).replace(/[\s_-]+/g, ' ')
  return CHECKOUT_SHOWN.get(word) ?? word
}

const PAYMENT_RE = wordsRe(allOf('payment'))
const PERSONAL_RE = wordsRe(allOf('personal'))
const PERSONAL_EXACT = new Set(allOf('personalExact').map(fold))
/** "Search email" or "Zoeken op plaats" is a search box, not a form field. */
const SEARCH_RE = wordsRe(['search', 'zoeken', 'suchen', 'rechercher', 'buscar', 'find'])

/** "Name *", "Your name (required)", "City:" → the bare label. */
function bareLabel(name: string): string {
  return fold(name)
    .replace(/\((?:required|optional|verplicht|optioneel|pflicht|obligatoire|obligatorio)\)/g, '')
    .replace(/[\s*:.]+$/, '')
    .replace(/^[\s*]+/, '')
}

/** A card number / holder / expiry / CVC / IBAN / account number field, any listed language. */
export function isPaymentFieldName(name: string | undefined): boolean {
  return !!name && PAYMENT_RE.test(fold(name.trim()))
}

/** A name / email / phone / address / birth date field, any listed language. */
export function isPersonalFieldName(name: string | undefined): boolean {
  if (!name?.trim() || SEARCH_RE.test(fold(name))) return false
  return PERSONAL_RE.test(fold(name.trim())) || PERSONAL_EXACT.has(bareLabel(name))
}

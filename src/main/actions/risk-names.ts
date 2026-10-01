// Element names that make an action hard to undo (safety-policy §4). Clicking or invoking a
// control with one of these names is high risk: it always confirms and is never grantable.
// English first; other languages are appended per locale.

const HIGH_RISK_NAMES = [
  'send',
  'send now',
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
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whole words only ("Sender" or "Signal" are not "Send" / "Sign"); spaces match any gap.
const NAME_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(${HIGH_RISK_NAMES.map((n) => escape(n).replace(/ /g, '[\\s_-]+')).join('|')})(?=$|[^\\p{L}\\p{N}])`,
  'iu'
)

/** The risky word in a control name ("Send", "Place order"), or null. */
export function riskyName(name: string | undefined): string | null {
  if (!name) return null
  const m = NAME_RE.exec(name.trim())
  return m ? m[1].toLowerCase().replace(/[\s_-]+/g, ' ') : null
}

// Head pointer voice commands (11 T25 leftover), whole utterances only: "recentre",
// "pause / resume the head pointer", "head pointer on / off". Pure.

export type PointerCommand = 'recentre' | 'pause' | 'resume' | 'on' | 'off'

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(please |lumen )+/, '')
    .replace(/ please$/, '')

const THING = '(?:the )?(?:head (?:pointer|mouse|cursor)|face (?:pointer|mouse|cursor))'
const CENTRE = 're-?cent(?:re|er)'

const RULES: { re: RegExp; cmd: PointerCommand }[] = [
  { re: new RegExp(`^${CENTRE}(?: (?:the )?(?:pointer|cursor|mouse))?$`), cmd: 'recentre' },
  { re: new RegExp(`^${CENTRE} ${THING}$`), cmd: 'recentre' },
  { re: new RegExp(`^(?:pause|freeze|hold) ${THING}$`), cmd: 'pause' },
  { re: new RegExp(`^(?:resume|unpause|unfreeze|continue) ${THING}$`), cmd: 'resume' },
  { re: new RegExp(`^(?:turn on|start|enable|switch on) ${THING}$`), cmd: 'on' },
  { re: new RegExp(`^${THING} on$`), cmd: 'on' },
  { re: new RegExp(`^(?:turn off|stop|disable|switch off) ${THING}$`), cmd: 'off' },
  { re: new RegExp(`^${THING} off$`), cmd: 'off' }
]

export function parsePointerCommand(text: string): PointerCommand | null {
  const t = clean(text)
  if (!t || t.length > 60) return null
  return RULES.find((r) => r.re.test(t))?.cmd ?? null
}

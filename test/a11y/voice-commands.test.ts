import { describe, expect, it } from 'vitest'
import {
  IDLE_CONTEXT,
  commandSheet,
  normalize,
  parseCommand,
  type CommandArgs,
  type CommandContext
} from '../../src/main/a11y/voice-commands'
import { GRAMMAR } from '../../src/main/a11y/grammar/en'
import { parseNumber } from '../../src/main/a11y/grammar/numbers'
import { parseKeys } from '../../src/main/a11y/grammar/keys'

const MARKS: CommandContext = { ...IDLE_CONTEXT, marksShown: true }
const GRID: CommandContext = { ...IDLE_CONTEXT, gridShown: true }
const DRAG: CommandContext = { ...GRID, dragStarted: true }
const GUIDE: CommandContext = { ...IDLE_CONTEXT, guideActive: true }
const SCROLLING: CommandContext = { ...IDLE_CONTEXT, autoScrolling: true }

type Row = [utterance: string, id: string, args?: CommandArgs, ctx?: CommandContext]

const POSITIVE: Row[] = [
  // numbers
  ['show numbers', 'marks.show'],
  ['Show numbers.', 'marks.show'],
  ['numbers', 'marks.show'],
  ['show labels', 'marks.show'],
  ['please show numbers', 'marks.show'],
  ['hey lumen, show numbers please', 'marks.show'],
  ['lumen numbers', 'marks.show'],
  ['show numbers everywhere', 'marks.show', { scope: 'all' }],
  ['numbers all screens', 'marks.show', { scope: 'all' }],
  ['numbers for links', 'marks.show', { role: 'links' }],
  ['show numbers for buttons', 'marks.show', { role: 'buttons' }],
  ['numbers for text fields', 'marks.show', { role: 'fields' }],
  ['numbers on tabs', 'marks.show', { role: 'tabs' }],
  ['hide numbers', 'marks.hide', {}, MARKS],
  ['no numbers', 'marks.hide', {}, MARKS],
  ['clear', 'marks.hide', {}, MARKS],
  ['click 5', 'marks.act', { n: 5, action: 'click' }],
  ['click five', 'marks.act', { n: 5, action: 'click' }],
  ['Click number 12.', 'marks.act', { n: 12, action: 'click' }],
  ['click twenty one', 'marks.act', { n: 21, action: 'click' }],
  ['click twenty-one', 'marks.act', { n: 21, action: 'click' }],
  ['click one hundred and two', 'marks.act', { n: 102, action: 'click' }],
  ['press 7', 'marks.act', { n: 7, action: 'click' }, MARKS],
  ['choose 3', 'marks.act', { n: 3, action: 'click' }, MARKS],
  ['open 4', 'marks.act', { n: 4, action: 'click' }, MARKS],
  ['5', 'marks.act', { n: 5, action: 'click' }, MARKS],
  ['eight', 'marks.act', { n: 8, action: 'click' }, MARKS],
  ['number 9', 'marks.act', { n: 9, action: 'click' }, MARKS],
  ['click to', 'marks.act', { n: 2, action: 'click' }, MARKS],
  ['double click 5', 'marks.act', { n: 5, action: 'double' }, MARKS],
  ['right click three', 'marks.act', { n: 3, action: 'right' }, MARKS],
  ['focus 6', 'marks.act', { n: 6, action: 'focus' }, MARKS],
  ['go to 6', 'marks.act', { n: 6, action: 'focus' }, MARKS],
  ['drag 3 to 7', 'marks.drag', { n: 3, m: 7 }, MARKS],
  ['drag number 3 onto number 10', 'marks.drag', { n: 3, m: 10 }, MARKS],
  ['type hello in 4', 'marks.type', { text: 'hello', n: 4 }, MARKS],
  ['Type Hello World into 2.', 'marks.type', { text: 'Hello World', n: 2 }, MARKS],
  ['show more numbers', 'marks.more', {}, MARKS],
  ['next numbers', 'marks.more', {}, MARKS],
  ['keep numbers', 'marks.keep', { on: true }],
  ['stop keeping numbers', 'marks.keep', { on: false }],
  // grid
  ['mouse grid', 'grid.show'],
  ['grid', 'grid.show'],
  ['show grid', 'grid.show'],
  ['mouse grid 2', 'grid.show', { n: 2 }],
  ['mouse grid on monitor two', 'grid.show', { n: 2 }],
  ['5', 'grid.select', { n: 5 }, GRID],
  ['seven', 'grid.select', { n: 7 }, GRID],
  ['box 3', 'grid.select', { n: 3 }, GRID],
  ['click', 'grid.act', { action: 'click' }, GRID],
  ['double click', 'grid.act', { action: 'double' }, GRID],
  ['right click', 'grid.act', { action: 'right' }, GRID],
  ['drag', 'grid.mark', {}, GRID],
  ['mark', 'grid.mark', {}, GRID],
  ['drop', 'grid.drop', {}, DRAG],
  ['drag here', 'grid.drop', {}, DRAG],
  ['undo', 'grid.up', {}, GRID],
  ['back', 'grid.up', {}, GRID],
  ['cancel', 'grid.close', {}, GRID],
  ['close grid', 'grid.close', {}, GRID],
  // pointer
  ['click', 'pointer.click', { button: 'left', count: 1 }],
  ['left click', 'pointer.click', { button: 'left', count: 1 }],
  ['double click', 'pointer.click', { button: 'left', count: 2 }],
  ['right click', 'pointer.click', { button: 'right', count: 1 }],
  ['middle click', 'pointer.click', { button: 'middle', count: 1 }],
  ['move mouse left', 'pointer.move', { dir: 'left' }],
  ['move the pointer up 5', 'pointer.move', { dir: 'up', n: 5 }],
  ['nudge cursor right', 'pointer.move', { dir: 'right' }],
  ['click compose', 'pointer.click-name', { text: 'compose' }],
  ['Click Compose.', 'pointer.click-name', { text: 'Compose' }],
  ['click on Send', 'pointer.click-name', { text: 'Send' }],
  // scrolling
  ['scroll down', 'scroll', { dir: 'down' }],
  ['Scroll down.', 'scroll', { dir: 'down' }],
  ['scroll up', 'scroll', { dir: 'up' }],
  ['page down', 'scroll', { dir: 'down' }],
  ['scroll left', 'scroll', { dir: 'left' }],
  ['scroll down a little', 'scroll', { dir: 'down', amount: 'little' }],
  ['scroll up a lot', 'scroll', { dir: 'up', amount: 'lot' }],
  ['scroll down 3 times', 'scroll', { dir: 'down', n: 3 }],
  ['scroll to the top', 'scroll.edge', { edge: 'top' }],
  ['go to bottom', 'scroll.edge', { edge: 'bottom' }],
  ['go to the bottom of the page', 'scroll.edge', { edge: 'bottom' }],
  ['start scrolling down', 'scroll.auto', { dir: 'down' }],
  ['stop scrolling', 'scroll.stop', {}, SCROLLING],
  ['stop', 'scroll.stop', {}, SCROLLING],
  ['faster', 'scroll.speed', { faster: true }, SCROLLING],
  // keyboard
  ['press enter', 'key.press', { combo: 'enter' }],
  ['Press Enter.', 'key.press', { combo: 'enter' }],
  ['press return', 'key.press', { combo: 'enter' }],
  ['press escape', 'key.press', { combo: 'esc' }],
  ['press control s', 'key.press', { combo: 'ctrl+s' }],
  ['press ctrl+shift+t', 'key.press', { combo: 'ctrl+shift+t' }],
  ['press alt tab', 'key.press', { combo: 'alt+tab' }],
  ['press tab 3 times', 'key.press', { combo: 'tab', n: 3 }],
  ['press page down', 'key.press', { combo: 'pagedown' }],
  ['press f5', 'key.press', { combo: 'f5' }],
  ['press f twelve', 'key.press', { combo: 'f12' }],
  ['hit space', 'key.press', { combo: 'space' }],
  ['press down arrow', 'key.press', { combo: 'down' }],
  ['press 5', 'key.press', { combo: '5' }],
  ['type hello world', 'key.type', { text: 'hello world' }],
  ['Type Hello, World!', 'key.type', { text: 'Hello, World' }],
  ['write Dear Sam', 'key.type', { text: 'Dear Sam' }],
  ['dictate see you at 5', 'key.type', { text: 'see you at 5' }],
  ['new line', 'key.fixed', { combo: 'enter' }],
  ['new paragraph', 'key.fixed', { combo: 'enter', times: 2 }],
  ['tab key', 'key.fixed', { combo: 'tab' }],
  ['backspace', 'key.fixed', { combo: 'backspace' }],
  ['backspace 4', 'key.fixed', { combo: 'backspace', n: 4 }],
  ['delete that', 'key.fixed', { combo: 'delete' }],
  ['delete word', 'key.fixed', { combo: 'ctrl+backspace' }],
  ['select all', 'key.fixed', { combo: 'ctrl+a' }],
  ['copy', 'key.fixed', { combo: 'ctrl+c' }],
  ['cut', 'key.fixed', { combo: 'ctrl+x' }],
  ['paste', 'key.fixed', { combo: 'ctrl+v' }],
  ['undo', 'key.fixed', { combo: 'ctrl+z' }],
  ['redo', 'key.fixed', { combo: 'ctrl+y' }],
  ['save', 'key.fixed', { combo: 'ctrl+s' }],
  ['spell c a t', 'key.spell', { text: 'c a t' }],
  ['caps on', 'key.caps', { on: true }],
  // navigation and windows
  ['go back', 'key.fixed', { combo: 'alt+left' }],
  ['back', 'key.fixed', { combo: 'alt+left' }],
  ['go forward', 'key.fixed', { combo: 'alt+right' }],
  ['refresh', 'key.fixed', { combo: 'f5' }],
  ['reload the page', 'key.fixed', { combo: 'f5' }],
  ['new tab', 'key.fixed', { combo: 'ctrl+t' }],
  ['close tab', 'key.fixed', { combo: 'ctrl+w' }],
  ['next tab', 'key.fixed', { combo: 'ctrl+tab' }],
  ['previous tab', 'key.fixed', { combo: 'ctrl+shift+tab' }],
  ['tab 3', 'tab.n', { n: 3 }],
  ['go to tab two', 'tab.n', { n: 2 }],
  ['open notepad', 'app.open', { app: 'notepad' }],
  ['Open Microsoft Word.', 'app.open', { app: 'microsoft word' }],
  ['launch calculator', 'app.open', { app: 'calculator' }],
  ['start paint', 'app.open', { app: 'paint' }],
  ['minimize', 'key.fixed', { combo: 'win+down' }],
  ['maximize window', 'key.fixed', { combo: 'win+up' }],
  ['show desktop', 'key.fixed', { combo: 'win+d' }],
  ['switch window', 'key.fixed', { combo: 'alt+tab' }],
  // lumen
  ['pause dwell', 'dwell.set', { on: false }],
  ['resume dwell', 'dwell.set', { on: true }],
  ['dwell off', 'dwell.set', { on: false }],
  ['start scanning', 'scan.set', { on: true }],
  ['stop scanning', 'scan.set', { on: false }],
  ['what can I say', 'lumen.help'],
  ['What can I say?', 'lumen.help'],
  ['help', 'lumen.help'],
  ['commands', 'lumen.help'],
  ['open settings', 'lumen.settings'],
  ['lumen settings', 'lumen.settings'],
  ['go to sleep', 'lumen.listen', { on: false }],
  ['wake up', 'lumen.listen', { on: true }],
  ['could you scroll down please', 'scroll', { dir: 'down' }],
  ['um, scroll down, thanks', 'scroll', { dir: 'down' }],
  ['okay press enter', 'key.press', { combo: 'enter' }]
]

const NEGATIVE: [string, CommandContext?][] = [
  ['stopwatch'],
  ['cancel my subscription'],
  ["what's the weather"],
  ["what's the weather", GUIDE],
  ['go back to gmail and open the first email'],
  ['close this tab and the next one'],
  ['next time remind me'],
  ['type'],
  ['twenty-five'],
  ['5'],
  ['click to'],
  ['scroll'],
  ['how do I make a pivot table'],
  ['where is the save button'],
  ['what is this'],
  ['describe screen'],
  ['write an email to my boss about the meeting tomorrow'],
  ['open the first email'],
  ['open gmail and send a message'],
  ['open my documents folder'],
  ['press the big red button'],
  ['scroll down and click the first link'],
  ['show me numbers of sales this year'],
  ['grid lines in excel'],
  ['drop'],
  ['drop', GRID],
  ['hide numbers'],
  ['stop'],
  ['cancel'],
  ['yes'],
  ['no'],
  ['next'],
  ['back', GUIDE],
  ['go back', GUIDE],
  ['double click 5'],
  ['right click three'],
  ['drag 3 to 7'],
  ['tab 12'],
  ['mouse grid 12'],
  ['press control'],
  ['press hello there'],
  ['click'.repeat(80)],
  [''],
  ['   '],
  ['   .  ']
]

describe('voice command grammar', () => {
  it.each(POSITIVE)('"%s" → %s', (utterance, id, args, ctx) => {
    const cmd = parseCommand(utterance, ctx ?? IDLE_CONTEXT)
    expect(cmd, `no match for "${utterance}"`).not.toBeNull()
    expect(cmd!.id).toBe(id)
    if (args) expect(cmd!.args).toMatchObject(args)
  })

  it.each(NEGATIVE)('"%s" is not a command', (utterance, ctx) => {
    expect(parseCommand(utterance, ctx ?? IDLE_CONTEXT)).toBeNull()
  })

  it('has a large corpus', () => {
    expect(POSITIVE.length + NEGATIVE.length).toBeGreaterThanOrEqual(200)
  })

  it('every grammar entry is reachable by its own example', () => {
    const ctx: CommandContext = {
      marksShown: true,
      gridShown: false,
      dragStarted: false,
      guideActive: false,
      autoScrolling: false,
      answerShown: true
    }
    for (const e of GRAMMAR) {
      const example = e.id === 'grid.select' ? '5' : e.say.split(',')[0].trim()
      const c =
        e.gate === 'grid' || e.gate === 'grid-drag'
          ? { ...ctx, marksShown: false, gridShown: true, dragStarted: true }
          : e.gate === 'autoscroll'
            ? { ...ctx, autoScrolling: true }
            : ctx
      expect(parseCommand(example, c), `${e.id}: "${example}"`).not.toBeNull()
    }
  })

  it('scores fixed phrases above slots and homophones lowest', () => {
    expect(parseCommand('select all')!.confidence).toBe(1)
    expect(parseCommand('scroll down')!.confidence).toBe(0.9)
    expect(parseCommand('click to', MARKS)!.confidence).toBe(0.8)
  })

  it('parses in well under 2 ms', () => {
    const corpus = [...POSITIVE.map((r) => r[0]), ...NEGATIVE.map((r) => r[0])]
    for (const u of corpus) parseCommand(u)
    const runs = 20
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) for (const u of corpus) parseCommand(u, MARKS)
    const perParse = (performance.now() - t0) / (runs * corpus.length)
    expect(perParse).toBeLessThan(2)
  })

  it('normalizes fillers, punctuation and hyphens', () => {
    expect(normalize('Hey Lumen, could you scroll-down? Thanks!')).toBe('scroll down')
    expect(normalize("Don't")).toBe('dont')
  })

  it('builds a help sheet that hides gated commands outside their state', () => {
    const idle = commandSheet(IDLE_CONTEXT).map((r) => r.say)
    expect(idle).toContain('show numbers')
    expect(idle).not.toContain('hide numbers')
    expect(commandSheet(MARKS).map((r) => r.say)).toContain('hide numbers')
    expect(commandSheet().length).toBeGreaterThan(40)
  })
})

describe('numbers and keys', () => {
  it.each([
    ['5', 5],
    ['twelve', 12],
    ['forty two', 42],
    ['third', 3],
    ['3rd', 3],
    ['two hundred', 200],
    ['one hundred and five', 105]
  ])('%s = %d', (t, n) => expect(parseNumber(t)?.value).toBe(n))

  it('flags homophones', () => {
    expect(parseNumber('to')).toEqual({ value: 2, homophone: true })
    expect(parseNumber('banana')).toBeNull()
  })

  it.each([
    ['control shift t', 'ctrl+shift+t'],
    ['ctrl plus s', 'ctrl+s'],
    ['windows d', 'win+d'],
    ['f 4', 'f4'],
    ['up arrow', 'up'],
    ['windows', 'win']
  ])('%s → %s', (spoken, combo) => expect(parseKeys(spoken)?.join('+')).toBe(combo))

  it('rejects non-keys and bare modifiers', () => {
    expect(parseKeys('the button')).toBeNull()
    expect(parseKeys('shift')).toBeNull()
    expect(parseKeys('a b')).toBeNull()
  })
})

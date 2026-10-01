// Settings → Voice: how dictation types (04 T34-T42): corrections, formatting, command mode,
// a style per kind of app, voice snippets, the dictionary (per app, spell-as, export /
// import), names from the screen and coding mode.
import { useCallback, useEffect, useState } from 'react'
import type { DictationSnippet } from '@shared/channels'
import {
  DICTATION_APP_KINDS,
  DICTATION_STYLE_DEFAULTS,
  type DictationAppKind,
  type DictationStyle
} from '@shared/config'
import { Button, Card, Select, Switch, TextField, announce, icons } from '../../../ui'
import type { SectionProps } from '../meta'
import {
  appDictionaryFromText,
  appDictionaryToText,
  spellAsFromText,
  spellAsToText,
  styleAppsFromText,
  styleAppsToText
} from './dictation-text'

const KIND_LABELS: Record<DictationAppKind, string> = {
  email: 'Email',
  work: 'Work chat (Slack, Teams)',
  personal: 'Personal chat (WhatsApp, Discord)',
  docs: 'Documents (Word, Notion)',
  code: 'Code editors and terminals',
  other: 'Other apps'
}

const STYLE_OPTIONS: { value: DictationStyle; label: string }[] = [
  { value: 'formal', label: 'Formal: capitals and full stops' },
  { value: 'casual', label: 'Casual: no full stop after one line' },
  { value: 'very-casual', label: 'Very casual: lowercase, no full stop' },
  { value: 'code', label: 'Code: no capital at the start' },
  { value: 'off', label: 'As cleaned up' }
]

type Draft = Omit<DictationSnippet, 'id'> & { id?: string; key: number }

let keySeq = 0

function Snippets(): JSX.Element {
  const [list, setList] = useState<Draft[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    window.lumen
      .invoke('dictation:snippets')
      .then((s) => setList(s.map((x) => ({ ...x, key: ++keySeq }))))
      .catch(() => {})
  }, [])

  const save = useCallback((next: Draft[]) => {
    setList(next)
    const complete = next
      .filter((s) => s.trigger.trim().length >= 2 && s.text.length > 0)
      .map(({ id, trigger, text }) => ({ ...(id ? { id } : {}), trigger, text }))
    void window.lumen.invoke('dictation:snippets-save', complete).then((r) => {
      if ('error' in r && !('ok' in r)) {
        setError('Could not save the snippets.')
        return
      }
      if (!r.ok || !r.snippets) {
        setError(r.error ?? 'Could not save the snippets.')
        return
      }
      setError('')
      const saved = r.snippets
      // Keep rows still being typed; give saved rows their ids.
      setList((cur) =>
        cur.map((d) => {
          const hit = saved.find((s) => s.trigger === d.trigger.trim() && s.text === d.text)
          return hit ? { ...d, id: hit.id } : d
        })
      )
      announce('Saved')
    })
  }, [])

  const update = (key: number, change: Partial<Draft>): void =>
    save(list.map((d) => (d.key === key ? { ...d, ...change } : d)))

  return (
    <Card
      title="Snippets"
      description="Say a phrase while dictating and saved text is typed instead, for example “insert my calendar link”."
    >
      {list.length > 0 && (
        <ul className="panel-list" aria-label="Snippets">
          {list.map((s) => (
            <li key={s.key}>
              <TextField
                label="When I say"
                value={s.trigger}
                placeholder="my calendar link"
                accept={(v) => v.trim().length >= 2}
                commitOnBlurOnly
                onCommit={(trigger) => update(s.key, { trigger })}
              />
              <TextField
                label="Type"
                multiline
                value={s.text}
                commitOnBlurOnly
                onCommit={(text) => update(s.key, { text })}
                hint="{date}, {time}, {day} and {clipboard} are filled in when typed."
              />
              <Button
                variant="quiet"
                icon={icons.trash}
                onClick={() => save(list.filter((d) => d.key !== s.key))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="ui-hint" role="alert">
          {error}
        </p>
      )}
      <Button
        onClick={() => setList([...list, { trigger: '', text: '', key: ++keySeq }])}
        disabled={list.length >= 200}
      >
        Add snippet
      </Button>
    </Card>
  )
}

function DictionaryFile(): JSX.Element {
  const [message, setMessage] = useState('')
  const run = async (which: 'export' | 'import'): Promise<void> => {
    const r = await window.lumen.invoke(`dictation:dictionary-${which}`)
    if ('error' in r && !('ok' in r)) return setMessage('That did not work.')
    if (!r.ok) return setMessage(r.error === 'cancelled' ? '' : (r.error ?? 'That did not work.'))
    const added = 'added' in r ? r.added : undefined
    const text =
      which === 'export'
        ? 'Dictionary exported.'
        : `Dictionary imported${added !== undefined ? `: ${added} new` : ''}.`
    setMessage(text)
    announce(text)
  }
  return (
    <>
      <div className="panel-row">
        <Button icon={icons.download} onClick={() => void run('export')}>
          Export dictionary…
        </Button>
        <Button onClick={() => void run('import')}>Import dictionary…</Button>
      </div>
      {message && <p className="ui-hint">{message}</p>}
    </>
  )
}

export function DictationSettings({ cfg, patch }: SectionProps): JSX.Element {
  const d = cfg.dictation
  const styles = { ...DICTATION_STYLE_DEFAULTS, ...d.styles }
  return (
    <>
      <Card
        title="Dictation"
        description={`Hold ${d.hotkey || 'the dictation key'} and speak to type.`}
      >
        <Switch
          checked={d.backtrack}
          onChange={(backtrack) => patch({ dictation: { backtrack } })}
          label="Apply spoken corrections"
          hint="“Send it Tuesday, actually Wednesday” types “Send it Wednesday”. “Scratch that” drops the sentence."
        />
        <Switch
          checked={d.format}
          onChange={(format) => patch({ dictation: { format } })}
          label="Format lists, numbers and addresses"
          hint="“First … second …” becomes a numbered list, “twenty five dollars” $25, “name at example dot com” an email address."
        />
        <Switch
          checked={d.commandMode}
          onChange={(commandMode) => patch({ dictation: { commandMode } })}
          label="Edit selected text by voice"
          hint="Select text, hold the dictation key and say “make this friendlier”, “shorter” or “translate to Spanish”. An Undo button appears after each edit."
        />
        <Switch
          checked={d.snippets}
          onChange={(snippets) => patch({ dictation: { snippets } })}
          label="Expand snippets"
        />
      </Card>

      <Card
        title="Dictation style"
        description="Changes capitals and full stops for each kind of app, never your words."
      >
        {DICTATION_APP_KINDS.map((kind) => (
          <Select
            key={kind}
            label={KIND_LABELS[kind]}
            value={styles[kind]}
            options={STYLE_OPTIONS}
            onChange={(style) => patch({ dictation: { styles: { ...styles, [kind]: style } } })}
          />
        ))}
        <TextField
          label="Put an app or website in a kind"
          multiline
          value={styleAppsToText(d.styleApps)}
          commitOnBlurOnly
          onCommit={(text) => patch({ dictation: { styleApps: styleAppsFromText(text) } })}
          hint="One per line, for example: basecamp = work, or signal.exe = personal. Kinds: email, work, personal, docs, code, other."
        />
      </Card>

      <Card
        title="Dictionary"
        description="Spellings Lumen should know. Names you correct twice are added to the personal dictionary above by themselves."
      >
        <TextField
          label="Spell as"
          multiline
          value={spellAsToText(d.spellAs)}
          commitOnBlurOnly
          onCommit={(text) => patch({ dictation: { spellAs: spellAsFromText(text) } })}
          hint="One per line: what you say = how to write it, for example: cube control = kubectl."
        />
        <TextField
          label="Words for one app"
          multiline
          value={appDictionaryToText(d.appDictionary)}
          commitOnBlurOnly
          onCommit={(text) => patch({ dictation: { appDictionary: appDictionaryFromText(text) } })}
          hint="One app per line: figma: Auto layout, Frame. The app is a program (figma.exe) or a word in the window title."
        />
        <Switch
          checked={d.screenNames}
          onChange={(screenNames) => patch({ dictation: { screenNames } })}
          label="Spell names the way they appear on screen"
          hint="Reads the window you dictate into, on this PC only, so names in the email or chat you reply to come out right. Nothing is saved or sent. Off in private mode."
        />
        <DictionaryFile />
      </Card>

      <Card title="Coding" description="In code editors, terminals and Claude Code.">
        <Switch
          checked={d.codingMode}
          onChange={(codingMode) => patch({ dictation: { codingMode } })}
          label="Coding mode"
          hint="“camel case user name” types userName (also snake, kebab, pascal and constant case), “open paren”, “dot” and “equals” type symbols, and “at file pipeline dot ts” types @pipeline.ts. Start with “to Claude, …” to send the dictation to your open Claude Code session."
        />
      </Card>

      {d.snippets && <Snippets />}
    </>
  )
}

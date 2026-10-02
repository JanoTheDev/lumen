// The buddy editor (08 T53), shared by the "Make a buddy" review card and a buddy's page:
// name, look, instructions, what it may do (wider ones marked), model, budget, report style,
// skills and helpers. Controlled: nothing is saved here.
import { useId, useState } from 'react'
import type { BuddyBudget, BuddyPermissions } from '@shared/buddies'
import type { BuddyEditable } from '@shared/buddy-views'
import { Field, NumberField, SegmentedControl, Select, Switch } from '../../../ui'
import { BuddiesAvatar } from './BuddiesAvatar'
import {
  BUDDY_COLORS,
  BUDDY_TOOLS,
  MODEL_OPTIONS,
  REPORT_OPTIONS,
  avatarText,
  lookFromText,
  parseList,
  permissionRows
} from './buddies-view'

/** A list typed one per line (or comma); committed on blur so typing is never reshaped. */
function ListField({
  label,
  hint,
  value,
  onChange,
  placeholder
}: {
  label: string
  hint?: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}): JSX.Element {
  // null = not being edited: show the saved list.
  const [text, setText] = useState<string | null>(null)
  return (
    <Field label={label} hint={hint}>
      {(a) => (
        <textarea
          {...a}
          className="ui-input ui-input--multi"
          rows={Math.min(5, Math.max(2, value.length + 1))}
          spellCheck={false}
          placeholder={placeholder}
          value={text ?? value.join('\n')}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text !== null) onChange(parseList(text))
            setText(null)
          }}
        />
      )}
    </Field>
  )
}

export function PermissionList({
  permissions,
  before
}: {
  permissions: BuddyPermissions
  before?: BuddyPermissions
}): JSX.Element {
  const rows = permissionRows(permissions, before)
  return (
    <ul className="bd-perms" aria-label="What it may do">
      {rows.map((r) => (
        <li key={r.key} className={r.wider ? 'bd-perm is-wider' : 'bd-perm'}>
          {r.wider && <span className="bd-perm__tag">{before ? 'New' : 'Check'}</span>}
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  )
}

export interface BuddiesFieldsProps {
  value: BuddyEditable
  onChange: (next: BuddyEditable) => void
  /** The saved permissions: what grew is marked "New". Without it, wider ones say "Check". */
  before?: BuddyPermissions
}

export function BuddiesFields({ value, onChange, before }: BuddiesFieldsProps): JSX.Element {
  const id = useId()
  const set = (p: Partial<BuddyEditable>): void => onChange({ ...value, ...p })
  const perms = value.permissions
  const setPerms = (p: Partial<BuddyPermissions>): void => set({ permissions: { ...perms, ...p } })
  const setBudget = (p: Partial<BuddyBudget>): void => {
    const next: BuddyBudget = { ...value.budget, ...p }
    // 0 = no monthly limit.
    if (!next.perMonthUsd) delete next.perMonthUsd
    if (!next.perMonthTokens) delete next.perMonthTokens
    set({ budget: next })
  }
  // null = not being edited: show the saved emoji or letter.
  const [mark, setMark] = useState<string | null>(null)
  const colorKnown = BUDDY_COLORS.some((c) => c.value === value.look.color)
  const colors = colorKnown
    ? BUDDY_COLORS
    : [...BUDDY_COLORS, { value: value.look.color, label: 'Its own colour' }]

  return (
    <div className="bd-fields">
      <Field label="Name">
        {(a) => (
          <input
            {...a}
            className="ui-input"
            type="text"
            maxLength={40}
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </Field>

      <div className="bd-look">
        <BuddiesAvatar look={value.look} name={value.name} size="lg" />
        <SegmentedControl
          label="Colour"
          value={value.look.color}
          options={colors.map((c) => ({ ...c, swatch: c.value }))}
          onChange={(color) => set({ look: { ...value.look, color } })}
        />
        <Field label="Emoji or letter">
          {(a) => (
            <input
              {...a}
              className="ui-input bd-look__mark"
              type="text"
              maxLength={8}
              value={mark ?? avatarText(value.look, value.name)}
              onChange={(e) => setMark(e.target.value)}
              onBlur={() => {
                if (mark !== null) set({ look: lookFromText(mark, value.look.color, value.name) })
                setMark(null)
              }}
            />
          )}
        </Field>
      </div>

      <Field label="Instructions" hint="What it is for, how it should work and what to report.">
        {(a) => (
          <textarea
            {...a}
            className="ui-input ui-input--multi"
            rows={8}
            maxLength={8000}
            value={value.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
          />
        )}
      </Field>

      <section className="bd-block" aria-labelledby={`${id}-perms`}>
        <h3 id={`${id}-perms`} className="bd-block__title">
          What it may do
        </h3>
        <PermissionList permissions={perms} before={before} />
        <details className="panel-details">
          <summary>Change what it may do</summary>
          <fieldset className="bd-tools">
            <legend className="ui-field__label">Tools</legend>
            {BUDDY_TOOLS.map((t) => (
              <label key={t.value} className="panel-row">
                <input
                  type="checkbox"
                  checked={perms.tools.includes(t.value)}
                  onChange={(e) =>
                    setPerms({
                      tools: e.target.checked
                        ? [...perms.tools, t.value]
                        : perms.tools.filter((x) => x !== t.value)
                    })
                  }
                />
                {t.label}
              </label>
            ))}
          </fieldset>
          <ListField
            label="Websites"
            hint="One per line, https only, like https://www.example.com."
            value={perms.network}
            onChange={(network) => setPerms({ network })}
          />
          <ListField
            label="Folders it may read"
            hint="Full paths, one per line."
            value={perms.files.read}
            onChange={(read) => setPerms({ files: { ...perms.files, read } })}
          />
          <ListField
            label="Folders it may change"
            value={perms.files.write}
            onChange={(write) => setPerms({ files: { ...perms.files, write } })}
          />
          <ListField
            label="Connectors"
            hint="Connector ids from Settings → Connectors."
            value={perms.connectors}
            onChange={(connectors) => setPerms({ connectors })}
          />
          <Switch
            checked={perms.input}
            onChange={(input) => setPerms({ input, apps: input ? perms.apps : [] })}
            label="Use the mouse and keyboard"
            hint="Only on screen, and only while you are around."
          />
          {perms.input && (
            <ListField
              label="Only in these apps"
              hint="App ids, one per line. Empty means any app."
              value={perms.apps}
              onChange={(apps) => setPerms({ apps })}
            />
          )}
          <Switch
            checked={perms.screen}
            onChange={(screen) => setPerms({ screen })}
            label="May ask to work on screen"
          />
          <Switch
            checked={perms.profile}
            onChange={(profile) => setPerms({ profile })}
            label="Read my saved profile"
            hint="Name, address and email, for filling in forms."
          />
          <Switch
            checked={perms.risky}
            onChange={(risky) => setPerms({ risky })}
            label="Ask before every action"
          />
        </details>
      </section>

      <SegmentedControl
        label="Model"
        value={value.model}
        options={MODEL_OPTIONS}
        onChange={(model) => set({ model })}
        hint="Fast is cheaper; Main and Planning think harder."
      />

      <div className="bd-budget">
        <NumberField
          label="Cost per run"
          value={value.budget.perRunUsd}
          min={0.01}
          max={5}
          step={0.01}
          unit="USD"
          hint="A run pauses and asks before going past it."
          onCommit={(perRunUsd) => setBudget({ perRunUsd })}
        />
        <NumberField
          label="Cost per month"
          value={value.budget.perMonthUsd ?? 0}
          min={0}
          max={1000}
          step={0.5}
          unit="USD"
          hint="0 means no monthly limit."
          onCommit={(perMonthUsd) => setBudget({ perMonthUsd })}
        />
        <NumberField
          label="Tokens per month"
          value={value.budget.perMonthTokens ?? 0}
          min={0}
          max={1_000_000_000}
          step={10_000}
          hint="0 means no token limit."
          onCommit={(perMonthTokens) => setBudget({ perMonthTokens: Math.round(perMonthTokens) })}
        />
      </div>

      <Select
        label="When it finishes"
        value={value.report}
        options={REPORT_OPTIONS}
        onChange={(report) => set({ report })}
      />

      <ListField
        label="Skills it may use"
        hint="Skill names, one per line."
        value={value.skills}
        onChange={(skills) => set({ skills })}
      />

      <Switch
        checked={value.subagents}
        onChange={(subagents) => set({ subagents })}
        label="May use helpers"
        hint="Splits big jobs into helpers that work at the same time. Their cost counts toward its budget."
      />
    </div>
  )
}

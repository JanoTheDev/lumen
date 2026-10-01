// Reply styles ("modes") in Settings → Skills: pick how Lumen words its answers, spoken replies
// and descriptions, and the level for styles that have levels. The same as saying "turn on
// brief mode" / "normal mode". A style only changes wording, never what Lumen may do.
import { useCallback, useEffect, useState } from 'react'
import { spokenStyleName, type ActiveStyle, type StyleInfo } from '@shared/styles'
import { Card, Select, announce } from '../../../ui'
import { invoke, useIpc } from '../../../lib/ipc'

const NONE = '__none__'

export function SkillsStyles({ refreshKey }: { refreshKey?: unknown }): JSX.Element | null {
  const [styles, setStyles] = useState<StyleInfo[]>([])
  const [active, setActive] = useState<ActiveStyle | null>(null)
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    invoke('styles:list')
      .then((r) => {
        setStyles(r.styles)
        setActive(r.active)
      })
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh, refreshKey])
  useIpc('settings:changed', refresh)

  const set = async (next: ActiveStyle | null): Promise<void> => {
    const r = await invoke('styles:set', next)
    const text =
      'ok' in r && r.ok
        ? next
          ? `${spokenStyleName(next.name)} style on${next.level ? `, level ${next.level}` : ''}`
          : 'Normal wording'
        : `Not changed: ${'error' in r ? r.error : ''}`
    setMsg(text)
    announce(text)
    refresh()
  }

  if (!styles.length) return null
  const current = styles.find((s) => s.name === active?.name)
  const usable = styles.filter((s) => s.enabled)

  return (
    <Card
      title="Reply style"
      description="How Lumen words answers, spoken replies and screen descriptions. A style only changes the wording: never what Lumen does, its safety checks or its questions before acting. Say “turn on brief mode”, “normal mode” or “what mode am I in”."
    >
      <Select
        label="Style"
        value={current ? current.name : NONE}
        options={[
          { value: NONE, label: 'Normal' },
          ...usable.map((s) => ({
            value: s.name,
            label: `${spokenStyleName(s.name)}${s.trust === 'community-untrusted' ? ' (community, untrusted: kept short)' : ''}`
          }))
        ]}
        hint={current?.description}
        onChange={(v) => void set(v === NONE ? null : { name: v })}
      />
      {current && current.levels.length > 1 && (
        <Select
          label="Level"
          value={active?.level ?? current.levels[0]}
          options={current.levels.map((l) => ({ value: l, label: l }))}
          onChange={(level) => void set({ name: current.name, level })}
        />
      )}
      <p className="ui-hint">
        Make your own: say “make a style that talks like a pirate”, then “save it”. Styles are
        skills with <code>kind: style</code>, so they show in the list above and can be switched
        off, shared and imported like any skill.
      </p>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
    </Card>
  )
}

// Paste, save and test one API key. Used by onboarding and Settings → Models.
// Services: Anthropic, OpenAI, Gemini (free tier, after its privacy note) and any
// OpenAI-compatible service (a preset or a custom address).
import { useCallback, useEffect, useState } from 'react'
import type { KeyProvider, KeyStatus } from '@shared/channels'
import { COMPATIBLE_PRESETS, SERVICE_URL_RE, type CompatiblePreset } from '@shared/config'
import { COMPATIBLE_PRESET_INFO, GEMINI_FREE_TIER_NOTE } from '@shared/model-providers'
import {
  Button,
  Field,
  Select,
  SegmentedControl,
  Switch,
  TextField,
  announce,
  icons
} from '../../../ui'
import { invoke, send } from '../../../lib/ipc'
import { KEY_LINKS, guessPreset, guessProvider, looksLikeKey } from '../../onboarding/flow'
import { keyLinkFor, presetLabel, PROVIDER_NAME } from './models-view'

export interface KeyFormProps {
  /** Whether Lumen has a usable key (or none is needed). */
  onReady?: (ready: boolean) => void
  /** After a key was saved and tested OK. */
  onSaved?: (provider: KeyProvider) => void
  /** Current compatible-service settings (from config), so the form starts on them. */
  compatible?: { preset: CompatiblePreset; baseUrl?: string } | null
  /** The Gemini privacy note was already accepted. */
  geminiAck?: boolean
}

const SERVICE_OPTIONS: { value: KeyProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (ChatGPT)' },
  { value: 'gemini', label: 'Gemini (free)' },
  { value: 'compatible', label: 'Other service' }
]

export function KeyForm({ onReady, onSaved, compatible, geminiAck }: KeyFormProps): JSX.Element {
  const [status, setStatus] = useState<KeyStatus[] | null>(null)
  const [provider, setProvider] = useState<KeyProvider>('anthropic')
  const [preset, setPreset] = useState<CompatiblePreset>(compatible?.preset ?? 'openrouter')
  const [baseUrl, setBaseUrl] = useState(compatible?.baseUrl ?? '')
  const [ack, setAck] = useState(!!geminiAck)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  // After a new OpenAI-compatible key: the service's models, to pick the one Lumen uses.
  const [models, setModels] = useState<{ value: string; label: string }[] | null>(null)
  const [picked, setPicked] = useState('')

  const refresh = useCallback((): void => {
    invoke('keys:status')
      .then(setStatus)
      .catch(() => setStatus([]))
  }, [])
  useEffect(refresh, [refresh])

  const existing = (status ?? []).filter((s) => s.set)
  useEffect(() => onReady?.(existing.length > 0), [existing.length, onReady])

  const needsAck = provider === 'gemini' && !ack
  const needsUrl = provider === 'compatible' && preset === 'custom' && !SERVICE_URL_RE.test(baseUrl)
  const canSave = !busy && !needsAck && !needsUrl && looksLikeKey(provider, key)

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setResult(null)
    try {
      // The test call reads the service address from the settings, so they go first.
      if (provider === 'compatible')
        await invoke('settings:patch', {
          models: { compatible: { preset, baseUrl: preset === 'custom' ? baseUrl.trim() : '' } }
        })
      if (provider === 'gemini') await invoke('settings:patch', { models: { geminiAck: true } })
      const set = await invoke('keys:set', { provider, key: key.trim() })
      if (!set.ok) throw new Error(set.error ?? 'That key wasn’t accepted.')
      const test = await invoke('keys:test', provider)
      const text = test.ok
        ? set.persisted
          ? 'Key works. It’s saved, encrypted, on this PC.'
          : 'Key works, but Windows encryption isn’t available, so it lasts until Lumen closes.'
        : (test.error ?? 'That key didn’t work.')
      setResult({ ok: test.ok, text })
      announce(text, test.ok ? 'polite' : 'assertive')
      if (test.ok) {
        setKey('')
        setAdding(false)
        onSaved?.(provider)
        if (provider === 'compatible') {
          const c = await invoke('models:catalog', { refresh: true })
          const list =
            'providers' in c ? c.providers.find((p) => p.id === 'compatible')?.models : []
          setModels((list ?? []).map((m) => ({ value: m.id, label: m.label })))
        }
      }
      refresh()
    } catch (e) {
      const text = (e as Error).message
      setResult({ ok: false, text })
      announce(text, 'assertive')
    } finally {
      setBusy(false)
    }
  }

  const link = keyLinkFor(provider, preset, KEY_LINKS)

  return (
    <div className="panel-stack">
      {existing.map((k) => (
        <div key={k.provider} className="panel-note is-ok" role="status">
          <icons.checkCircle />
          <span>
            {PROVIDER_NAME[k.provider]}
            {k.provider === 'compatible' && compatible
              ? ` (${presetLabel(compatible.preset)})`
              : ''}{' '}
            key{k.last4 ? ` ending in ${k.last4}` : ''}
            {k.source === 'env' ? ' (from the .env file)' : ''}
            {k.paused ? ', set aside while Local only is on' : ''}.
          </span>
          {k.source === 'vault' && (
            <Button
              variant="quiet"
              icon={icons.trash}
              onClick={() => {
                invoke('keys:clear', k.provider)
                  .then(() => {
                    setResult(null)
                    announce('Key removed')
                    refresh()
                  })
                  .catch(() => {})
              }}
            >
              Remove
            </Button>
          )}
        </div>
      ))}

      {existing.length > 0 && !adding ? (
        <div className="panel-row">
          <Button variant="quiet" icon={icons.key} onClick={() => setAdding(true)}>
            Add or replace a key
          </Button>
        </div>
      ) : (
        <>
          <SegmentedControl
            label="Service"
            value={provider}
            options={SERVICE_OPTIONS}
            onChange={(p) => {
              setProvider(p)
              setResult(null)
            }}
          />

          {provider === 'gemini' && (
            <div className="panel-stack" role="group" aria-label="Gemini free tier privacy">
              <p className="panel-warn">
                <icons.alert />
                <span>{GEMINI_FREE_TIER_NOTE}</span>
              </p>
              <Switch
                checked={ack}
                onChange={setAck}
                label="I understand, and I’m 18 or older"
                hint="Needed before a Gemini key can be saved."
              />
            </div>
          )}

          {provider === 'compatible' && (
            <>
              <Select
                label="Which service"
                value={preset}
                options={COMPATIBLE_PRESETS.map((p) => ({ value: p, label: presetLabel(p) }))}
                hint={
                  preset === 'custom'
                    ? 'Any service that speaks the OpenAI chat API.'
                    : COMPATIBLE_PRESET_INFO[preset].baseUrl
                }
                onChange={setPreset}
              />
              {preset === 'custom' && (
                <TextField
                  label="Service address (base URL)"
                  value={baseUrl}
                  placeholder="https://example.com/v1"
                  accept={(v) => v === '' || SERVICE_URL_RE.test(v)}
                  onCommit={setBaseUrl}
                  announceSave={false}
                  mono
                />
              )}
            </>
          )}

          <Field
            label="API key"
            hint={
              <>
                Paste the key here. It’s stored encrypted on this PC and never shown again.{' '}
                {link && (
                  <button
                    type="button"
                    className="panel-link"
                    onClick={() => send('assistant:open-link', link)}
                  >
                    Where do I get a{' '}
                    {provider === 'compatible' ? presetLabel(preset) : PROVIDER_NAME[provider]} key?
                  </button>
                )}
              </>
            }
            error={result && !result.ok ? result.text : undefined}
          >
            {(a) => (
              <input
                {...a}
                type="password"
                className="ui-input ui-input--mono"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  const guess = guessProvider(e.target.value)
                  if (guess) setProvider(guess)
                  const p = guessPreset(e.target.value)
                  if (p) setPreset(p)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                }}
              />
            )}
          </Field>
          <div className="panel-row">
            <Button
              variant="primary"
              icon={icons.key}
              busy={busy}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {busy ? 'Checking…' : 'Save and test'}
            </Button>
            {existing.length > 0 && (
              <Button variant="quiet" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        </>
      )}

      {result?.ok && (
        <p className="panel-ok" role="status">
          <icons.checkCircle /> {result.text}
        </p>
      )}

      {models && (
        <Select
          label="Model to use"
          value={picked}
          hint={
            models.length
              ? 'Lumen uses this model for every job on this service. You can change it per job in Settings → Models & keys.'
              : 'The service didn’t list its models. Set one in Settings → Models & keys.'
          }
          options={[{ value: '', label: 'Pick a model…' }, ...models]}
          onChange={(model) => {
            setPicked(model)
            void invoke('settings:patch', {
              models: {
                compatible: { preset, baseUrl: preset === 'custom' ? baseUrl.trim() : '', model }
              }
            }).then(() => announce('Saved'))
          }}
        />
      )}
    </div>
  )
}

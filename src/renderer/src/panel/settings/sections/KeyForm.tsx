// Paste, save and test one API key. Used by onboarding and Settings → Models.
import { useCallback, useEffect, useState } from 'react'
import type { KeyProvider, KeyStatus } from '@shared/channels'
import { Button, Field, SegmentedControl, announce, icons } from '../../../ui'
import { invoke, send } from '../../../lib/ipc'
import { KEY_LINKS, guessProvider, looksLikeKey } from '../../onboarding/flow'

const PROVIDER_NAME: Record<KeyProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

export interface KeyFormProps {
  /** Whether Lumen has a usable key (or none is needed). */
  onReady?: (ready: boolean) => void
  /** After a key was saved and tested OK. */
  onSaved?: () => void
}

export function KeyForm({ onReady, onSaved }: KeyFormProps): JSX.Element {
  const [status, setStatus] = useState<KeyStatus[] | null>(null)
  const [provider, setProvider] = useState<KeyProvider>('anthropic')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [replace, setReplace] = useState(false)

  const refresh = useCallback((): void => {
    invoke('keys:status')
      .then(setStatus)
      .catch(() => setStatus([]))
  }, [])
  useEffect(refresh, [refresh])

  const existing = status?.find((s) => s.set)
  useEffect(() => onReady?.(!!existing), [existing, onReady])

  const save = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
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
        setReplace(false)
        onSaved?.()
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

  return (
    <div className="panel-stack">
      {existing && !replace ? (
        <div className="panel-note is-ok" role="status">
          <icons.checkCircle />
          <span>
            Lumen already has a {PROVIDER_NAME[existing.provider]} key
            {existing.last4 ? ` ending in ${existing.last4}` : ''}
            {existing.source === 'env' ? ' (from the .env file)' : ''}.
          </span>
          <Button variant="quiet" onClick={() => setReplace(true)}>
            Use a different key
          </Button>
          {existing.source === 'vault' && (
            <Button
              variant="quiet"
              icon={icons.trash}
              onClick={() => {
                invoke('keys:clear', existing.provider)
                  .then(() => {
                    setResult(null)
                    announce('Key removed')
                    refresh()
                  })
                  .catch(() => {})
              }}
            >
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <>
          <SegmentedControl
            label="Service"
            value={provider}
            options={[
              { value: 'anthropic', label: 'Anthropic (Claude)' },
              { value: 'openai', label: 'OpenAI' }
            ]}
            onChange={setProvider}
          />
          <Field
            label="API key"
            hint={
              <>
                Paste the key here. It’s stored encrypted on this PC and never shown again.{' '}
                <button
                  type="button"
                  className="panel-link"
                  onClick={() => send('assistant:open-link', KEY_LINKS[provider])}
                >
                  Where do I get a {PROVIDER_NAME[provider]} key?
                </button>
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
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && looksLikeKey(provider, key)) void save()
                }}
              />
            )}
          </Field>
          <div className="panel-row">
            <Button
              variant="primary"
              icon={icons.key}
              busy={busy}
              disabled={busy || !looksLikeKey(provider, key)}
              onClick={() => void save()}
            >
              {busy ? 'Checking…' : 'Save and test'}
            </Button>
          </div>
        </>
      )}

      {result?.ok && (
        <p className="panel-ok" role="status">
          <icons.checkCircle /> {result.text}
        </p>
      )}
    </div>
  )
}

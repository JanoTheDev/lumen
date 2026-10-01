// Settings → Models & keys: where the AI runs (Local only, preferred service), keys, the
// OpenAI-compatible service's default model, the local server, and a provider + model per job.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelRoleId, ModelsCatalog } from '@shared/channels'
import { MODEL_ID_RE, type ModelProvider } from '@shared/config'
import { Button, Card, Select, Switch, TextField, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'
import type { SectionProps } from '../meta'
import { KeyForm } from './KeyForm'
import { ModelsCost } from './ModelsCost'
import {
  ROLE_INFO,
  ROLE_ORDER,
  modelOptionLabel,
  modelOptions,
  providerOptions,
  roleLine
} from './models-view'

// Older per-role model ids the new per-role choice replaces.
const LEGACY_KEYS: Record<ModelRoleId, ('main' | 'fast' | 'planning' | 'verify')[]> = {
  main: ['main'],
  fast: ['fast', 'verify'],
  planning: ['planning'],
  vision: []
}

function useCatalog(): [ModelsCatalog | null, (refresh?: boolean) => void] {
  const [catalog, setCatalog] = useState<ModelsCatalog | null>(null)
  const load = useCallback((refresh = false): void => {
    invoke('models:catalog', { refresh })
      .then((c) => {
        if (c && 'providers' in c) setCatalog(c)
      })
      .catch(() => {})
  }, [])
  useEffect(() => load(true), [load])
  return [catalog, load]
}

function RoleRow({
  role,
  catalog,
  cfg,
  patch
}: SectionProps & { role: ModelRoleId; catalog: ModelsCatalog }): JSX.Element {
  const choice = cfg.models.roles?.[role]
  const provider = choice?.provider ?? 'auto'
  const model = choice?.model ?? ''
  const info = ROLE_INFO[role]
  const set = (next: { provider: ModelProvider | 'auto'; model: string }): void => {
    const legacy = Object.fromEntries(LEGACY_KEYS[role].map((k) => [k, '']))
    void patch({ models: { ...legacy, roles: { [role]: next } } })
  }
  const p = catalog.providers.find((x) => x.id === provider)
  return (
    <div className="panel-stack" role="group" aria-label={`${info.label} model`}>
      <div className="panel-row panel-row--end">
        <Select
          label={info.label}
          value={provider}
          hint={info.hint}
          options={providerOptions(catalog, provider)}
          onChange={(v) => set({ provider: v as ModelProvider | 'auto', model: '' })}
        />
        {provider !== 'auto' && (
          <Select
            label={`${info.label} model`}
            value={model}
            options={modelOptions(p, model)}
            onChange={(v) => set({ provider, model: v })}
          />
        )}
      </div>
      <p className="ui-hint">{roleLine(catalog, role)}</p>
    </div>
  )
}

function CompatibleModel({
  catalog,
  cfg,
  patch
}: SectionProps & { catalog: ModelsCatalog }): JSX.Element | null {
  const c = cfg.models.compatible
  const p = catalog.providers.find((x) => x.id === 'compatible')
  if (!c || !p) return null
  const current = c.model ?? ''
  const commit = (model: string): void => void patch({ models: { compatible: { ...c, model } } })
  return (
    <Card
      title={p.label}
      description="The model this service uses when a job doesn’t name one. OpenRouter lists its prices; other services’ prices aren’t known to Lumen, so they’re left out of the cost estimate, and the task spending caps count them at a typical cloud price."
    >
      {p.models.length ? (
        <Select
          label="Default model"
          value={current}
          options={[
            { value: '', label: 'Pick a model…' },
            ...p.models.map((m) => ({ value: m.id, label: modelOptionLabel(p, m) })),
            ...(current && !p.models.some((m) => m.id === current)
              ? [{ value: current, label: current }]
              : [])
          ]}
          onChange={commit}
        />
      ) : (
        <TextField
          label="Default model"
          value={current}
          hint="The service didn’t list its models (check the key). Type the model name from its docs."
          accept={(v) => v === '' || MODEL_ID_RE.test(v)}
          onCommit={commit}
          mono
        />
      )}
    </Card>
  )
}

function LocalCard({
  catalog,
  reload
}: {
  catalog: ModelsCatalog
  reload: (refresh?: boolean) => void
}): JSX.Element {
  const p = catalog.providers.find((x) => x.id === 'local')
  return (
    <Card
      title="On this PC"
      description="Ollama and LM Studio are found on their own, no setup. Free and private, slower than a cloud model. Models without tool use do multi-step tasks in one step."
    >
      {catalog.local && p ? (
        <>
          <p className="panel-note is-ok" role="status">
            <icons.checkCircle />
            <span>
              {p.label} at {catalog.local.baseUrl}: {p.models.length}{' '}
              {p.models.length === 1 ? 'model' : 'models'}.
            </span>
          </p>
          <ul className="panel-list">
            {p.models.map((m) => (
              <li key={m.id}>{modelOptionLabel({ ...p, free: false }, m)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="ui-hint">No Ollama or LM Studio running right now.</p>
      )}
      <div className="panel-row">
        <Button variant="quiet" icon={icons.repeat} onClick={() => reload(true)}>
          Look again
        </Button>
      </div>
    </Card>
  )
}

export function Models({ cfg, patch }: SectionProps): JSX.Element {
  const [catalog, reload] = useCatalog()
  const localOnly = cfg.models.localOnly === true
  // What each job resolves to changes with every models setting.
  const modelsKey = JSON.stringify(cfg.models)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else reload(localOnly)
  }, [modelsKey, localOnly, reload])
  return (
    <>
      <Card
        title="Where the AI runs"
        description="One key is enough. Lumen picks the right model for each job."
      >
        <Switch
          checked={localOnly}
          onChange={(on) => void patch({ models: { localOnly: on } })}
          label="Local only"
          hint="Never call a cloud AI: only Ollama or LM Studio on this PC. Cloud keys (and cloud speech) are set aside until you turn this off."
        />
        <Select
          label="Preferred service"
          value={cfg.models.provider}
          disabled={localOnly}
          hint="Used for every job set to Automatic, when it’s set up."
          options={[
            { value: 'auto', label: 'Automatic (whichever is set up)' },
            { value: 'anthropic', label: 'Anthropic (Claude)' },
            { value: 'openai', label: 'OpenAI (ChatGPT)' },
            { value: 'gemini', label: 'Google Gemini (free tier)' },
            { value: 'compatible', label: 'Other OpenAI-compatible service' },
            { value: 'local', label: 'On this PC (Ollama, LM Studio)' }
          ]}
          onChange={(provider) => void patch({ models: { provider } })}
        />
      </Card>

      <Card
        title="API keys"
        description="Stored encrypted on this PC, never in the settings file. A key in .env also works."
      >
        <KeyForm
          compatible={cfg.models.compatible}
          geminiAck={cfg.models.geminiAck}
          onSaved={() => reload(true)}
        />
        {cfg.models.geminiAck && (
          <Switch
            checked={cfg.models.geminiPaid === true}
            onChange={(on) => void patch({ models: { geminiPaid: on } })}
            label="My Gemini key has billing on"
            hint="Gemini calls then count at Google’s paid prices in the cost estimate and the task spending caps, instead of as free tier."
          />
        )}
      </Card>

      {catalog && <CompatibleModel catalog={catalog} cfg={cfg} patch={patch} />}
      {catalog && <LocalCard catalog={catalog} reload={reload} />}

      <Card
        title="Models per job"
        description="Leave on Automatic unless you want a specific service or model for a job."
      >
        {!catalog ? (
          <p className="ui-hint">Loading…</p>
        ) : (
          ROLE_ORDER.map((role) => (
            <RoleRow key={role} role={role} catalog={catalog} cfg={cfg} patch={patch} />
          ))
        )}
      </Card>

      <ModelsCost />
    </>
  )
}

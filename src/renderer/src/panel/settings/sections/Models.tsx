import { useState } from 'react'
import { Button, Card, Select, TextField } from '../../../ui'
import type { SectionProps } from '../meta'
import { KeyForm } from './KeyForm'
import { ModelsCost } from './ModelsCost'

type Role = 'main' | 'fast' | 'planning' | 'verify'

const ROLE_INFO: Record<Role, { label: string; hint: string }> = {
  main: { label: 'Main', hint: 'Answers questions and decides what to click.' },
  fast: { label: 'Fast', hint: 'Quick routing and short replies.' },
  planning: { label: 'Planning', hint: 'Breaks bigger tasks into steps.' },
  verify: { label: 'Checking', hint: 'Confirms a step worked. The cheapest capable model is fine.' }
}

const PRESETS: Record<Role, string[]> = {
  main: ['claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5', 'gpt-5-mini', 'gpt-4o'],
  fast: ['claude-haiku-4-5-20251001', 'gpt-5-nano', 'gpt-5-mini', 'gpt-4o-mini'],
  planning: ['claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5', 'gpt-5-mini', 'gpt-4o'],
  verify: ['claude-haiku-4-5-20251001', 'gpt-5-nano', 'gpt-5-mini', 'gpt-4o-mini']
}

const MODEL_RE = /^[a-z0-9][a-z0-9.\-:/_]{0,79}$/i

function ModelField({
  role,
  value,
  onCommit
}: {
  role: Role
  value: string
  onCommit: (v: string) => void
}): JSX.Element {
  const presets = PRESETS[role]
  const [custom, setCustom] = useState(!!value && !presets.includes(value))
  const { label, hint } = ROLE_INFO[role]
  if (custom) {
    return (
      <div className="panel-row panel-row--end">
        <TextField
          label={`${label} model`}
          value={value}
          onCommit={onCommit}
          accept={(v) => v === '' || MODEL_RE.test(v)}
          hint={hint}
          mono
        />
        <Button
          variant="quiet"
          onClick={() => {
            setCustom(false)
            onCommit('')
          }}
        >
          Use a preset
        </Button>
      </div>
    )
  }
  return (
    <Select
      label={`${label} model`}
      value={value}
      hint={hint}
      options={[
        { value: '', label: 'Automatic' },
        ...presets.map((m) => ({ value: m, label: m })),
        { value: '__custom__', label: 'Other…' }
      ]}
      onChange={(v) => (v === '__custom__' ? setCustom(true) : onCommit(v))}
    />
  )
}

export function Models({ cfg, patch }: SectionProps): JSX.Element {
  return (
    <>
      <Card
        title="Provider"
        description="One key is enough. Lumen picks the right model for each job."
      >
        <Select
          label="Provider"
          value={cfg.models.provider}
          options={[
            { value: 'auto', label: 'Automatic (use whichever key is set)' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'openai', label: 'OpenAI' },
            { value: 'local', label: 'Local' }
          ]}
          onChange={(provider) => patch({ models: { provider } })}
        />
      </Card>

      <Card
        title="API key"
        description="Stored encrypted on this PC, never in the settings file. A key in .env also works."
      >
        <KeyForm />
      </Card>

      <Card
        title="Models per job"
        description="Leave on Automatic unless you need a specific model."
      >
        {(Object.keys(ROLE_INFO) as Role[]).map((role) => (
          <ModelField
            key={role}
            role={role}
            value={cfg.models[role] ?? ''}
            onCommit={(v) => patch({ models: { [role]: v } })}
          />
        ))}
      </Card>

      <ModelsCost />
    </>
  )
}

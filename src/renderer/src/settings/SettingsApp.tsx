import { useEffect, useState, useCallback } from 'react'
import { THEMES, applyTheme, type ThemeName } from '../themes'
import { HotkeyCapture } from './HotkeyCapture'

type Panel = 'general' | 'models' | 'appearance'

interface Config {
  version: 1
  theme: ThemeName
  models: { planning?: string; execution?: string; verification?: string }
  hotkey: string
  hudAutoCloseMs: number
  answerAutoCloseMs: number
  wakeWord: { enabled: boolean; phrase: string }
  historyEnabled: boolean
}

interface WakeModelStatus { installed: boolean; path: string }
interface WakeModelProgress { phase: 'downloading' | 'extracting' | 'done' | 'error'; percent?: number; message?: string }

declare global {
  interface Window {
    api: {
      getConfig: () => Promise<Config>
      saveConfig: (patch: Partial<Config>) => Promise<Config>
      wakeModelStatus: () => Promise<WakeModelStatus>
      wakeModelInstall: () => Promise<{ ok: boolean; error?: string }>
      onWakeModelProgress: (cb: (p: WakeModelProgress) => void) => void
    }
  }
}

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'dark',          label: 'Dark' },
  { value: 'light',         label: 'Light' },
  { value: 'high-contrast', label: 'High Contrast' },
  { value: 'ocean',         label: 'Ocean' },
  { value: 'forest',        label: 'Forest' },
  { value: 'sunset',        label: 'Sunset' },
  { value: 'midnight',      label: 'Midnight' },
]

const MODEL_PRESETS = {
  planning:     ['gpt-5-mini', 'gpt-5', 'gpt-4o', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  execution:    ['gpt-5-mini', 'gpt-5', 'gpt-4o', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  verification: ['gpt-5-nano', 'gpt-5-mini', 'claude-haiku-4-5-20251001', 'gpt-4o-mini'],
}

export function SettingsApp(): JSX.Element {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [panel, setPanel] = useState<Panel>('general')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    window.api.getConfig().then(c => { setCfg(c); applyTheme(c.theme) })
  }, [])

  const patch = useCallback(async (update: Partial<Config>): Promise<void> => {
    if (!cfg) return
    const next = await window.api.saveConfig(update)
    setCfg(next)
    if (update.theme) applyTheme(next.theme)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1200)
  }, [cfg])

  if (!cfg) {
    return <div className="sx-loading">Loading settings…</div>
  }

  return (
    <div className="sx">
      <aside className="sx-sidebar">
        <div className="sx-brand">
          <div className="sx-brand-dot" />
          <div>
            <div className="sx-brand-title">AI Overlay</div>
            <div className="sx-brand-sub">Settings</div>
          </div>
        </div>
        <nav className="sx-nav">
          <NavItem icon="⚙" label="General" active={panel === 'general'} onClick={() => setPanel('general')} />
          <NavItem icon="◆" label="Models" active={panel === 'models'} onClick={() => setPanel('models')} />
          <NavItem icon="✦" label="Appearance" active={panel === 'appearance'} onClick={() => setPanel('appearance')} />
        </nav>
        <div className={`sx-saved ${savedFlash ? 'show' : ''}`}>✓ Saved</div>
      </aside>

      <main className="sx-main">
        {panel === 'general' && <GeneralPanel cfg={cfg} patch={patch} />}
        {panel === 'models' && <ModelsPanel cfg={cfg} patch={patch} />}
        {panel === 'appearance' && <AppearancePanel cfg={cfg} patch={patch} />}
      </main>
    </div>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button className={`sx-nav-item ${active ? 'active' : ''}`} onClick={onClick} type="button">
      <span className="sx-nav-icon">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="sx-card">
      <header className="sx-card-header">
        <h3 className="sx-card-title">{title}</h3>
        {description && <p className="sx-card-desc">{description}</p>}
      </header>
      <div className="sx-card-body">{children}</div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="sx-field">
      <label className="sx-field-label">{label}</label>
      <div className="sx-field-control">{children}</div>
      {hint && <small className="sx-field-hint">{hint}</small>}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <label className="sx-toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="sx-toggle-track"><span className="sx-toggle-thumb" /></span>
      <span className="sx-toggle-label">{label}</span>
    </label>
  )
}

function GeneralPanel({ cfg, patch }: { cfg: Config; patch: (u: Partial<Config>) => Promise<void> }): JSX.Element {
  return (
    <>
      <PanelHeader title="General" subtitle="Hotkeys, timings, and assistant behavior." />
      <Card title="Activation" description="How you invoke the assistant.">
        <Field label="Global hotkey" hint="Press the button, then hit the key combination you want.">
          <HotkeyCapture value={cfg.hotkey} onChange={v => patch({ hotkey: v })} />
        </Field>
        <Field label="Wake word">
          <Toggle checked={cfg.wakeWord.enabled} onChange={v => patch({ wakeWord: { ...cfg.wakeWord, enabled: v } })} label="Enable always-on wake word" />
          <input
            className="sx-input"
            style={{ marginTop: 10 }}
            placeholder="hey lumen"
            value={cfg.wakeWord.phrase}
            onChange={e => patch({ wakeWord: { ...cfg.wakeWord, phrase: e.target.value } })}
          />
          <WakeModelManager />
        </Field>
      </Card>

      <Card title="Timings" description="Auto-close delays for overlay windows.">
        <Field label="HUD auto-close" hint="Milliseconds before the pill hides after a query.">
          <NumberStepper value={cfg.hudAutoCloseMs} step={500} min={1000} max={30000} onChange={v => patch({ hudAutoCloseMs: v })} suffix="ms" />
        </Field>
        <Field label="Answer overlay auto-close" hint="Milliseconds before the answer card dismisses.">
          <NumberStepper value={cfg.answerAutoCloseMs} step={500} min={2000} max={60000} onChange={v => patch({ answerAutoCloseMs: v })} suffix="ms" />
        </Field>
      </Card>

      <Card title="Conversation" description="Short-term memory between queries.">
        <Field label="History">
          <Toggle checked={cfg.historyEnabled} onChange={v => patch({ historyEnabled: v })} label="Remember the last 5 exchanges" />
        </Field>
      </Card>
    </>
  )
}

function ModelsPanel({ cfg, patch }: { cfg: Config; patch: (u: Partial<Config>) => Promise<void> }): JSX.Element {
  return (
    <>
      <PanelHeader
        title="Models"
        subtitle="Pick a model per role, or leave blank for provider defaults. API keys stay in your .env file."
      />
      <Card title="Role assignments">
        <Field label="Planning" hint="Breaks complex tasks into steps.">
          <ModelSelect value={cfg.models.planning ?? ''} presets={MODEL_PRESETS.planning} onChange={v => patch({ models: { ...cfg.models, planning: v } })} />
        </Field>
        <Field label="Execution" hint="Decides UI actions from screenshots.">
          <ModelSelect value={cfg.models.execution ?? ''} presets={MODEL_PRESETS.execution} onChange={v => patch({ models: { ...cfg.models, execution: v } })} />
        </Field>
        <Field label="Verification" hint="Checks if a step succeeded. Use the cheapest capable model.">
          <ModelSelect value={cfg.models.verification ?? ''} presets={MODEL_PRESETS.verification} onChange={v => patch({ models: { ...cfg.models, verification: v } })} />
        </Field>
      </Card>
    </>
  )
}

function AppearancePanel({ cfg, patch }: { cfg: Config; patch: (u: Partial<Config>) => Promise<void> }): JSX.Element {
  return (
    <>
      <PanelHeader title="Appearance" subtitle="Themes apply to every overlay window." />
      <Card title="Theme">
        <Field label="Preset">
          <select
            className="sx-select"
            value={cfg.theme}
            onChange={e => patch({ theme: e.target.value as ThemeName })}
          >
            {THEME_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Preview">
          <div className="sx-theme-grid">
            {THEME_OPTIONS.map(opt => {
              const theme = THEMES[opt.value as Exclude<ThemeName, 'custom'>]
              const selected = cfg.theme === opt.value
              return (
                <button
                  type="button"
                  key={opt.value}
                  className={`sx-theme-card ${selected ? 'selected' : ''}`}
                  style={{
                    background: theme['--ai-background'],
                    color: theme['--ai-foreground'],
                    borderColor: selected ? theme['--ai-accent'] : 'transparent',
                  }}
                  onClick={() => patch({ theme: opt.value })}
                >
                  <div className="sx-theme-swatches">
                    <span style={{ background: theme['--ai-accent'] }} />
                    <span style={{ background: theme['--ai-foreground'] }} />
                    <span style={{ background: theme['--ai-surface'] }} />
                  </div>
                  <div className="sx-theme-name">{opt.label}</div>
                  {selected && <div className="sx-theme-badge">Active</div>}
                </button>
              )
            })}
          </div>
        </Field>
      </Card>
    </>
  )
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }): JSX.Element {
  return (
    <header className="sx-panel-header">
      <h2 className="sx-panel-title">{title}</h2>
      <p className="sx-panel-subtitle">{subtitle}</p>
    </header>
  )
}

function ModelSelect({ value, presets, onChange }: { value: string; presets: string[]; onChange: (v: string) => void }): JSX.Element {
  const [custom, setCustom] = useState(value && !presets.includes(value))
  useEffect(() => { setCustom(!!value && !presets.includes(value)) }, [value, presets])

  if (custom) {
    return (
      <div className="sx-model-select">
        <input
          className="sx-input"
          value={value}
          placeholder="custom-model-id"
          onChange={e => onChange(e.target.value)}
        />
        <button type="button" className="sx-link" onClick={() => { setCustom(false); onChange('') }}>Use preset</button>
      </div>
    )
  }

  return (
    <div className="sx-model-select">
      <select
        className="sx-select"
        value={value}
        onChange={e => {
          const v = e.target.value
          if (v === '__custom__') { setCustom(true); return }
          onChange(v)
        }}
      >
        <option value="">Default (provider auto)</option>
        {presets.map(m => <option key={m} value={m}>{m}</option>)}
        <option value="__custom__">Custom…</option>
      </select>
    </div>
  )
}

function WakeModelManager(): JSX.Element {
  const [status, setStatus] = useState<WakeModelStatus | null>(null)
  const [progress, setProgress] = useState<WakeModelProgress | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    window.api.wakeModelStatus().then(setStatus).catch(() => {})
    window.api.onWakeModelProgress((p) => {
      setProgress(p)
      if (p.phase === 'done') {
        setInstalling(false)
        window.api.wakeModelStatus().then(setStatus).catch(() => {})
      }
      if (p.phase === 'error') setInstalling(false)
    })
  }, [])

  const install = async (): Promise<void> => {
    setInstalling(true)
    setProgress({ phase: 'downloading', percent: 0 })
    await window.api.wakeModelInstall()
  }

  if (!status) return <small className="sx-field-hint" style={{ marginTop: 10, display: 'block' }}>Checking model…</small>

  if (status.installed && !installing) {
    return <small className="sx-field-hint" style={{ marginTop: 10, display: 'block', color: 'var(--ai-success, #4ade80)' }}>✓ Offline model installed</small>
  }

  if (installing && progress) {
    const label = progress.phase === 'downloading'
      ? `Downloading… ${progress.percent ?? 0}%`
      : progress.phase === 'extracting'
        ? 'Extracting…'
        : progress.phase === 'error'
          ? `Failed: ${progress.message}`
          : 'Done'
    return (
      <div style={{ marginTop: 10 }}>
        <small className="sx-field-hint">{label}</small>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${progress.phase === 'extracting' ? 100 : (progress.percent ?? 0)}%`,
            background: 'var(--ai-accent, #5b8cff)',
            transition: 'width 0.2s',
          }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
      <button type="button" className="sx-link" onClick={install}>Install offline model (~40MB)</button>
      <small className="sx-field-hint" style={{ margin: 0 }}>Free, one-time download.</small>
    </div>
  )
}

function NumberStepper({ value, onChange, step, min, max, suffix }: { value: number; onChange: (v: number) => void; step: number; min: number; max: number; suffix?: string }): JSX.Element {
  return (
    <div className="sx-stepper">
      <button type="button" className="sx-stepper-btn" onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <input
        type="number"
        className="sx-stepper-input"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const v = Number(e.target.value)
          if (!Number.isFinite(v)) return
          onChange(Math.min(max, Math.max(min, v)))
        }}
      />
      {suffix && <span className="sx-stepper-suffix">{suffix}</span>}
      <button type="button" className="sx-stepper-btn" onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  )
}

import { useEffect, useState, useCallback } from 'react'
import { Settings as IcGeneral, Mic as IcVoice, Accessibility as IcA11y, LayoutDashboard as IcInterface, Cpu as IcModels, Palette as IcAppearance, Minus, Square, X } from 'lucide-react'
import { THEMES, applyTheme, type ThemeName } from '../themes'
import { HotkeyCapture } from './HotkeyCapture'

type Panel = 'general' | 'voice' | 'accessibility' | 'interface' | 'models' | 'appearance'

interface ThemeCustom {
  accent: string
  background: string
  foreground: string
  opacity: number
  blur: number
}

interface Config {
  version: 1
  theme: ThemeName
  themeCustom?: ThemeCustom
  models: { planning?: string; execution?: string; verification?: string }
  hotkey: string
  hudAutoCloseMs: number
  answerAutoCloseMs: number
  wakeWord: { enabled: boolean; phrase: string }
  statusBubble: { enabled: boolean }
  voiceVocab: string
  historyEnabled: boolean
  explainBeforeDo: boolean
  uiScale: number
  handsFreeMode: boolean
  cancelVoice: { enabled: boolean; phrases: string }
  tts: { enabled: boolean; voice: string }
  showConfidence: boolean
  dwellClick: { enabled: boolean; dwellMs: number }
}

// window.api is typed globally in src/renderer/src/api.d.ts
type WakeModelStatus = { installed: boolean; path: string }
type WakeModelProgress = { phase: 'downloading' | 'extracting' | 'done' | 'error'; percent?: number; message?: string }

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'dark',          label: 'Dark' },
  { value: 'light',         label: 'Light' },
  { value: 'high-contrast', label: 'High Contrast' },
  { value: 'ocean',         label: 'Ocean' },
  { value: 'forest',        label: 'Forest' },
  { value: 'sunset',        label: 'Sunset' },
  { value: 'midnight',      label: 'Midnight' },
]

const DEFAULT_CUSTOM: ThemeCustom = {
  accent: '#5b8cff',
  background: '#0d0f14',
  foreground: '#e6e8ee',
  opacity: 0.92,
  blur: 14,
}

function mapCustomToVars(c: ThemeCustom): Record<string, string> {
  return {
    '--ai-accent': c.accent,
    '--ai-background': c.background,
    '--ai-foreground': c.foreground,
    '--ai-opacity': String(c.opacity),
    '--ai-blur': `${c.blur}px`,
  }
}

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
    window.api.getConfig().then(c => {
      const cfg = c as unknown as Config
      setCfg(cfg)
      applyTheme(cfg.theme, cfg.themeCustom ? mapCustomToVars(cfg.themeCustom) : undefined)
    })
  }, [])

  const patch = useCallback(async (update: Partial<Config>): Promise<void> => {
    if (!cfg) return
    const next = await window.api.saveConfig(update) as unknown as Config
    setCfg(next)
    if (update.theme || update.themeCustom) {
      applyTheme(next.theme, next.themeCustom ? mapCustomToVars(next.themeCustom) : undefined)
    }
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1200)
  }, [cfg])

  if (!cfg) {
    return <div className="sx-loading">Loading settings…</div>
  }

  return (
    <>
      <TitleBar />
      <div className="sx">
        <aside className="sx-sidebar">
          <div className="sx-brand">
            <div className="sx-brand-dot" />
            <div>
              <div className="sx-brand-title">Lumen</div>
              <div className="sx-brand-sub">Preferences</div>
            </div>
          </div>
          <nav className="sx-nav">
            <NavItem icon={<IcGeneral size={15} />} label="General" active={panel === 'general'} onClick={() => setPanel('general')} />
            <NavItem icon={<IcVoice size={15} />} label="Voice" active={panel === 'voice'} onClick={() => setPanel('voice')} />
            <NavItem icon={<IcA11y size={15} />} label="Accessibility" active={panel === 'accessibility'} onClick={() => setPanel('accessibility')} />
            <NavItem icon={<IcInterface size={15} />} label="Interface" active={panel === 'interface'} onClick={() => setPanel('interface')} />
            <NavItem icon={<IcModels size={15} />} label="Models" active={panel === 'models'} onClick={() => setPanel('models')} />
            <NavItem icon={<IcAppearance size={15} />} label="Appearance" active={panel === 'appearance'} onClick={() => setPanel('appearance')} />
          </nav>
          <div className={`sx-saved ${savedFlash ? 'show' : ''}`}>✓ Saved</div>
        </aside>

        <main className="sx-main">
          {panel === 'general' && <GeneralPanel cfg={cfg} patch={patch} />}
          {panel === 'voice' && <VoicePanel cfg={cfg} patch={patch} />}
          {panel === 'accessibility' && <AccessibilityPanel cfg={cfg} patch={patch} />}
          {panel === 'interface' && <InterfacePanel cfg={cfg} patch={patch} />}
          {panel === 'models' && <ModelsPanel cfg={cfg} patch={patch} />}
          {panel === 'appearance' && <AppearancePanel cfg={cfg} patch={patch} />}
        </main>
      </div>
    </>
  )
}

function TitleBar(): JSX.Element {
  return (
    <div className="sx-titlebar">
      <div className="sx-titlebar-label">
        <span className="sx-titlebar-dot" />
        Lumen · Settings
      </div>
      <div className="sx-titlebar-controls">
        <button className="sx-ctrl" type="button" onClick={() => window.api.settingsWindowMinimize?.()} title="Minimize">
          <Minus size={14} />
        </button>
        <button className="sx-ctrl" type="button" onClick={() => window.api.settingsWindowMaximize?.()} title="Maximize">
          <Square size={12} />
        </button>
        <button className="sx-ctrl close" type="button" onClick={() => window.api.settingsWindowClose?.()} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }): JSX.Element {
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
      <PanelHeader title="General" subtitle="How you invoke Lumen and what it remembers." />

      <Card title="Activation" description="Hotkey and hands-free behavior.">
        <Field label="Global hotkey" hint="Press the button, then hit the key combination you want.">
          <HotkeyCapture value={cfg.hotkey} onChange={v => patch({ hotkey: v })} />
        </Field>
        <Field label="Hands-free mode" hint="Tap the hotkey instead of holding it. Recording auto-stops on ~1.5s of silence. Helpful for motor-limited use.">
          <Toggle checked={cfg.handsFreeMode} onChange={v => patch({ handsFreeMode: v })} label="Tap-to-talk with silence auto-stop" />
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

function VoicePanel({ cfg, patch }: { cfg: Config; patch: (u: Partial<Config>) => Promise<void> }): JSX.Element {
  return (
    <>
      <PanelHeader title="Voice" subtitle="Wake word, recognition vocabulary, and voice commands." />

      <Card title="Wake word" description="Offline phrase that opens Lumen hands-free.">
        <Field label="Enable">
          <Toggle checked={cfg.wakeWord.enabled} onChange={v => patch({ wakeWord: { ...cfg.wakeWord, enabled: v } })} label="Always-on wake word" />
        </Field>
        <Field label="Phrase" hint="Keep it short and unusual. Uses offline Vosk — no cloud cost.">
          <input
            className="sx-input"
            placeholder="hey lumen"
            value={cfg.wakeWord.phrase}
            onChange={e => patch({ wakeWord: { ...cfg.wakeWord, phrase: e.target.value } })}
          />
        </Field>
        <Field label="Offline model">
          <WakeModelManager />
        </Field>
      </Card>

      <Card title="Voice commands" description="Say any of these while a guide or action is running.">
        <Field label="Cancel voice" hint="Lets you stop in-flight actions hands-free. Keeps the mic active while enabled.">
          <Toggle checked={cfg.cancelVoice.enabled} onChange={v => patch({ cancelVoice: { ...cfg.cancelVoice, enabled: v } })} label="Listen for cancel phrases" />
        </Field>
        <Field label="Cancel phrases" hint="Comma-separated. Default: stop, cancel, abort, never mind.">
          <input
            className="sx-input"
            placeholder="stop, cancel, abort"
            value={cfg.cancelVoice.phrases}
            onChange={e => patch({ cancelVoice: { ...cfg.cancelVoice, phrases: e.target.value } })}
          />
        </Field>
      </Card>

      <Card title="Vocabulary" description="Give Whisper a hint for brand names, people, or jargon.">
        <Field label="Custom words" hint="Comma or newline separated. Example: Exness, Kubernetes, Janokins.">
          <textarea
            className="sx-input"
            style={{ minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="Exness, Kubernetes, ..."
            value={cfg.voiceVocab}
            onChange={e => patch({ voiceVocab: e.target.value })}
          />
        </Field>
      </Card>
    </>
  )
}

function AccessibilityPanel({ cfg, patch }: { cfg: Config; patch: (u: Partial<Config>) => Promise<void> }): JSX.Element {
  return (
    <>
      <PanelHeader title="Accessibility" subtitle="Make Lumen easier to see, hear, and follow." />

      <Card title="Visibility">
        <Field label="UI scale" hint="Scales the pill, answer card, and status bubble. Helpful for low vision.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 380 }}>
            <input
              type="range"
              min={0.75}
              max={1.6}
              step={0.05}
              value={cfg.uiScale}
              onChange={e => patch({ uiScale: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span style={{
              fontVariantNumeric: 'tabular-nums',
              minWidth: 44,
              fontFamily: 'JetBrains Mono, SF Mono, ui-monospace, monospace',
              color: 'var(--ai-muted-strong)',
              fontSize: 12,
            }}>
              {Math.round(cfg.uiScale * 100)}%
            </span>
          </div>
        </Field>
      </Card>

      <Card title="Learning aids" description="Useful when learning a new app or for users who benefit from narration.">
        <Field label="Narrate actions" hint="Before running an action, show a plain-English description for ~1 second.">
          <Toggle checked={cfg.explainBeforeDo} onChange={v => patch({ explainBeforeDo: v })} label="Explain before executing" />
        </Field>
        <Field label="Show confidence" hint="When Lumen isn't fully sure, show 'Low confidence — say cancel to stop'. Gives you a chance to abort.">
          <Toggle checked={cfg.showConfidence} onChange={v => patch({ showConfidence: v })} label="Announce low/medium confidence" />
        </Field>
      </Card>

      <Card title="Read answers aloud (TTS)" description="Uses OpenAI text-to-speech. Requires OPENAI_API_KEY.">
        <Field label="Enable">
          <Toggle checked={cfg.tts.enabled} onChange={v => patch({ tts: { ...cfg.tts, enabled: v } })} label="Speak answer overlays" />
        </Field>
        <Field label="Voice" hint="Six OpenAI voices. Preview them at openai.com/research/text-to-speech-api.">
          <select
            className="sx-select"
            value={cfg.tts.voice}
            onChange={e => patch({ tts: { ...cfg.tts, voice: e.target.value } })}
          >
            {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </Field>
      </Card>

      <Card title="Dwell click" description="Click automatically when the cursor stays still. Built for users who can move a pointer but can't click.">
        <Field label="Enable">
          <Toggle checked={cfg.dwellClick.enabled} onChange={v => patch({ dwellClick: { ...cfg.dwellClick, enabled: v } })} label="Auto-click on cursor dwell" />
        </Field>
        <Field label="Dwell time" hint="Milliseconds the cursor must be still before a click fires. Lower = faster, more accidental clicks.">
          <NumberStepper value={cfg.dwellClick.dwellMs} step={100} min={500} max={3000} onChange={v => patch({ dwellClick: { ...cfg.dwellClick, dwellMs: v } })} suffix="ms" />
        </Field>
      </Card>
    </>
  )
}

function InterfacePanel({ cfg, patch }: { cfg: Config; patch: (u: Partial<Config>) => Promise<void> }): JSX.Element {
  return (
    <>
      <PanelHeader title="Interface" subtitle="On-screen overlays and their behavior." />

      <Card title="Status bubble" description="Small indicator at the bottom-center showing what Lumen is doing.">
        <Field label="Visibility" hint="Shows listening / transcribing / thinking / acting, plus step counters during multi-step plans.">
          <Toggle checked={cfg.statusBubble.enabled} onChange={v => patch({ statusBubble: { enabled: v } })} label="Show status bubble" />
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
  const customThemeCard: ThemeVarsLike = {
    '--ai-accent': cfg.themeCustom?.accent ?? DEFAULT_CUSTOM.accent,
    '--ai-background': cfg.themeCustom?.background ?? DEFAULT_CUSTOM.background,
    '--ai-foreground': cfg.themeCustom?.foreground ?? DEFAULT_CUSTOM.foreground,
    '--ai-surface': cfg.themeCustom?.background ?? DEFAULT_CUSTOM.background,
  }

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
            <option value="custom">Custom</option>
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
            <button
              type="button"
              className={`sx-theme-card ${cfg.theme === 'custom' ? 'selected' : ''}`}
              style={{ background: customThemeCard['--ai-background'], color: customThemeCard['--ai-foreground'] }}
              onClick={() => patch({ theme: 'custom' })}
            >
              <div className="sx-theme-swatches">
                <span style={{ background: customThemeCard['--ai-accent'] }} />
                <span style={{ background: customThemeCard['--ai-foreground'] }} />
                <span style={{ background: customThemeCard['--ai-surface'] }} />
              </div>
              <div className="sx-theme-name">Custom</div>
              {cfg.theme === 'custom' && <div className="sx-theme-badge">Active</div>}
            </button>
          </div>
        </Field>
      </Card>

      <Card title="Custom colors" description="Pick the three core colors. Activating a picker switches the theme to Custom.">
        <CustomColorField
          label="Accent"
          hint="Buttons, highlights, focus rings."
          value={cfg.themeCustom?.accent ?? DEFAULT_CUSTOM.accent}
          onChange={v => patch({
            theme: 'custom',
            themeCustom: { ...DEFAULT_CUSTOM, ...(cfg.themeCustom ?? {}), accent: v },
          })}
        />
        <CustomColorField
          label="Background"
          hint="Base surface behind overlays."
          value={cfg.themeCustom?.background ?? DEFAULT_CUSTOM.background}
          onChange={v => patch({
            theme: 'custom',
            themeCustom: { ...DEFAULT_CUSTOM, ...(cfg.themeCustom ?? {}), background: v },
          })}
        />
        <CustomColorField
          label="Foreground"
          hint="Primary text / icon color."
          value={cfg.themeCustom?.foreground ?? DEFAULT_CUSTOM.foreground}
          onChange={v => patch({
            theme: 'custom',
            themeCustom: { ...DEFAULT_CUSTOM, ...(cfg.themeCustom ?? {}), foreground: v },
          })}
        />
        <div style={{ marginTop: 6, display: 'flex', gap: 10 }}>
          <button type="button" className="sx-link" onClick={() => patch({
            theme: 'custom',
            themeCustom: { ...DEFAULT_CUSTOM },
          })}>
            Reset custom colors
          </button>
        </div>
      </Card>
    </>
  )
}

type ThemeVarsLike = { '--ai-accent': string; '--ai-background': string; '--ai-foreground': string; '--ai-surface': string }

function CustomColorField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }): JSX.Element {
  const normalized = /^#([0-9a-f]{3}){1,2}$/i.test(value) ? value : '#000000'
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            border: '1px solid var(--ai-border-strong)',
            background: normalized,
            cursor: 'pointer',
            position: 'relative',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
          }}
        >
          <input
            type="color"
            value={normalized}
            onChange={e => onChange(e.target.value)}
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
          />
        </label>
        <input
          className="sx-input"
          style={{ width: 140, fontFamily: 'JetBrains Mono, SF Mono, ui-monospace, monospace', fontVariantNumeric: 'tabular-nums' }}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="#RRGGBB"
        />
      </div>
    </Field>
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

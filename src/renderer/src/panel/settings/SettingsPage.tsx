import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent
} from 'react'
import { Button, NavList, Toast, icons } from '../../ui'
import { filterSections, SECTIONS, type SectionId, type SectionProps } from './meta'
import { useConfig } from './useConfig'

/** One chunk per section, loaded when the section first opens. */
const lazySection = (
  load: () => Promise<ComponentType<SectionProps>>
): LazyExoticComponent<ComponentType<SectionProps>> =>
  lazy(() => load().then((View) => ({ default: View })))

/** Runs once the lazy section has mounted (after Suspense resolves). */
function Mounted({ id, onMount }: { id: SectionId; onMount: (id: SectionId) => void }): null {
  useEffect(() => onMount(id), [id, onMount])
  return null
}

const VIEWS: Record<SectionId, LazyExoticComponent<ComponentType<SectionProps>>> = {
  general: lazySection(() => import('./sections/General').then((m) => m.General)),
  voice: lazySection(() => import('./sections/Voice').then((m) => m.Voice)),
  accessibility: lazySection(() => import('./sections/Accessibility').then((m) => m.Accessibility)),
  look: lazySection(() => import('./sections/Look').then((m) => m.Look)),
  models: lazySection(() => import('./sections/Models').then((m) => m.Models)),
  usage: lazySection(() => import('./sections/Usage').then((m) => m.Usage)),
  memory: lazySection(() => import('./sections/Memory').then((m) => m.Memory)),
  lessons: lazySection(() => import('./sections/Lessons').then((m) => m.Lessons)),
  skills: lazySection(() => import('./sections/Skills').then((m) => m.Skills)),
  background: lazySection(() => import('./sections/Background').then((m) => m.Background)),
  buddies: lazySection(() => import('./sections/Buddies').then((m) => m.Buddies)),
  helpers: lazySection(() => import('./sections/Helpers').then((m) => m.Helpers)),
  bridges: lazySection(() => import('./sections/Bridges').then((m) => m.Bridges)),
  'claude-code': lazySection(() => import('./sections/ClaudeCode').then((m) => m.ClaudeCode)),
  connectors: lazySection(() => import('./sections/Connectors').then((m) => m.Connectors)),
  news: lazySection(() => import('./sections/News').then((m) => m.News)),
  privacy: lazySection(() => import('./sections/Privacy').then((m) => m.Privacy)),
  diagnostics: lazySection(() => import('./sections/Diagnostics').then((m) => m.Diagnostics)),
  about: lazySection(() => import('./sections/About').then((m) => m.About))
}

export interface SettingsPageProps {
  section: SectionId
  onNavigate: (id: SectionId) => void
}

export function SettingsPage({ section, onNavigate }: SettingsPageProps): JSX.Element {
  const { cfg, patch, error } = useConfig()
  const [query, setQuery] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const prev = useRef<SectionId>(section)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const firstRender = useRef(true)
  /** The section whose view is on screen, and one still loading that the heading waits for. */
  const shown = useRef<SectionId | null>(null)
  const focusPending = useRef<SectionId | null>(null)
  // Simple mode lists the essential sections; "Show all settings" lifts that for this visit.
  const [showAll, setShowAll] = useState(false)
  const essentials = !!cfg?.a11y.simpleMode && !showAll

  useEffect(() => {
    const order = (id: SectionId): number => SECTIONS.findIndex((s) => s.id === id)
    setDir(order(section) >= order(prev.current) ? 'fwd' : 'back')
    prev.current = section
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    focusPending.current = shown.current === section ? null : section
    headingRef.current?.focus()
  }, [section])

  const viewMounted = useCallback((id: SectionId) => {
    shown.current = id
    if (focusPending.current !== id) return
    focusPending.current = null
    headingRef.current?.focus()
  }, [])

  const visible = filterSections(query, essentials)
  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const View = VIEWS[meta.id]

  return (
    <div className="panel">
      <header className="panel-titlebar">
        <span className="panel-titlebar__title">Lumen settings</span>
        <span className="panel-titlebar__controls">
          <button
            type="button"
            aria-label="Minimize"
            onClick={() => window.lumen.send('settings:window-minimize')}
          >
            <icons.minus />
          </button>
          <button
            type="button"
            aria-label="Maximize"
            onClick={() => window.lumen.send('settings:window-maximize')}
          >
            <icons.square />
          </button>
          <button
            type="button"
            aria-label="Close"
            className="is-close"
            onClick={() => window.lumen.send('settings:window-close')}
          >
            <icons.close />
          </button>
        </span>
      </header>

      <div className="panel-body">
        <aside className="panel-side">
          <div className="panel-search">
            <icons.search />
            <input
              type="search"
              aria-label="Search settings"
              aria-describedby="panel-search-count"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && visible[0]) onNavigate(visible[0].id)
              }}
            />
          </div>
          <span id="panel-search-count" className="visually-hidden" aria-live="polite">
            {query
              ? `${visible.length} ${visible.length === 1 ? 'section' : 'sections'} found`
              : ''}
          </span>
          <NavList
            label="Settings sections"
            items={visible}
            current={section}
            onSelect={onNavigate}
            hrefPrefix="#/settings/"
          />
          {query && !visible.length && <p className="ui-hint">No matches.</p>}
          {!query && cfg?.a11y.simpleMode && (
            <Button variant="quiet" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer settings' : 'Show all settings'}
            </Button>
          )}
        </aside>

        <main className="panel-main" aria-labelledby="panel-heading">
          <div key={meta.id} className={`panel-page is-${dir}`}>
            <h1 id="panel-heading" ref={headingRef} tabIndex={-1}>
              {meta.label}
            </h1>
            {error && <Toast kind="error">{error}</Toast>}
            {cfg ? (
              <Suspense fallback={<p className="ui-hint">Loading…</p>}>
                <View cfg={cfg} patch={patch} />
                <Mounted id={meta.id} onMount={viewMounted} />
              </Suspense>
            ) : (
              <p className="ui-hint">Loading settings…</p>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

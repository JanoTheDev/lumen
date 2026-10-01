import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Button, NavList, Toast, icons } from '../../ui'
import { filterSections, SECTIONS, type SectionId, type SectionProps } from './meta'
import { useConfig } from './useConfig'
import { About } from './sections/About'
import { Bridges } from './sections/Bridges'
import { Accessibility } from './sections/Accessibility'
import { General } from './sections/General'
import { Lessons } from './sections/Lessons'
import { Look } from './sections/Look'
import { Memory } from './sections/Memory'
import { Models } from './sections/Models'
import { Privacy } from './sections/Privacy'
import { Skills } from './sections/Skills'
import { Voice } from './sections/Voice'

const VIEWS: Record<SectionId, ComponentType<SectionProps>> = {
  general: General,
  voice: Voice,
  accessibility: Accessibility,
  look: Look,
  models: Models,
  memory: Memory,
  lessons: Lessons,
  skills: Skills,
  bridges: Bridges,
  privacy: Privacy,
  about: About
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
    headingRef.current?.focus()
  }, [section])

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
            {cfg ? <View cfg={cfg} patch={patch} /> : <p className="ui-hint">Loading settings…</p>}
          </div>
        </main>
      </div>
    </div>
  )
}

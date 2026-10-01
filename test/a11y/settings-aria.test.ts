// Static ARIA checks of Settings → Accessibility (06 T24, automated part). There is no DOM
// library in this repo, so the section is rendered to markup and every interactive element is
// checked for a name, a role and a reachable label. Keyboard behaviour is a hand test
// (plans/06-accessibility/testing-checklist.md).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V2, type ConfigV2 } from '../../src/shared/config'
import { Accessibility } from '../../src/renderer/src/panel/settings/sections/Accessibility'

function render(cfg: ConfigV2): string {
  return renderToStaticMarkup(
    createElement(Accessibility, {
      cfg: cfg as never,
      patch: async () => true
    })
  )
}

const ids = (html: string): Set<string> =>
  new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

/** Every `<tag …>` opening tag. */
const tags = (html: string, tag: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => m[0])

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

function checkMarkup(html: string): void {
  const known = ids(html)
  for (const b of tags(html, 'button')) {
    const role = attr(b, 'role')
    if (role === 'switch') {
      expect(attr(b, 'aria-checked'), b).toMatch(/^(true|false)$/)
      expect(known.has(attr(b, 'aria-labelledby') ?? ''), b).toBe(true)
    }
    if (role === 'radio') expect(attr(b, 'aria-checked'), b).toMatch(/^(true|false)$/)
    expect(attr(b, 'type'), b).toBe('button')
  }
  // Buttons have visible text or an aria-label.
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const text = m[2].replace(/<[^>]+>/g, '').trim()
    expect(
      text || attr(`<b ${m[1]}>`, 'aria-label') || attr(`<b ${m[1]}>`, 'aria-labelledby'),
      m[0]
    ).toBeTruthy()
  }
  for (const g of tags(html, 'div').filter((d) => attr(d, 'role') === 'radiogroup')) {
    expect(known.has(attr(g, 'aria-labelledby') ?? ''), g).toBe(true)
  }
  // Radio groups use a roving tab stop: exactly one radio per group is in the Tab order.
  for (const m of html.matchAll(/role="radiogroup"[^>]*>([\s\S]*?)<\/div>/g)) {
    const radios = tags(m[1], 'button').filter((b) => attr(b, 'role') === 'radio')
    if (!radios.length) continue
    expect(
      radios.filter((r) => attr(r, 'tabindex') === '0'),
      m[0]
    ).toHaveLength(1)
  }
  // Every input has a label: <label for>, aria-label or aria-labelledby.
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]))
  for (const i of tags(html, 'input')) {
    const id = attr(i, 'id')
    expect(
      (id && labelled.has(id)) || attr(i, 'aria-label') || attr(i, 'aria-labelledby'),
      i
    ).toBeTruthy()
  }
  // aria-describedby points at something that exists.
  for (const m of html.matchAll(/aria-describedby="([^"]+)"/g))
    for (const ref of m[1].split(/\s+/)) expect(known.has(ref), ref).toBe(true)
  // Tables have column headers with a scope.
  for (const th of tags(html, 'th')) expect(attr(th, 'scope'), th).toBe('col')
  // No positive tabindex (it breaks the reading order).
  for (const m of html.matchAll(/tabindex="(\d+)"/g)) expect(Number(m[1])).toBeLessThanOrEqual(0)
}

describe('Settings → Accessibility markup (T24)', () => {
  it('has names, roles and labels for every control', () => {
    const html = render(DEFAULT_CONFIG_V2)
    expect(tags(html, 'button').length).toBeGreaterThan(10)
    checkMarkup(html)
  })

  it('switch scanning with two keys shows the step-scan control, still labelled', () => {
    const cfg: ConfigV2 = {
      ...DEFAULT_CONFIG_V2,
      a11y: {
        ...DEFAULT_CONFIG_V2.a11y,
        switch: { ...DEFAULT_CONFIG_V2.a11y.switch, enabled: true, keys: ['Space', 'Enter'] }
      }
    }
    checkMarkup(render(cfg))
  })

  it('simple mode shows only the essentials and a way to see everything', () => {
    const cfg: ConfigV2 = {
      ...DEFAULT_CONFIG_V2,
      a11y: { ...DEFAULT_CONFIG_V2.a11y, simpleMode: true }
    }
    const html = render(cfg)
    checkMarkup(html)
    expect(html).toContain('Show all options')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Moving: switch scanning')
    expect(render(DEFAULT_CONFIG_V2)).toContain('Moving: switch scanning')
  })

  it('offers the eye gaze dwell setup until it is on', () => {
    expect(render(DEFAULT_CONFIG_V2)).toContain('Set up for eye gaze or head pointer')
    const gaze: ConfigV2 = {
      ...DEFAULT_CONFIG_V2,
      a11y: {
        ...DEFAULT_CONFIG_V2.a11y,
        dwell: {
          ...DEFAULT_CONFIG_V2.a11y.dwell,
          radiusPx: 30,
          smoothing: 0.5,
          snapToElement: true
        }
      }
    }
    expect(render(gaze)).toContain('Eye gaze settings are on')
  })
})

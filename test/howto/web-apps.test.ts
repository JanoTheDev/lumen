// Web apps in a browser (review 6, 11): notes and cached answers are keyed by the site, so a
// path learned in Gmail is found by lookup_howto({app: "Gmail"}) and never offered in Outlook
// on the web in the same browser.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { HowtoCache } from '../../src/main/howto/cache'
import { createLearner } from '../../src/main/howto/learn'
import { lookupHowto, type LookupDeps } from '../../src/main/howto/lookup'
import { AppNotesStore } from '../../src/main/howto/notes'
import type { HowtoResult } from '../../src/main/howto/types'
import {
  browserIdentity,
  isMicrosoftApp,
  namedIdentity,
  siteName
} from '../../src/main/howto/version'

const root = mkdtempSync(join(tmpdir(), 'lumen-howto-web-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const chrome = (title: string): { process: string; title: string } => ({
  process: 'chrome.exe',
  title
})
const GMAIL_TAB = chrome('Inbox (3) - jip@example.com - Gmail - Google Chrome')
const OUTLOOK_TAB = chrome('Mail - Jan Om - Outlook - Google Chrome')

function deps(store: AppNotesStore, cache: HowtoCache): LookupDeps {
  return {
    mode: () => 'free-only',
    paidAllowed: () => false,
    notes: () => store,
    cache,
    get: vi.fn(async (url: string) => ({ url, status: 404, body: '' })),
    paid: null,
    recordPaid: () => 0,
    log: () => {}
  }
}

describe('site identity in browsers', () => {
  it('names the site from the address bar, else a known title, else the browser', () => {
    expect(browserIdentity(chrome('x'), 'https://mail.google.com/mail/u/0/#inbox')).toMatchObject({
      app: 'Gmail',
      appId: 'gmail',
      browser: true
    })
    expect(browserIdentity(GMAIL_TAB, null).appId).toBe('gmail')
    expect(
      browserIdentity(
        {
          process: 'msedge.exe',
          title: 'Mail - Jan - Outlook and 2 more pages - Personal - Microsoft​ Edge'
        },
        null
      ).app
    ).toBe('Outlook on the web')
    expect(siteName('https://gist.github.com/x')).toBe('github.com')
    expect(siteName('edge://settings')).toBeNull()
    expect(browserIdentity(chrome('My secret page - Google Chrome'), null)).toMatchObject({
      app: 'Google Chrome',
      browser: true
    })
    // Edge in front no longer sends every web-app goal to Microsoft Learn.
    expect(isMicrosoftApp(browserIdentity(chrome('x'), 'https://github.com/a').app)).toBe(false)
  })

  it('a path learned in Gmail is found by app "Gmail" and not in Outlook on the web', async () => {
    const store = new AppNotesStore(join(root, 'notes'))
    const gmail = browserIdentity(GMAIL_TAB, null)
    const learner = createLearner({ notes: () => store, identify: async () => gmail })
    await learner.acted('archive an email', 'click', { name: 'Archive', role: 'button' })

    const cache = new HowtoCache(null)
    const named = namedIdentity(gmail, 'Gmail')
    const r = await lookupHowto(
      { id: named, goal: 'archive an email', taskId: 't' },
      deps(store, cache)
    )
    expect(r.from).toBe('notes')
    expect(r.steps[0].ui).toEqual(['Archive'])

    const outlook = namedIdentity(browserIdentity(OUTLOOK_TAB, null), undefined)
    expect(outlook.appId).not.toBe(gmail.appId)
    const o = await lookupHowto(
      { id: outlook, goal: 'archive an email', taskId: 't' },
      deps(store, cache)
    )
    expect(o.from).not.toBe('notes')
  })

  it('a cached answer for one site is not served for another in the same browser', () => {
    const cache = new HowtoCache(null)
    const outlook = browserIdentity(OUTLOOK_TAB, null)
    const answer: HowtoResult = {
      app: outlook.app,
      version: '',
      goal: 'archive an email',
      steps: [{ text: 'Click Archive', ui: ['Archive'] }],
      sources: [],
      from: 'web-search',
      searches: 1,
      costUsd: 0.01
    }
    cache.put(outlook, 'archive an email', answer)
    expect(cache.get(outlook, 'archive an email')).not.toBeNull()
    expect(cache.get(browserIdentity(GMAIL_TAB, null), 'archive an email')).toBeNull()
  })
})

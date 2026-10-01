import { useState } from 'react'
import { WEB_DEFAULTS } from '@shared/config'
import { Button, Card, Switch, TextField } from '../../../ui'
import type { SectionProps } from '../meta'
import { feedsToText, textToFeeds, textToInterests } from './news-feeds'

const SAYINGS = [
  '“Summarize this page” or “TL;DR” with an article open',
  '“What does it say about …”, “Is this biased?”, “Read me the conclusion”',
  '“Top news today”, “What’s happening in tech”, “News about …”',
  '“Tell me more about the second story”, “Open the BBC one”, “Open the sources”',
  '“Save this to my notes”'
]

export function News({ cfg, patch }: SectionProps): JSX.Element {
  const [bad, setBad] = useState<number[]>([])
  const web = cfg.web
  return (
    <>
      <Card
        title="Read the web with me"
        description="Lumen reads the page in front of you, or the news from the feeds below, and keeps numbered sources you can open by voice."
      >
        <ul className="ui-hint">
          {SAYINGS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="ui-hint">
          Pages are read only when you ask. The page text on your screen is used first, so pages you
          are signed in to work too; otherwise the page is downloaded once (sites that block
          automatic reading in robots.txt are skipped) and kept in memory for 15 minutes.
        </p>
      </Card>

      <Card
        title="News feeds"
        description="Free RSS or Atom feeds from publishers. No account or key needed."
        actions={
          <Button
            onClick={() => {
              setBad([])
              patch({ web: { feeds: WEB_DEFAULTS.feeds } })
            }}
          >
            Reset to defaults
          </Button>
        }
      >
        <TextField
          label="Feeds"
          multiline
          mono
          spellCheck={false}
          value={feedsToText(web.feeds)}
          commitOnBlurOnly
          onCommit={(text) => {
            const parsed = textToFeeds(text)
            setBad(parsed.bad)
            patch({ web: { feeds: parsed.feeds } })
          }}
          error={
            bad.length
              ? `Line ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not an https feed address and ${bad.length === 1 ? 'was' : 'were'} left out.`
              : undefined
          }
          hint="One feed per line: Name | https://address | topic. Topics like world or tech answer “what’s happening in tech”."
        />
        <TextField
          label="Interests"
          value={web.interests.join(', ')}
          commitOnBlurOnly
          onCommit={(text) => patch({ web: { interests: textToInterests(text) } })}
          placeholder="climate, formula 1, space"
          hint="Stories about these come first. Kept on this PC."
        />
      </Card>

      <Card title="Web search (paid, optional)">
        <Switch
          checked={web.paidSearch}
          onChange={(paidSearch) => patch({ web: { paidSearch } })}
          label="Search the web when my feeds have nothing"
          hint="Off by default. Uses your Anthropic key: about $0.01 per search ($10 per 1,000) plus the usual model cost, at most 2 searches per question. Only for “news about …” when your feeds have no story on it."
        />
      </Card>
    </>
  )
}

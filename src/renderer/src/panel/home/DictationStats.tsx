// Home dictation stats (04 T46): words, speaking pace, time saved against typing and the day
// streak. Counted on this computer only; shown when "Dictation stats" is on.
import type { DictationStatsView } from '@shared/dictation-history'
import { Button } from '../../ui'
import { invoke } from '../../lib/ipc'
import { duration, plural } from './dictation-view'

export function DictationStats({
  stats,
  refresh
}: {
  stats: DictationStatsView
  refresh: () => void
}): JSX.Element {
  const tiles: Array<[string, string]> = [
    ['Today', plural(stats.todayWords, 'word')],
    ['This week', plural(stats.weekWords, 'word')],
    ['Time saved', stats.savedMs > 0 ? duration(stats.savedMs) : '—'],
    ['Your pace', stats.wpm > 0 ? `${stats.wpm} wpm` : '—'],
    ['Streak', stats.streak > 0 ? plural(stats.streak, 'day') : '—'],
    ['All time', plural(stats.totalWords, 'word')]
  ]
  return (
    <section className="home-section" aria-labelledby="home-stats">
      <h2 id="home-stats" className="home-label">
        Dictation
      </h2>
      <dl className="home-stats">
        {tiles.map(([label, value]) => (
          <div key={label} className="home-stats__tile">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="home-empty">
        Time saved compares with typing at {stats.typingWpm} words a minute.
      </p>
      {stats.totalWords > 0 && (
        <Button
          variant="quiet"
          onClick={() => {
            void invoke('dictation:stats-reset')
              .then(refresh)
              .catch(() => {})
          }}
        >
          Reset stats
        </Button>
      )}
    </section>
  )
}

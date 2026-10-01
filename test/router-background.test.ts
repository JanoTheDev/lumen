import { describe, expect, it } from 'vitest'
import { matchBackgroundIntent } from '../src/main/query/router'

describe('matchBackgroundIntent', () => {
  it('takes the task out of "in the background" / "while I work" lead-ins', () => {
    expect(matchBackgroundIntent('In the background, compare prices for the Sony XM5')).toEqual({
      prompt: 'Compare prices for the Sony XM5'
    })
    expect(matchBackgroundIntent('hey lumen while I work find three vegan recipes')).toEqual({
      prompt: 'Find three vegan recipes'
    })
    expect(matchBackgroundIntent("while I'm working, can you summarise the news")).toEqual({
      prompt: 'Summarise the news'
    })
  })

  it('accepts the phrase at the end', () => {
    expect(matchBackgroundIntent('research flights to Lisbon in the background')).toEqual({
      prompt: 'Research flights to Lisbon'
    })
  })

  it('keeps "keep an eye on" as the task', () => {
    expect(matchBackgroundIntent('please keep an eye on the price of the lamp')).toEqual({
      prompt: 'Keep an eye on the price of the lamp'
    })
  })

  it('ignores normal requests and empty lead-ins', () => {
    expect(matchBackgroundIntent('what is in the background of this photo')).toBeNull()
    expect(matchBackgroundIntent('in the background')).toBeNull()
    expect(matchBackgroundIntent('open gmail')).toBeNull()
    expect(matchBackgroundIntent('in the background, go')).toBeNull()
  })

  it('the tail form needs a task verb (review low)', () => {
    expect(matchBackgroundIntent('what music should I listen to while I work')).toBeNull()
    expect(matchBackgroundIntent('turn on focus mode while I work')).toBeNull()
    expect(matchBackgroundIntent('play some music in the background')).toBeNull()
    expect(matchBackgroundIntent('check my inbox for the invoice while I work')).toEqual({
      prompt: 'Check my inbox for the invoice'
    })
  })
})

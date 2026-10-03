// Answer cards (05 Phase R): tells the bar and the panel that a card set changed (an image
// loaded), so they re-read it with `cards:get`. Changes to one set within PUSH_MS go out once.
import { bus } from '../bus'
import * as assistant from './assistant'
import { sendTo } from './registry'
import * as panel from './settings'

const PUSH_MS = 150
const due = new Set<string>()

bus.on('cards.changed', (e) => {
  if (due.has(e.id)) return
  due.add(e.id)
  setTimeout(() => {
    due.delete(e.id)
    sendTo(assistant.get(), 'cards:changed', e.id)
    sendTo(panel.get(), 'cards:changed', e.id)
  }, PUSH_MS)
})

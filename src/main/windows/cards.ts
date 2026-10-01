// Answer cards (05 Phase R): tells the bar and the panel that a card set changed (an image
// loaded), so they re-read it with `cards:get`.
import { bus } from '../bus'
import { broadcast } from './registry'

bus.on('cards.changed', (e) => broadcast('cards:changed', e.id))

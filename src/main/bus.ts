// Typed in-process event bus (CONTRACTS C6). Features publish; window modules subscribe.
import { EventEmitter } from 'events'
import type { AppEvent, AppEventType } from '@shared/events'

export type EventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>

class Bus {
  private readonly ee = new EventEmitter()

  constructor() {
    this.ee.setMaxListeners(50)
  }

  emit(event: AppEvent): void {
    this.ee.emit(event.type, event)
  }

  /** Subscribes to one event type; returns the unsubscribe function. */
  on<T extends AppEventType>(type: T, fn: (event: EventOf<T>) => void): () => void {
    this.ee.on(type, fn)
    return () => {
      this.ee.off(type, fn)
    }
  }
}

export const bus = new Bus()

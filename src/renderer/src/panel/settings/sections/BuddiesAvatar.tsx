// A buddy's avatar (08 T53): its colour with its emoji or letter, ink picked for contrast.
// Decorative: the name next to it is the accessible label.
import type { BuddyLook } from '@shared/buddies'
import { avatarText, inkOn } from './buddies-view'
import './buddies.css'

export function BuddiesAvatar({
  look,
  name,
  size = 'md'
}: {
  look: BuddyLook
  name: string
  size?: 'sm' | 'md' | 'lg'
}): JSX.Element {
  return (
    <span
      className={`bd-avatar bd-avatar--${size}`}
      style={{ background: look.color, color: inkOn(look.color) }}
      aria-hidden="true"
    >
      {avatarText(look, name)}
    </span>
  )
}

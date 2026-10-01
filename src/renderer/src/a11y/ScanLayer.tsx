// Switch scanning on the screen layer (06 T09): a thick high-contrast ring (4px, black and
// yellow so it reads on any background) around the highlighted item with its number and
// name, or a menu panel listing the level with the highlighted row. Rects and the menu
// anchor arrive in this display's DIP. Main announces the item; the layer stays aria-hidden.
import type { ScanScene } from '@shared/events'
import { MENU_EDGE, placeMenu } from './place'

function rootFontPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

export function ScanLayer({ scan }: { scan: ScanScene }): JSX.Element {
  const { ring, menu } = scan
  const font = rootFontPx()
  let menuPos: { x: number; y: number } | null = null
  if (menu) {
    // Row height and width estimates in rem; the panel is sized by CSS, this only places it.
    const longest = Math.max(menu.title.length, ...menu.items.map((i) => i.length))
    const size = {
      w: Math.min(window.innerWidth - 2 * MENU_EDGE, (longest * 0.62 + 3) * font * 1.25),
      h: (menu.items.length * 2.3 + 2.6) * font * 1.25
    }
    menuPos = placeMenu(menu.at, size, { w: window.innerWidth, h: window.innerHeight })
  }
  return (
    <div className="a11y-scan" aria-hidden="true">
      {ring && (
        <div
          className={`a11y-scan-ring${ring.rect.y < font * 2.4 ? ' is-top' : ''}`}
          style={{
            left: ring.rect.x - 6,
            top: ring.rect.y - 6,
            width: ring.rect.w + 12,
            height: ring.rect.h + 12
          }}
        >
          <span className="a11y-scan-tag">
            {ring.n !== undefined && <b>{ring.n}</b>}
            <span>{ring.label}</span>
          </span>
        </div>
      )}
      {menu && menuPos && (
        <div className="a11y-scan-menu" style={{ left: menuPos.x, top: menuPos.y }}>
          <p className="a11y-scan-title">{menu.title}</p>
          <ol>
            {menu.items.map((label, i) => (
              <li key={`${i}-${label}`} className={i === menu.index ? 'is-on' : undefined}>
                {label}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { ScreenScene } from '@shared/events'
import { useIpc } from '../lib/ipc'
import { GridLayer } from '../a11y/GridLayer'
import { MarksLayer } from '../a11y/MarksLayer'
import { DwellRing, DwellUi } from '../a11y/DwellRing'
import '../a11y/a11y-layer.css'

export function ScreenApp(): JSX.Element {
  const [scene, setScene] = useState<ScreenScene | null>(null)
  useIpc('screen:render', setScene)
  return (
    <>
      <svg className="sl-root" width="100%" height="100%" aria-hidden="true">
        {scene?.highlights.map((h) => (
          <rect
            key={h.id}
            x={h.rect.x}
            y={h.rect.y}
            width={h.rect.w}
            height={h.rect.h}
            className="sl-ring"
          />
        ))}
      </svg>
      {scene?.grid && <GridLayer grid={scene.grid} />}
      {scene?.marks?.length ? <MarksLayer marks={scene.marks} /> : null}
      {scene?.dwellUi && <DwellUi ui={scene.dwellUi} />}
      <DwellRing />
    </>
  )
}

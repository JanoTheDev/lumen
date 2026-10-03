// File drop on the assistant bar (08 T21): files dragged from Explorer onto the card are shared
// with Lumen for this conversation (the preload turns the File into its path; main checks it).
// Nothing is uploaded here: main reads a file only when a request is about it. Each shared file
// shows as a chip with its name, size and a remove button.
import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import type { DroppedFileView, FileDropResult } from '@shared/channels'
import { IconButton, icons } from '../ui'
import { invoke } from '../lib/ipc'
import { formatSize, isFileDrag, MAX_DROP } from './files'
import './files.css'

export function FileChips({
  refreshKey,
  onShown
}: {
  refreshKey: string
  /** Whether the row is drawn (the bar stays compact without it). */
  onShown?: (shown: boolean) => void
}): JSX.Element | null {
  const [files, setFiles] = useState<DroppedFileView[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  })
  const shown = !!(files.length || dragging || error)
  useEffect(() => onShown?.(shown), [shown, onShown])

  // The list clears in main when the conversation ends: re-read it when the bar shows or hides,
  // and when a turn ends (a file pointed at during the turn joins the list).
  useEffect(() => {
    let alive = true
    invoke('assistant:files')
      .then((r) => {
        if (alive && Array.isArray(r)) setFiles(r)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [refreshKey])

  useEffect(() => {
    const over = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer?.types)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer?.types)) return
      e.preventDefault()
      setDragging(false)
      const list = Array.from(e.dataTransfer?.files ?? []).slice(0, MAX_DROP)
      void (async () => {
        let last: FileDropResult | null = null
        const errors: string[] = []
        for (const f of list) {
          last = await window.lumen.dropFile(f).catch(
            (): FileDropResult => ({
              ok: false,
              error: 'That file could not be shared.',
              files: filesRef.current
            })
          )
          if (!last.ok) errors.push(`${f.name}: ${last.error}`)
        }
        if (last && Array.isArray(last.files)) setFiles(last.files)
        setError(errors.join(' '))
      })()
    }
    window.addEventListener('dragenter', over)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', over)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const remove = (id: string): void => {
    invoke('assistant:file-remove', id)
      .then((r) => {
        if ('files' in r) setFiles(r.files)
      })
      .catch(() => {})
  }

  if (!shown) return null
  return (
    <div className="as-row as-files">
      {dragging && <p className="as-files__drop">Drop to share with Lumen</p>}
      {files.length > 0 && (
        <ul className="as-files__list" aria-label="Shared files">
          {files.map((f) => (
            <li key={f.id} className="as-file">
              <FileText aria-hidden="true" focusable="false" size="1.1em" strokeWidth={1.75} />
              <span className="as-file__name" title={f.name}>
                {f.name}
              </span>
              <span className="as-file__size tabular">{formatSize(f.size)}</span>
              <IconButton
                icon={icons.close}
                label={`Remove ${f.name}`}
                onClick={() => remove(f.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="as-files__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// Electron side of lesson recording (07 T30): picks the screen of the lesson's app, writes the
// webm pieces the hidden recorder window sends to Videos\Lumen, and finalises the file when
// Lumen quits. The decisions live in session.ts.
import { app, desktopCapturer, ipcMain, screen, type IpcMainEvent } from 'electron'
import { existsSync } from 'fs'
import { mkdir, open, stat, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { recorderChunkSchema, recorderStatusSchema } from '@shared/ipc'
import type { Rect } from '@shared/types'
import { physToLogical } from '../../actions/coords'
import { safeParse } from '../../ipc/validate'
import { log } from '../../logger'
import {
  closeRecorder,
  isRecorderSender,
  openRecorder,
  setCapturing,
  stopRecorder
} from '../../windows/recorder'
import { videoPaths } from './naming'
import { createLessonVideo, type LessonInfo, type LessonVideo, type OpenedFiles } from './session'
import type { StepEnd } from './transcript'

export interface LessonVideoHooks {
  lesson(): LessonInfo | null
  stepEnd(index: number): StepEnd | undefined
  /** The lesson app's window rect in physical px, when known. */
  appRect(): Promise<Rect | null>
  showDot(on: boolean): void
  say(text: string): void
  handled: unknown
}

/** The screen source of the display under `rect` (else the pointer's, else the first). */
async function pickSource(rect: Rect | null): Promise<{ sourceId: string; name: string } | null> {
  const at = rect
    ? physToLogical({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
    : screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(at)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  })
  const hit = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  return hit ? { sourceId: hit.id, name: hit.name } : null
}

async function openFiles(title: string, at: Date): Promise<OpenedFiles | { error: string }> {
  const paths = videoPaths(app.getPath('videos'), title, at, existsSync)
  if (!paths) return { error: 'there is no free file name in Videos, Lumen' }
  await mkdir(dirname(paths.video), { recursive: true })
  // wx: never over an existing file.
  const fh = await open(paths.video, 'wx')
  let closed = false
  return {
    video: paths.video,
    transcript: paths.transcript,
    sink: {
      write: async (chunk) => {
        await fh.write(chunk)
      },
      close: async () => {
        if (!closed) {
          closed = true
          await fh.close()
        }
        return (await stat(paths.video)).size
      },
      remove: () => unlink(paths.video)
    }
  }
}

export function installLessonVideo(hooks: LessonVideoHooks): LessonVideo {
  const video = createLessonVideo({
    now: () => Date.now(),
    lesson: hooks.lesson,
    stepEnd: hooks.stepEnd,
    pickSource: async () => pickSource(await hooks.appRect().catch(() => null)),
    openFiles,
    writeTranscript: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),
    openRenderer: () => openRecorder((why) => video.status({ state: 'error', error: why })),
    requestStop: stopRecorder,
    closeRenderer: closeRecorder,
    setCapturing,
    showDot: hooks.showDot,
    say: hooks.say,
    log: (msg) => log('plan', msg),
    handled: hooks.handled
  })

  ipcMain.handle('recorder:begin', (e) => (isRecorderSender(e.sender.id) ? video.begin() : null))
  ipcMain.on('recorder:chunk', (e: IpcMainEvent, raw: unknown) => {
    if (!isRecorderSender(e.sender.id)) return
    const chunk = safeParse('recorder:chunk', recorderChunkSchema, raw)
    if (chunk) video.chunk(chunk)
  })
  ipcMain.on('recorder:status', (e: IpcMainEvent, raw: unknown) => {
    if (!isRecorderSender(e.sender.id)) return
    const s = safeParse('recorder:status', recorderStatusSchema, raw)
    if (s) video.status(s)
  })

  // Quitting finalises the file first (at most a few seconds), then quits for real.
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting || video.phase() === 'idle') return
    quitting = true
    e.preventDefault()
    const wait = new Promise<void>((r) => setTimeout(r, 6000).unref?.())
    void Promise.race([video.stop('quit'), wait]).finally(() => app.quit())
  })
  return video
}

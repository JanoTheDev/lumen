// Whole-file writes through a temp file and a rename, sync or in the background. The newest
// write of a path wins: a background write that finishes after a newer one (or after `forget`)
// drops its temp file instead of renaming it over the newer content.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'

export class AtomicFiles {
  private readonly versions = new Map<string, number>()
  private seq = 0

  private next(file: string): number {
    const v = ++this.seq
    this.versions.set(file, v)
    return v
  }

  writeSync(file: string, text: string): void {
    const v = this.next(file)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${v}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  }

  /** Resolves once written (or dropped for a newer write); rejects when the write failed. */
  async write(file: string, text: string): Promise<void> {
    const v = this.next(file)
    const tmp = `${file}.${process.pid}.${v}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, text, 'utf8')
      if (this.versions.get(file) === v) renameSync(tmp, file)
      else rmSync(tmp, { force: true })
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }

  /** Writes still under way for `file` will not land (the file is being removed). */
  forget(file: string): void {
    this.next(file)
  }
}

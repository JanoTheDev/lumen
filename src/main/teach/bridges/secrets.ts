// Bridge settings with a secret in them (the OBS WebSocket password): encrypted with Windows
// DPAPI (Electron safeStorage) in <configDir>/bridges.dat, never in config.json. Without
// encryption they live in memory until Lumen closes.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { OBS_DEFAULT_PORT } from './obs-client'
import type { ObsSettings } from './obs'

export interface Cipher {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface Stored {
  obs?: { port?: number; password?: string }
}

export class BridgeSecrets {
  private data: Stored = {}

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {
    if (!existsSync(file) || !cipher.available()) return
    try {
      const v = JSON.parse(cipher.decrypt(readFileSync(file))) as unknown
      if (v && typeof v === 'object') this.data = v as Stored
    } catch {
      this.data = {}
    }
  }

  obs(): ObsSettings {
    const o = this.data.obs ?? {}
    const port =
      typeof o.port === 'number' && o.port > 0 && o.port < 65536 ? o.port : OBS_DEFAULT_PORT
    return {
      port,
      ...(typeof o.password === 'string' && o.password ? { password: o.password } : {})
    }
  }

  /** Returns whether it was written to disk (false: kept in memory only). */
  setObs(s: { port?: number; password?: string }): boolean {
    this.data.obs = {
      port: s.port ?? OBS_DEFAULT_PORT,
      ...(s.password ? { password: s.password } : {})
    }
    return this.save()
  }

  clearObs(): boolean {
    delete this.data.obs
    return this.save()
  }

  private save(): boolean {
    if (!this.cipher.available()) return false
    try {
      if (!Object.keys(this.data).length) {
        rmSync(this.file, { force: true })
        return true
      }
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, this.cipher.encrypt(JSON.stringify(this.data)))
      return true
    } catch {
      return false
    }
  }
}

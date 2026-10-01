// The address of the browser tab in front (native browser_url): the page in front counts as
// read for present_cards (05 T39). The agent bridge loads on first use (it pulls in Electron).
import { getAgent } from '../agent/instance'

export async function browserPageUrl(): Promise<string | null> {
  const agent = getAgent()
  if (!agent?.hasCapability('browser-url')) return null
  const commands = await import('../agent/commands')
  const r = await commands.browserUrl(agent).catch(() => null)
  return r?.url ?? null
}

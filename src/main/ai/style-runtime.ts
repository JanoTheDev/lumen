// Reply styles in the app: the active style block for prompts (config `ai.style` + the skills
// registry), the voice intercept and the style maker (the skill writer, kind style).
import type { ModelResponse } from '@shared/types'
import type { ActiveStyle, StyleInfo } from '@shared/styles'
import { loadConfig } from '../config'
import { log } from '../logger'
import { setDraftSource } from '../query/drafts'
import { INVALID } from '../ipc/validate'
import { getSkillRegistry } from '../skills'
import { writeNewSkill } from '../skills/manage'
import { listStyles, styleBlockFor } from './style'
import { authorSkill } from '../skills/compose'
import { createStyleMaker, type StyleMaker } from './style-make'
import { applyStyleCommand, matchStyleCommand } from './style-voice'

export function activeStyle(): ActiveStyle | null {
  return loadConfig().ai?.style ?? null
}

/** The fenced reply-style block for the user turn; '' when no style is on. */
export function activeStyleBlock(): string {
  return styleBlockFor(getSkillRegistry(), activeStyle())
}

export function styles(): StyleInfo[] {
  const r = getSkillRegistry()
  return r ? listStyles(r) : []
}

export async function setActiveStyle(s: ActiveStyle | null): Promise<boolean> {
  // Loaded on use: settings pulls in the window modules, which prompt code must not need.
  const { patchConfig } = await import('../ipc/settings')
  const r = await patchConfig({ ai: { style: s } })
  if (r === INVALID) return false
  log('plan', s ? `style: ${s.name}${s.level ? ` (${s.level})` : ''}` : 'style: off')
  return true
}

const answer = (text: string): ModelResponse => ({ mode: 'answer', text, spoken: text })

let maker: StyleMaker | null = null

function styleMaker(): StyleMaker {
  if (!maker) setDraftSource('style', () => maker?.draft()?.at ?? null)
  maker ??= createStyleMaker({
    now: () => Date.now(),
    async words(like) {
      const r = await authorSkill(
        { description: `a reply style: replies talk like ${like}`, kind: 'style' },
        { taken: (name) => !!getSkillRegistry()?.get(name) }
      )
      if (!r.ok) log('fail', `style draft: ${r.error}`)
      return r.ok
        ? {
            name: r.draft.name,
            description: r.draft.description,
            instructions: r.draft.instructions
          }
        : null
    },
    taken: (name) => !!getSkillRegistry()?.get(name),
    save(name, skillMd) {
      const registry = getSkillRegistry()
      if (!registry) return { ok: false, error: 'skills are not ready yet' }
      const r = writeNewSkill(registry, name, { skillMd })
      if (r.ok) log('done', `style ${name} saved`)
      return r.ok ? { ok: true } : r
    }
  })
  return maker
}

/** Voice: style on / off / level / which / make, and style draft review. undefined = not ours. */
export function interceptStyles(
  prompt: string
): ModelResponse | Promise<ModelResponse> | undefined {
  const reviewed = maker?.review(prompt)
  if (reviewed) return answer(reviewed)
  const list = styles()
  const active = activeStyle()
  const c = matchStyleCommand(prompt, list, active)
  if (!c) return undefined
  if (c.cmd === 'make') return styleMaker().make(c.like).then(answer)
  const r = applyStyleCommand(c, list, active)
  if (r.set === undefined) return answer(r.text)
  return setActiveStyle(r.set).then((ok) =>
    answer(ok ? r.text : 'I could not change the style setting.')
  )
}

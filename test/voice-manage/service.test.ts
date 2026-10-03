import { describe, expect, it, vi } from 'vitest'
import { chatKind, type ChatHeader, type ChatSummary } from '../../src/shared/task-chat'
import { grantLabel, ManageVoice, type ManageDeps } from '../../src/main/voice-manage/service'

const NOW = new Date(2026, 9, 3, 15, 0).getTime()

function header(id: string, title: string, over: Partial<ChatHeader> = {}): ChatHeader {
  return {
    id,
    kind: chatKind(id),
    title,
    phase: 'running',
    steps: 0,
    modelCalls: 0,
    costUsd: 0,
    startedAt: NOW,
    canStop: true,
    canPause: true,
    canResume: false,
    canRunAgain: false,
    canSteer: true,
    ...over
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeDeps(over: Partial<ManageDeps> = {}) {
  const rows: ChatSummary[] = []
  const headers = new Map<string, ChatHeader>()
  const addTask = (
    id: string,
    title: string,
    phase: ChatSummary['phase'],
    h: Partial<ChatHeader> = {}
  ): void => {
    rows.push({
      id,
      kind: chatKind(id),
      title,
      phase,
      at: NOW
    })
    headers.set(id, header(id, title, { phase, ...h }))
  }
  const control = vi.fn<ManageDeps['tasks']['control']>(() => ({ ok: true }))
  const autos = [
    {
      id: 'a1',
      name: 'Morning briefing',
      enabled: true,
      triggerText: 'every day at 08:00',
      running: false
    },
    {
      id: 'a2',
      name: 'Morning backup',
      enabled: true,
      triggerText: 'every day at 07:00',
      running: false
    },
    { id: 'a3', name: 'Inbox sweep', enabled: false, triggerText: 'every hour', running: false }
  ]
  const skills = [
    { name: 'invoice-helper', enabled: true, origin: 'user', triggers: ['send the invoice'] },
    { name: 'web-research', enabled: true, origin: 'builtin', triggers: [] }
  ]
  const grants = [{ scope: 'app:OUTLOOK.EXE' }, { scope: 'domain:github.com' }]
  const notes = [
    { id: 'n2', t: NOW - 5 * 60_000, text: 'Buy milk' },
    { id: 'n1', t: NOW - 3_600_000 * 30, text: 'Call the dentist' }
  ]
  const confirm = vi.fn(async () => true)
  const deps: ManageDeps = {
    now: () => NOW,
    confirm,
    confirmPending: () => false,
    tasks: {
      list: () => rows,
      header: (id) => headers.get(id) ?? null,
      control
    },
    automations: {
      list: () => autos,
      setEnabled: vi.fn(() => true),
      remove: vi.fn(() => true),
      runNow: vi.fn(() => true)
    },
    buddies: {
      list: () => [
        { id: 'inbox', name: 'Inbox Buddy' },
        { id: 'price', name: 'Price Buddy' }
      ],
      remove: vi.fn(() => true)
    },
    skills: {
      list: () => skills,
      setEnabled: vi.fn(() => true),
      remove: vi.fn(() => ({ ok: true }))
    },
    grants: { list: () => grants, revoke: vi.fn(() => true) },
    audit: {
      entries: vi.fn(() => [
        { ok: true, text: 'clicked “Reply”' },
        { ok: false, text: 'typed 4 characters: not done (you said no)' }
      ])
    },
    notes: { list: () => notes, remove: vi.fn(() => true) },
    memory: {
      export: vi.fn(async () => ({
        ok: true,
        path: 'C:\\Users\\me\\Downloads\\lumen-memory-2026-10-03.zip'
      })),
      deleteAll: vi.fn(() => ({ ok: true }))
    },
    connectors: {
      list: () => [
        { id: 'github', name: 'GitHub', transport: 'http', enabled: true, state: 'connected' },
        { id: 'files', name: 'Files', transport: 'stdio', enabled: false, state: 'off' }
      ],
      test: vi.fn(async () => ({ ok: true, toolCount: 12 })),
      signIn: vi.fn(async () => ({ ok: true })),
      notify: vi.fn()
    },
    guides: {
      list: () => [{ id: 'printer-x', name: 'Add a printer' }],
      remove: vi.fn(() => true)
    },
    diagnostics: {
      export: vi.fn(async () => ({
        ok: true,
        path: 'C:\\Users\\me\\Downloads\\Lumen-diagnostics.zip'
      }))
    },
    ...over
  }
  return { deps, addTask, control, confirm, headers }
}

const text = async (r: unknown): Promise<string> => ((await r) as { text: string }).text

describe('tasks', () => {
  it('lists open tasks', async () => {
    const { deps, addTask } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('what are you working on'))).toBe(
      'I’m not working on anything right now.'
    )
    addTask('bg_aaaa1', 'Check the lamp price', 'running')
    addTask('bg_aaaa2', 'Summarize my email', 'asking')
    addTask('bg_aaaa3', 'Old thing', 'done')
    const r = v.turn('what are you working on') as { text: string; spoken: string }
    expect(r.spoken).toContain('2 things')
    expect(r.spoken).toContain('Check the lamp price: working')
    expect(r.spoken).toContain('waiting for your answer')
    expect(r.spoken).not.toContain('Old thing')
  })

  it('stops a task by name', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Check the lamp price', 'running')
    addTask('bg_aaaa2', 'Summarize my email', 'running')
    const v = new ManageVoice(deps)
    expect(await text(v.turn('stop the lamp task'))).toBe('Stopped “Check the lamp price”.')
    expect(control).toHaveBeenCalledWith('bg_aaaa1', 'stop')
  })

  it('asks which one and takes the answer next turn', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Check the lamp price', 'running')
    addTask('bg_aaaa2', 'Check the sofa price', 'running')
    const v = new ManageVoice(deps)
    expect(await text(v.turn('pause the price task'))).toBe(
      'Which task: Check the lamp price or Check the sofa price?'
    )
    expect(control).not.toHaveBeenCalled()
    expect(await text(v.turn('the sofa one'))).toContain('Paused “Check the sofa price”')
    expect(control).toHaveBeenCalledWith('bg_aaaa2', 'pause')
  })

  it('a new request after "which" is parsed afresh', async () => {
    const { deps, addTask } = makeDeps()
    addTask('bg_aaaa1', 'Check the lamp price', 'running')
    addTask('bg_aaaa2', 'Check the sofa price', 'running')
    const v = new ManageVoice(deps)
    v.turn('stop the price task')
    expect(v.turn('open my email')).toBeNull()
    // the question is over
    expect(v.turn('the sofa one')).toBeNull()
  })

  it('prefers the task the action fits', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Check the lamp price', 'done', {
      canStop: false,
      canPause: false,
      canRunAgain: true
    })
    addTask('bg_aaaa2', 'Check the lamp price', 'running')
    const v = new ManageVoice(deps)
    await text(v.turn('stop the lamp task'))
    expect(control).toHaveBeenCalledWith('bg_aaaa2', 'stop')
  })

  it('says why when the action does not fit', async () => {
    const { deps, addTask } = makeDeps()
    addTask('bg_aaaa1', 'Check the lamp price', 'done', {
      canStop: false,
      canPause: false,
      canRunAgain: true
    })
    const v = new ManageVoice(deps)
    expect(await text(v.turn('stop the lamp task'))).toBe('“Check the lamp price” isn’t running.')
    expect(await text(v.turn('stop the weather task'))).toContain('I don’t see a task like')
  })

  it('runs a finished task again', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Check the lamp price', 'done', {
      canStop: false,
      canPause: false,
      canRunAgain: true
    })
    const v = new ManageVoice(deps)
    expect(await text(v.turn('run the lamp task again'))).toBe(
      'Running “Check the lamp price” again.'
    )
    expect(control).toHaveBeenCalledWith('bg_aaaa1', 'run-again')
  })

  it('stops all background tasks, not Claude sessions', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'One', 'running')
    addTask('bg_aaaa2', 'Two', 'running')
    addTask('cc_aaaa3', 'Claude', 'running')
    const v = new ManageVoice(deps)
    expect(await text(v.turn('stop all background tasks'))).toBe('Stopped 2 tasks.')
    expect(control).not.toHaveBeenCalledWith('cc_aaaa3', 'stop')
  })

  it('reads the waiting question and approves it with its token', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Summarize my email', 'asking', {
      question: {
        text: 'Keep going past the cost cap?',
        choices: ['Keep going', 'Stop'],
        token: 'q123'
      }
    })
    addTask('bg_aaaa2', 'Check the lamp price', 'running')
    const v = new ManageVoice(deps)
    const q = await text(v.turn('what’s the email task asking'))
    expect(q).toContain('Keep going past the cost cap?')
    expect(q).toContain('approve it')
    expect(await text(v.turn('is anything waiting for me'))).toContain('Keep going past')
    expect(await text(v.turn('approve it'))).toBe('Approved for “Summarize my email”.')
    expect(control).toHaveBeenCalledWith('bg_aaaa1', 'approve', 'q123')
  })

  it('uses a foreground confirm card’s id as the token', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('t_aaaa1', 'Book the table', 'confirm', { confirm: 'Click Book', confirmId: 'a77' })
    const v = new ManageVoice(deps)
    await text(v.turn('deny it'))
    expect(control).toHaveBeenCalledWith('t_aaaa1', 'deny', 'a77')
  })

  it('"approve it" with nothing waiting', async () => {
    const { deps } = makeDeps()
    expect(await text(new ManageVoice(deps).turn('approve it'))).toBe(
      'Nothing is waiting for an answer.'
    )
    // a bar confirm card answers its own words
    const { deps: d2 } = makeDeps({ confirmPending: () => true })
    expect(new ManageVoice(d2).turn('approve it')).toBeNull()
  })

  it('a free-text question is not approved', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Plan the trip', 'asking', {
      question: { text: 'Which city?', choices: [], token: 'q1' }
    })
    const v = new ManageVoice(deps)
    expect(await text(v.turn('approve it'))).toContain('needs a spoken answer')
    expect(control).not.toHaveBeenCalled()
  })

  it('asks which when several wait', async () => {
    const { deps, addTask, control } = makeDeps()
    addTask('bg_aaaa1', 'Summarize my email', 'asking', {
      question: { text: 'Go on?', choices: ['Allow', 'Deny'], token: 'q1' }
    })
    addTask('bg_aaaa2', 'Check the lamp price', 'asking', {
      question: { text: 'Go on?', choices: ['Allow', 'Deny'], token: 'q2' }
    })
    const v = new ManageVoice(deps)
    expect(await text(v.turn('approve it'))).toBe(
      'Which task: Summarize my email or Check the lamp price?'
    )
    await text(v.turn('the second one'))
    expect(control).toHaveBeenCalledWith('bg_aaaa2', 'approve', 'q2')
  })
})

describe('automations', () => {
  it('turns one off by name', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('turn off my morning briefing automation'))).toContain(
      'Turned off “Morning briefing”'
    )
    expect(deps.automations.setEnabled).toHaveBeenCalledWith('a1', false)
  })

  it('ambiguous name asks', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('turn off my morning routine'))).toBe(
      'Which automation: Morning briefing or Morning backup?'
    )
    await text(v.turn('backup'))
    expect(deps.automations.setEnabled).toHaveBeenCalledWith('a2', false)
  })

  it('delete goes through the confirm card', async () => {
    const { deps, confirm } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('delete the inbox sweep automation'))).toBe(
      'Deleted the automation “Inbox sweep”.'
    )
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Inbox sweep'), 'medium')
    expect(deps.automations.remove).toHaveBeenCalledWith('a3')
  })

  it('a no on the card keeps it', async () => {
    const { deps } = makeDeps({ confirm: async () => false })
    const v = new ManageVoice(deps)
    expect(await text(v.turn('delete the inbox sweep automation'))).toContain('kept')
    expect(deps.automations.remove).not.toHaveBeenCalled()
  })

  it('run now: only an automation that is not a buddy', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('run inbox sweep now'))).toBe('Running “Inbox sweep” now.')
    expect(deps.automations.runNow).toHaveBeenCalledWith('a3')
    // "run Inbox Buddy now" is the buddy's
    expect(v.turn('run inbox buddy now')).toBeNull()
    // a part of a name is not enough without the word automation
    expect(v.turn('run sweep now')).toBeNull()
    expect(v.turn('run the tests now')).toBeNull()
    // unknown names fall through (a skill may own the phrase)
    expect(v.turn('start my weather routine')).toBeNull()
  })

  it('unknown name with the noun says so', async () => {
    const { deps } = makeDeps()
    expect(await text(new ManageVoice(deps).turn('turn off the weather automation'))).toContain(
      'I don’t have an automation called “weather”'
    )
  })
})

describe('skills', () => {
  it('lists', async () => {
    const { deps } = makeDeps()
    expect(await text(new ManageVoice(deps).turn('what skills do I have'))).toContain(
      'invoice helper'
    )
  })

  it('turns off by name or trigger', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('turn off the invoice skill'))).toBe(
      'The invoice helper skill is off.'
    )
    expect(deps.skills.setEnabled).toHaveBeenCalledWith('invoice-helper', false)
  })

  it('deletes after the card; built-ins cannot be deleted', async () => {
    const { deps, confirm } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('delete the invoice helper skill'))).toBe(
      'Deleted the invoice helper skill.'
    )
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(await text(v.turn('delete the web research skill'))).toContain('comes with Lumen')
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('buddies', () => {
  it('deletes after the card', async () => {
    const { deps, confirm } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('delete Inbox Buddy'))).toBe('Deleted Inbox Buddy.')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Inbox Buddy'), 'medium')
    expect(deps.buddies.remove).toHaveBeenCalledWith('inbox')
  })

  it('unknown buddy; not a buddy at all', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('delete Weather Buddy'))).toContain('I don’t have a buddy called')
    expect(v.turn('remove the dead body')).toBeNull()
  })
})

describe('grants', () => {
  it('labels scopes', () => {
    expect(grantLabel('app:OUTLOOK.EXE').label).toBe('the app OUTLOOK')
    expect(grantLabel('domain:www.github.com').names).toContain('github')
    expect(grantLabel('scheme:mailto').label).toBe('email links')
    expect(grantLabel('mcp:notion/search').label).toBe('the notion connector’s search')
  })

  it('lists and revokes one without a card', async () => {
    const { deps, confirm } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('what have I always allowed'))).toContain('the site github.com')
    expect(await text(v.turn('stop always allowing Outlook'))).toContain('ask again')
    expect(deps.grants.revoke).toHaveBeenCalledWith('app:OUTLOOK.EXE')
    expect(await text(v.turn('stop always allowing github'))).toContain('ask again')
    expect(deps.grants.revoke).toHaveBeenCalledWith('domain:github.com')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('revoke all asks first', async () => {
    const { deps, confirm } = makeDeps()
    expect(await text(new ManageVoice(deps).turn('revoke all permissions'))).toBe(
      'Revoked 2 permissions. I’ll ask again each time.'
    )
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('audit, notes, memory, connectors, guides, diagnostics', () => {
  it('sums up today', async () => {
    const { deps } = makeDeps()
    const r = await text(new ManageVoice(deps).turn('what did you do today'))
    expect(r).toContain('2 actions')
    expect(r).toContain('1 was not done')
    const [from, to] = (deps.audit.entries as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(from).toBe(new Date(2026, 9, 3).getTime())
    expect(to).toBeGreaterThan(NOW)
  })

  it('reads and deletes notes', async () => {
    const { deps, confirm } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('read my last note'))).toBe(
      'Your last note, from 5 minutes ago: Buy milk'
    )
    expect(await text(v.turn('read my notes'))).toContain('2 notes')
    expect(await text(v.turn('delete my last note'))).toBe('Deleted your last note.')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Buy milk'), 'medium')
    expect(deps.notes.remove).toHaveBeenCalledWith('n2')
  })

  it('memory: export says where; delete-all is a high card', async () => {
    const { deps, confirm } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('export my memory'))).toContain('lumen-memory-2026-10-03.zip')
    expect(await text(v.turn('forget everything about me'))).toContain('forgotten everything')
    expect(confirm).toHaveBeenCalledWith(expect.any(String), 'high')
    expect(deps.memory.deleteAll).toHaveBeenCalled()
  })

  it('connectors: list, test, sign in', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('what connectors do I have'))).toContain('GitHub: connected')
    expect(await text(v.turn('test my github connector'))).toBe('GitHub works: 12 tools.')
    expect(await text(v.turn('sign in to GitHub'))).toContain('Opening the GitHub sign-in page')
    expect(deps.connectors.signIn).toHaveBeenCalledWith('github')
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.connectors.notify).toHaveBeenCalledWith('Signed in to GitHub.')
    expect(await text(v.turn('sign in to files'))).toContain('doesn’t need a sign-in')
    // not a connector: the browser's business
    expect(v.turn('sign in to Gmail')).toBeNull()
    expect(v.turn('connect to the wifi')).toBeNull()
  })

  it('guides', async () => {
    const { deps } = makeDeps()
    const v = new ManageVoice(deps)
    expect(await text(v.turn('list my guides'))).toContain('Add a printer')
    expect(await text(v.turn('delete the printer guide'))).toBe(
      'Deleted the guide “Add a printer”.'
    )
    expect(deps.guides.remove).toHaveBeenCalledWith('printer-x')
  })

  it('diagnostics', async () => {
    const { deps } = makeDeps()
    expect(await text(new ManageVoice(deps).turn('export diagnostics'))).toContain(
      'Lumen-diagnostics.zip'
    )
  })
})

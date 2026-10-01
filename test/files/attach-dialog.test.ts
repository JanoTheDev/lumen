import { describe, expect, it, vi } from 'vitest'
import type { Action, ElementNode } from '@shared/types'
import { attachFile, dialogFields, type AttachPorts } from '../../src/main/files/attach-dialog'
import type { SharedFile } from '../../src/main/files/store'

const node = (n: Partial<ElementNode>): ElementNode => ({
  id: 'e0',
  role: 'pane',
  name: '',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  monitorId: 0,
  enabled: true,
  patterns: [],
  ...n
})

// The Windows "Open" dialog Chrome shows for Gmail's paperclip (UIA as the agent reports it).
const DIALOG = node({
  id: 'e0',
  role: 'window',
  name: 'Open',
  children: [
    node({ id: 'e1', role: 'tree', name: 'Navigation pane' }),
    node({
      id: 'e2',
      role: 'list',
      name: 'Items View',
      children: [node({ id: 'e3', role: 'listitem', name: 'report.pdf' })]
    }),
    node({
      id: 'e4',
      role: 'combobox',
      name: 'File name:',
      automationId: '1148',
      patterns: ['expand', 'value'],
      children: [
        node({
          id: 'e5',
          role: 'edit',
          name: 'File name:',
          automationId: '1148',
          patterns: ['value', 'text']
        })
      ]
    }),
    node({
      id: 'e6',
      role: 'combobox',
      name: 'Files of type:',
      automationId: '1136',
      patterns: ['expand']
    }),
    node({ id: 'e7', role: 'splitbutton', name: 'Open', automationId: '1', patterns: ['invoke'] }),
    node({ id: 'e8', role: 'button', name: 'Cancel', automationId: '2', patterns: ['invoke'] })
  ]
})

const FILE: SharedFile = {
  id: 'f_abc12',
  name: 'Budget.xlsx',
  size: 10,
  kind: 'sheet',
  path: 'C:\\Users\\ana\\Documents\\Lumen\\Budget.xlsx',
  fresh: false
}

function ports(over: Partial<AttachPorts> = {}): AttachPorts & { ran: Action[][] } {
  const ran: Action[][] = []
  return {
    ran,
    file: (id) => (id === FILE.id ? FILE : undefined),
    check: async (path) => ({ ok: true, path, name: 'Budget.xlsx', size: 10, kind: 'sheet' }),
    foreground: async () => ({ title: 'Open', process: 'chrome.exe', className: '#32770' }),
    snapshot: async () => DIALOG,
    run: async (actions) => {
      ran.push(actions)
      return { executed: actions.length, blocked: false }
    },
    closed: async () => true,
    ...over
  }
}

describe('dialogFields', () => {
  it('finds the File name edit and the Open button', () => {
    const f = dialogFields(DIALOG)
    expect(f?.nameField.id).toBe('e5')
    expect(f?.okButton?.id).toBe('e7')
  })

  it('is null without a file dialog', () => {
    expect(
      dialogFields(
        node({ children: [node({ role: 'edit', name: 'To recipients', patterns: ['value'] })] })
      )
    ).toBeNull()
  })
})

describe('attachFile', () => {
  it('fills the dialog with the shared file path and presses Open', async () => {
    const p = ports()
    const r = await attachFile(FILE.id, p)
    expect(r.isError).toBeUndefined()
    expect(p.ran[0]).toEqual([
      {
        type: 'uia_act',
        elementId: 'e5',
        action: 'set_value',
        value: FILE.path,
        description: 'File name'
      },
      { type: 'uia_act', elementId: 'e7', action: 'invoke', description: 'Open' }
    ])
  })

  it('takes only ids of shared files, never paths', async () => {
    const p = ports()
    const r = await attachFile('C:\\Windows\\System32\\config\\SAM', p)
    expect(r.isError).toBe(true)
    expect(p.ran).toHaveLength(0)
  })

  it('works only in a browser or Outlook dialog that is open', async () => {
    const other = ports({ foreground: async () => ({ title: 'Open', process: 'notepad.exe' }) })
    expect((await attachFile(FILE.id, other)).isError).toBe(true)
    const noDialog = ports({
      snapshot: async () => node({ role: 'window', name: 'Inbox - Gmail' })
    })
    const r = await attachFile(FILE.id, noDialog)
    expect(r.isError).toBe(true)
    expect(noDialog.ran).toHaveLength(0)
    const outlook = ports({
      foreground: async () => ({ title: 'Insert File', process: 'OUTLOOK.EXE' })
    })
    expect((await attachFile(FILE.id, outlook)).isError).toBeUndefined()
  })

  it('reports a policy denial and a dialog that stays open', async () => {
    const denied = ports({
      run: async () => ({ executed: 0, blocked: true, denied: { reason: 'not confirmed' } })
    })
    expect((await attachFile(FILE.id, denied)).content[0]).toMatchObject({
      text: expect.stringMatching(/^E_DENIED: not confirmed/)
    })
    const stuck = ports({ closed: async () => false })
    expect((await attachFile(FILE.id, stuck)).isError).toBe(true)
  })

  it('presses Enter when the dialog has no Open button it can find', async () => {
    const tree = node({
      children: [node({ id: 'e9', role: 'edit', name: 'File name:', patterns: ['value'] })]
    })
    const check = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      name: 'Budget.xlsx',
      size: 10,
      kind: 'sheet' as const
    }))
    const p = ports({ snapshot: async () => tree, check })
    await attachFile(FILE.id, p)
    expect(p.ran[0][1]).toEqual({ type: 'hotkey', keys: ['enter'] })
    expect(check).toHaveBeenCalledWith(FILE.path)
  })
})

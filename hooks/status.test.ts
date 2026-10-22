import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

type World = { branch?: string; numstat?: string; percent?: number; colorfgbg?: string; model?: string; records?: Record<string, unknown>[] }

const ACCENT_DARK = '#3987e5'
const ACCENT_LIGHT = '#2a78d6'
const CRITICAL = '#d03b3b'
const WARNING = '#fab219'

function world(on: On, w: World = {}) {
  const percent = w.percent ?? 32
  mock.clock(on, { now: Date.parse('2026-10-09T18:00:00Z') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ws' } }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.version', () => ({ value: { version: '2.1.295', release: '2.1.295' } }))
  on('session.model', () => ({ value: w.model ?? 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: percent * 10_000, window: 1_000_000, percent },
      rateLimits: [{ kind: 'seven_day', percentUsed: 48, resetsAt: '2026-10-10T18:00:00Z' }],
    },
  }))
  on('env.get', ($, e) => ({ value: e.name === 'COLORFGBG' ? w.colorfgbg : e.name === 'HOME' && w.records ? '/home/r' : undefined }))
  const records = w.records ?? []
  on('fs.list', () => ({ value: records.map(r => ({ name: `${r.sessionId}.json`, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: JSON.stringify(records.find(r => e.path.endsWith(`/${r.sessionId}.json`)) ?? {}) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const isRepo = w.branch !== undefined
    const stdout = e.argv.includes('rev-parse') ? `${w.branch ?? ''}\n` : (w.numstat ?? '')
    return {
      value: {
        exitCode: isRepo ? 0 : 128,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.render', () => ENGINE)
}

const ENGINE: RenderElement = { type: 'Text', children: ['engine hint line'] }

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const HINT = {
  plugin: 'workstreams',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '(shift+tab to cycle) · PR #2299 · ← 5 agents' },
} as const

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) =>
  ui.findAll({ type: 'Text' })

test('draws model and context, then version, usage and the engine hint without the cycle note or PR', async ($, on) => {
  world(on, { branch: 'lane-mods' })
  await $.session.start(start)

  const ui = await $.ui.mount(HINT)

  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /32% 320k\/1\.0M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · v2.1.295' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · week ' })).toBeDefined()
  // 48% used with 6 of 7 days gone: behind an even pace.
  expect(await ui.find({ type: 'Text', text: ' 48%/86%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◇' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ← 5 agents' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↻|shift\+tab|PR #/ })).toBeUndefined()
})

test('draws the row as one Text cut at its end, so no part wraps', async ($, on) => {
  world(on, { branch: 'lane-mods' })
  await $.session.start(start)

  const ui = await $.ui.mount({ ...HINT, viewport: { columns: 60, rows: 1 } })
  const [line] = ((await ui.drawn()) as { children: unknown[] }).children
  expect(line).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
})

test('shows a model it does not know by its id', async ($, on) => {
  world(on, { model: 'some-local-model' })
  await $.session.start(start)

  const ui = await $.ui.mount(HINT)

  expect(await ui.find({ type: 'Text', text: 'some-local-model' })).toBeDefined()
})

test('fills the context meter in the accent color below 60%', async ($, on) => {
  world(on, { branch: 'main', percent: 32 })
  await $.session.start(start)

  const ui = await $.ui.mount(HINT)
  const fill = (await texts(ui)).find(t => t.text.startsWith('█'))

  expect(fill?.text).toBe('███')
  expect(fill?.props.color).toBe(ACCENT_DARK)
})

test('colors each cell by where it sits: amber from 60%, red from 80%', async ($, on) => {
  world(on, { branch: 'main', percent: 86 })
  await $.session.start(start)

  const ui = await $.ui.mount(HINT)
  const cells = (await texts(ui)).filter(t => /^[█▏▎▍▌▋▊▉]+$/.test(t.text))

  // The context meter comes first; the usage bars follow it.
  expect(cells.slice(0, 3).map(t => [t.text, t.props.color])).toEqual([
    ['██████', ACCENT_DARK],
    ['██', WARNING],
    ['▋', CRITICAL],
  ])
})

test('uses the light palette when COLORFGBG says the background is light', async ($, on) => {
  world(on, { branch: 'main', colorfgbg: '0;15' })
  await $.session.start(start)

  const ui = await $.ui.mount(HINT)
  const fill = (await texts(ui)).find(t => t.text.startsWith('█'))

  expect(fill?.props.color).toBe(ACCENT_LIGHT)
})

test('passes to the engine before it has any figures', async ($, on) => {
  world(on)

  const ui = await $.ui.mount(HINT)

  expect(await ui.drawn()).toMatchObject(ENGINE)
})

test('shows this session\'s lane, branch and changes in the band above the prompt', async ($, on) => {
  world(on, { branch: 'lane-mods', numstat: '12\t3\ta.ts\n' })
  await $.session.start(start)

  const ui = await $.ui.mount({ plugin: 'workstreams', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)

  expect(await ui.find({ type: 'Link', text: 'repo' })).toMatchObject({ props: { href: 'file:///repo' } })
  expect(await ui.find({ type: 'Text', text: '  lane-mods  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+12' })).toBeDefined()
})

// Other sessions' records, as the 10 s watch reads them.
const other = (sessionId: string, state: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  cwd: `/code/acme-api/.claude/worktrees/${sessionId}`,
  state,
  context: { percent: 0, tokens: 0, window: 0 },
  model: '',
  version: '',
  stateSince: '2026-10-09T17:00:00Z',
  updatedAt: '2026-10-09T17:59:30Z',
  ...over,
})

test('counts the other sessions that need you and that work, in the status line', async ($, on) => {
  world(on, {
    records: [
      other('ask', 'approve', { ask: { kind: 'permission', text: 'Bash: ls' } }),
      other('busy', 'working'),
      other('s-1', 'working'),
    ],
  })
  await $.session.start(start)

  const all = await texts(await $.ui.mount({ ...HINT } as never))

  expect(all.find(t => t.text === ' ●1')).toBeDefined()
  expect(all.find(t => t.text === ' ◌1')).toBeDefined()
})

test('names the session that has waited on you longest on the band, with how many more', async ($, on) => {
  world(on, {
    branch: 'lane-mods',
    records: [
      other('newer', 'pick', { stateSince: '2026-10-09T17:30:00Z', ask: { kind: 'question', text: 'Which one?', options: [] } }),
      other('older', 'approve', { ask: { kind: 'permission', text: 'Bash: ls' } }),
    ],
  })
  await $.session.start(start)

  const ui = await $.ui.mount({ plugin: 'workstreams', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)

  expect(await ui.find({ type: 'Text', text: 'acme-api / older' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · Bash: ls' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · +1 more' })).toBeDefined()
})

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionRecord } from '../types'

const DIR = '/home/r/.claude/workstreams'
const NOW = Date.parse('2026-10-09T18:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * 60 * MIN

function rec(sessionId: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId,
    cwd: `/code/${sessionId}`,
    state: 'your-turn',
    context: { percent: 10, tokens: 100_000, window: 1_000_000 },
    model: 'claude-opus-5-5[1m]',
    version: '2.1.295',
    stateSince: ago(5 * MIN),
    // A live session rewrites its record every minute.
    updatedAt: ago(30_000),
    ...over,
  }
}

type Lane = { branch: string; numstat?: string; porcelain?: string; ahead?: number; pr?: Record<string, unknown>; worktreeOf?: string }
type World = { files: Record<string, string>; gone?: string[]; inCmux?: boolean; tree?: string; agents?: Record<string, unknown>[]; lanes?: Record<string, Lane>; limits?: { kind: string; percentUsed: number; resetsAt?: string }[]; jobs?: Record<string, Record<string, unknown>>; store?: Record<string, unknown> }

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

let lastClock: { advance: (ms: number) => Promise<unknown> } | undefined
const runs: string[] = []
const cwds: Record<string, string | undefined> = {}
const prompts: string[] = []
const opened: Record<string, unknown>[] = []
const closed: string[] = []
const resumed: string[] = []
const copied: string[] = []
const toasts: string[] = []

function world(on: On, w: World) {
  runs.length = copied.length = toasts.length = prompts.length = opened.length = closed.length = resumed.length = 0
  on('command.run', { command: 'exit' }, () => {
    resumed.push('/exit')
    return { text: '' }
  })
  on('command.run', { command: 'background' }, () => {
    resumed.push('/background')
    return { text: '' }
  })
  on('command.run', { command: 'resume' }, ($, e) => {
    resumed.push(e.args)
    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: NOW })
  lastClock = clock
  mock.env(on, { HOME: '/home/r', ...(w.inCmux ? { CMUX_WORKSPACE_ID: 'W-HERE', CMUX_SURFACE_ID: 'S-HERE' } : {}) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'panel-self' }))
  on('command.register', () => ({ value: { command: 'ws' } }))
  on('ui.open', ($, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  const store = new Map(Object.entries(w.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: e.path === DIR ? Object.keys(w.files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) : [],
  }))
  on('fs.read', ($, e) => {
    const job = e.path.match(/^\/home\/r\/\.claude\/jobs\/([^/]+)\/state\.json$/)?.[1]
    if (job) {
      if (!w.jobs?.[job]) throw new Error('ENOENT')
      return { value: JSON.stringify(w.jobs[job]) }
    }
    return { value: e.path.startsWith(`${DIR}/`) ? (w.files[e.path.slice(DIR.length + 1)] ?? '') : '' }
  })
  on('fs.exists', ($, e) => ({ value: !(w.gone ?? []).includes(e.path) }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: w.limits ?? [] } }))
  on('process.run', ($, e) => {
    const lane = w.lanes?.[e.init?.cwd ?? '']
    const argv = e.argv.join(' ')
    runs.push(argv)
    cwds[argv] = e.init?.cwd
    if (argv === 'cmux tree --all') return ran(w.tree ?? '')
    if (argv.startsWith('cmux ')) return ran('OK\n')
    if (argv === 'claude agents --json --all') return ran(JSON.stringify(w.agents ?? []))
    if (argv.startsWith('git -C ')) return ran('')
    if (argv.startsWith('rm ')) return ran('')
    if (argv.startsWith('claude stop ')) return ran(`stopped ${e.argv[2]}\n`)
    if (argv.startsWith('claude rm ')) return ran('kept the worktree: it has unpushed commits\n', 1)
    if (argv.startsWith('claude --bg ')) return ran('started 7f3a91c2\n')
    if (argv === 'gh api user --jq .login') return ran('randall\n')
    if (!lane) return ran('', 128)
    if (argv.endsWith('--git-common-dir')) return ran(`${lane.worktreeOf ?? '/code/main'}/.git\n`)
    if (argv.endsWith('--git-dir')) return ran(lane.worktreeOf ? `${lane.worktreeOf}/.git/worktrees/x\n` : '/code/main/.git\n')
    if (argv.startsWith('git rev-parse')) return ran(`${lane.branch}\n`)
    if (argv.startsWith('git diff')) return ran(lane.numstat ?? '120\t30\thooks/register.tsx\n22\t7\tdocs/design.md\n')
    if (argv.startsWith('git status')) return ran(lane.porcelain ?? '')
    if (argv.startsWith('git rev-list')) return ran(`${lane.ahead ?? 0}\n`)
    if (argv.startsWith('gh pr view')) return lane.pr ? ran(JSON.stringify(lane.pr)) : ran('', 1)
    return ran('', 1)
  })
  return clock
}

const files = (...records: SessionRecord[]) =>
  Object.fromEntries(records.map(r => [`${r.sessionId}.json`, JSON.stringify(r)]))

const PANE = {
  plugin: 'workstreams',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'workstreams',
  props: { title: 'workstreams', isFocused: false, bodyColumns: 80, placement: 'dock' },
} as const

// Enter on the selected row: a press once the ring has rested there, not the click that put it there.
async function enter($: Engine, ui: { drawn: () => Promise<unknown> }) {
  const tree = JSON.stringify(await ui.drawn())
  const key = tree.match(/"key":"(row:[^"]+)","plain":true,"autoFocus":true/)?.[1] ?? tree.match(/"key":"(row:[^"]+)"/)?.[1]
  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: key ?? '' })
}

async function open($: Engine) {
  await $.command.run({ command: 'ws', args: '' } as never)
  // Pane props carry engine-owned fields the test does not need.
  return $.ui.mount(PANE as never)
}

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// A row's lead (tree line, glyph, unread mark) is a Client, which the kit does not draw: its props stand in.
function flat(n: unknown): string {
  if (typeof n === 'string') return n
  const node = n as Drawn
  if (node?.type === 'Client') {
    const lead = (node.props?.props ?? {}) as { tree?: string; glyph?: string; isUnread?: boolean }
    return `${lead.tree ?? ''}${lead.glyph ?? ''} ${lead.isUnread ? '✦ ' : '  '}`
  }
  // The tree line under a wrapped ask's first line is checked on its own.
  return (node?.children ?? []).filter(c => (c as Drawn)?.props?.key !== 'lead-more').map(flat).join('')
}

function rowsIn(n: unknown, out: string[] = []) {
  const node = n as Drawn
  if (String(node?.props?.key ?? '').startsWith('row-')) out.push(flat(node))
  else node?.children?.forEach(child => rowsIn(child, out))
  return out
}

// Each row as text, from its glyph on: the selection bar, the tree line and the padding after the glyph are dropped.
const rowTexts = async (ui: { drawn: () => Promise<unknown> }) =>
  rowsIn(await ui.drawn()).map(t => t.replace(/^[▎ ][├└]─ /, '').replace(/^(\S) +/, '$1 '))

test('lists sessions that need you first, then your turn, then working', async ($, on) => {
  world(on, {
    files: files(
      rec('w', { cwd: '/code/lane/.claude/worktrees/w', state: 'working', lastInstruction: 'run the tests' }),
      rec('y', { cwd: '/code/lane/.claude/worktrees/y', lastTurn: 'Done.\nReady to merge?' }),
      rec('a', { cwd: '/code/lane/.claude/worktrees/a', state: 'approve', ask: { kind: 'permission', text: 'Bash: mise run migrate' } }),
    ),
  })

  const rows = await rowTexts(await open($))

  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^● Bash: mise run migrate .* 5m$/)
  expect(rows[1]).toMatch(/^○ Ready to merge\? .* 5m$/)
  expect(rows[2]).toMatch(/^◌ run the tests .* —$/)
})

test('skips a record it cannot parse', async ($, on) => {
  world(on, { files: { ...files(rec('ok')), 'half.json': '{"sessionId": "ha' } })

  expect(await rowTexts(await open($))).toHaveLength(1)
})

test('marks a session with no write in 2 minutes with resume', async ($, on) => {
  world(on, { files: files(rec('quiet', { lastTurn: 'Bye', updatedAt: ago(3 * MIN) })) })

  const [row] = await rowTexts(await open($))

  expect(row).toMatch(/Bye ↻ resume/)
})

test('shows a live session in a removed directory as orphaned, and drops a dead one', async ($, on) => {
  world(on, { files: files(rec('live'), rec('dead', { updatedAt: ago(3 * MIN) })), gone: ['/code/live', '/code/dead'] })

  const rows = await rowTexts(await open($))

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatch(/^⚠ directory removed/)
})

test('shows one row per directory, from its newest record', async ($, on) => {
  world(on, {
    files: files(
      rec('old', { cwd: '/code/lane', lastTurn: 'old answer', updatedAt: ago(DAY) }),
      rec('new', { cwd: '/code/lane', lastTurn: 'new answer' }),
    ),
  })

  const rows = await rowTexts(await open($))

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatch(/new answer/)
})

test('dims a row idle for more than 7 days and puts it last', async ($, on) => {
  world(on, {
    files: files(rec('stale', { stateSince: ago(8 * DAY), updatedAt: ago(8 * DAY), lastTurn: 'old work' }), rec('fresh', { state: 'working' })),
  })

  const ui = await open($)
  const rows = await rowTexts(ui)

  expect(rows[1]).toMatch(/8d$/)
  expect(await ui.find({ type: 'Text', text: /^ *8d$/ })).toMatchObject({ props: { dimColor: true } })
})

test('shows your last instruction in dim when a your-turn row has no answer, and new session when it has neither', async ($, on) => {
  world(on, { files: files(rec('silent', { lastInstruction: 'review this change' }), rec('fresh', { stateSince: ago(MIN) })) })

  const ui = await open($)
  const rows = await rowTexts(ui)

  expect(rows[0]).toMatch(/new session/)
  expect(rows[1]).toMatch(/review this change/)
  expect(await ui.find({ type: 'Button', text: 'review this change' })).toMatchObject({ props: { dimColor: true } })
})

test('keeps type, resume and age at full width so only the ask is cut', async ($, on) => {
  world(on, { files: files(rec('long', { lastTurn: 'x'.repeat(300), updatedAt: ago(3 * MIN) })) })

  const ui = await open($)
  type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const boxes: Node[] = []
  const walk = (n: unknown) => {
    const node = n as Node
    if (node?.type === 'Box') boxes.push(node)
    node?.children?.forEach(walk)
  }
  walk(await ui.drawn())
  const row = boxes.find(b => b.props?.key === 'row-long')
  const parts = (row?.children ?? []) as Node[]

  expect(parts.map(p => p.props?.flexShrink)).toEqual([0, 1, 0])
  // The lead is 7 columns, and the ask's width leaves room for every fixed part and the scrollbar.
  const lead = ((parts[0]?.children ?? []) as Node[]).find(c => c.props?.key === 'lead')
  expect(((lead?.children ?? []) as Node[]).find(c => c.type === 'Client')?.props?.width).toBe(7)
})

const pr = (number: number, state: string, author: string, extra: Record<string, unknown> = {}) => ({
  number,
  state,
  author: { login: author },
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  reviewDecision: '',
  ...extra,
})

test('shows a your-turn lane on someone else\'s open PR as REVIEW, with the PR column', async ($, on) => {
  world(on, {
    files: files(rec('rev', { lastTurn: 'diff ready' }), rec('mine', { lastTurn: 'Ready to merge?' })),
    lanes: {
      '/code/rev': { branch: 'pr-2701', pr: pr(2701, 'OPEN', 'teammate') },
      '/code/mine': { branch: 'feat/x', pr: pr(2689, 'OPEN', 'randall') },
    },
  })

  const rows = await rowTexts(await open($))

  expect(rows[0]).toMatch(/^○ Ready to merge\?/)
  expect(rows[1]).toMatch(/^◆ diff ready/)
})

test('offers WRAP? for a clean, pushed lane whose PR merged', async ($, on) => {
  world(on, { files: files(rec('done')), lanes: { '/code/done': { branch: 'feat/done', pr: pr(2667, 'MERGED', 'randall') } } })

  const ui = await open($)
  const [row] = await rowTexts(ui)

  expect(row).toMatch(/^✓ PR #2667 merged · clean/)
  expect(JSON.stringify(await ui.drawn())).toContain('"props":{"strikethrough":true},"children":["PR #2667"]')
})

test('counts passing, failing and pending checks on the PR', async ($, on) => {
  const checks = [{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { state: 'PENDING' }]
  world(on, {
    files: files(rec('panel-self', { cwd: '/code/mine' })),
    lanes: { '/code/mine': { branch: 'feat/mine', pr: pr(12, 'OPEN', 'randall', { statusCheckRollup: checks }) } },
  })

  const ui = await open($)

  expect(await ui.find({ type: 'Text', text: '#12 ✓2 ✕1 ·1 ✗appr' })).toBeDefined()
})

test('counts rows by type in the header, and f steps through the filters', async ($, on) => {
  world(on, {
    files: files(
      rec('ask', { cwd: '/code/a/ask', state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } }),
      rec('w', { cwd: '/code/b/w', state: 'working' }),
      rec('idle', { cwd: '/code/c/idle', updatedAt: ago(10 * MIN), lastTurn: 'done' }),
    ),
  })
  const ui = await open($)
  const header = async () => JSON.stringify(await ui.drawn()).match(/"children":\["workstreams"\]\},\{"type":"Text","props":\{"dimColor":true\},"children":\["([^"]*)"/)?.[1]?.replace(/ ─+$/, '')
  const listed = async () => (await rowTexts(ui)).map(t => t.split(' ')[0])

  expect(await header()).toBe(' 3 · ●1 ○1 ◌1')
  expect(await listed()).toEqual(['●', '◌', '○'])

  await $.ui.press({ plugin: 'workstreams', key: 'filter' })
  expect(await header()).toBe(' 1 of 3 · ●1 ○1 ◌1 · needs you')
  expect(await listed()).toEqual(['●'])

  await $.ui.press({ plugin: 'workstreams', key: 'filter' })
  expect(await listed()).toEqual(['◌'])

  await $.ui.press({ plugin: 'workstreams', key: 'filter' })
  expect(await listed()).toEqual(['○'])
  expect(await ui.find({ type: 'Text', text: /f show all$/ })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'filter' })
  expect(await listed()).toHaveLength(3)
})

test('keeps a merged lane with uncommitted changes as your turn', async ($, on) => {
  world(on, { files: files(rec('dirty')), lanes: { '/code/dirty': { branch: 'feat/d', porcelain: ' M a.ts\n', pr: pr(1, 'MERGED', 'randall') } } })

  const [row] = await rowTexts(await open($))

  expect(row).toMatch(/^○ /)
})

test('previews the selected lane, and j moves the selection down', async ($, on) => {
  world(on, {
    files: files(
      rec('a', { state: 'pick', ask: { kind: 'question', text: 'Which timezone?', options: ['Phone', 'Site'] }, cwd: '/code/web-app/.claude/worktrees/send-time' }),
      rec('b', { lastTurn: 'All done.', lastInstruction: 'wire the schedule' }),
    ),
    lanes: { '/code/web-app/.claude/worktrees/send-time': { branch: 'feat/send-time' } },
  })

  const ui = await open($)

  expect(await ui.find({ type: 'Link', text: 'b' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'wire the schedule' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'All done.' })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'next' })

  expect(await ui.find({ type: 'Link', text: 'web-app / send-time' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which timezone?  1. Phone  2. Site' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+142' })).toBeDefined()
})

test('draws the weekly pace meter with its label and reset time', async ($, on) => {
  // Half the week gone, 75% used: projected 150%, so it runs out early.
  world(on, { files: files(rec('a')), limits: [{ kind: 'seven_day', percentUsed: 75, resetsAt: new Date(NOW + 3.5 * DAY).toISOString() }] })

  const ui = await open($)

  expect(await ui.find({ type: 'Text', text: 'week ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 75%/50% ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /runs out ~1d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↻ 3d/ })).toBeDefined()
})

test('go focuses a live session in its cmux surface', async ($, on) => {
  world(on, { files: files(rec('live', { cmux: { surface: 'S-1', workspace: 'W-1' } })) })

  const ui = await open($)
  await enter($, ui)

  expect(runs).toContain('cmux select-workspace --workspace W-1')
  expect(runs).toContain('cmux focus-panel --panel S-1 --workspace W-1')
  expect(copied).toEqual([])
  expect(closed).toEqual(['workstreams'])
})

test('go copies the resume command for a running session outside cmux', async ($, on) => {
  world(on, { files: files(rec('away')) })

  const ui = await open($)
  await enter($, ui)

  expect(copied).toEqual(["cd '/code/away' && claude --resume away"])
  expect(toasts[0]).toMatch(/^Copied: cd/)
  expect(resumed).toEqual([])
})

test('toasts when another lane turns to need you, and stays quiet for a new session', async ($, on) => {
  const w: World = { files: files(rec('other', { state: 'working' })) }
  const clock = world(on, w)
  await $.session.start({ cwd: '/code/me', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)

  w.files = files(rec('other', { state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } }), rec('fresh'))
  await clock.advance(10_000)

  expect(toasts).toEqual(['other: APPROVE · Bash: ls'])
})

test('wrap refuses a running session and names why', async ($, on) => {
  world(on, { files: files(rec('live')) })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'wrap' })

  expect(await ui.find({ type: 'Text', text: /wrap refused: the session is still running/ })).toBeDefined()
})

test('wrap hands a finished lane to this session\'s agent once y confirms', async ($, on) => {
  const lane = '/code/repo/.claude/worktrees/done'
  world(on, { files: files(rec('done', { cwd: lane, updatedAt: ago(3 * MIN), lastTurn: 'done' })) })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'wrap' })

  expect(await ui.find({ type: 'Text', text: `  Use the /wrap skill to wrap up the workstream at ${lane}.` })).toBeDefined()
  expect(prompts).toEqual([])

  await $.ui.press({ plugin: 'workstreams', key: 'confirm' })

  expect(prompts).toEqual([`Use the /wrap skill to wrap up the workstream at ${lane}.`])
})

test('x stops a running background session once y confirms, and toasts what claude said', async ($, on) => {
  world(on, { files: {}, agents: [{ id: 'b554b746', sessionId: 'b554b746-9430', kind: 'background', cwd: '/code/pp', name: 'advisory', state: 'working', pid: 9 }] })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'close' })

  expect(await ui.find({ type: 'Text', text: 'stop advisory?' })).toBeDefined()
  expect(runs.some(r => r.startsWith('claude stop'))).toBe(false)

  await $.ui.press({ plugin: 'workstreams', key: 'ask-confirm' })

  expect(runs).toContain('claude stop b554b746')
  expect(toasts).toContain('claude stop: stopped b554b746')
})

test('x deletes a stopped background session, and names why when claude rm keeps it', async ($, on) => {
  world(on, { files: {}, agents: [{ id: 'b554b746', sessionId: 'b554b746-9430', kind: 'background', cwd: '/code/pp', name: 'advisory', state: 'done' }] })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'close' })

  expect(await ui.find({ type: 'Text', text: 'delete advisory?' })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'ask-confirm' })

  expect(runs).toContain('claude rm b554b746')
  expect(toasts).toContain('claude rm failed: kept the worktree: it has unpushed commits')
})

test('x leaves a session running in a tab alone, and takes a stopped one off the list', async ($, on) => {
  world(on, { files: files(rec('live'), rec('old', { cwd: '/code/old', updatedAt: ago(3 * MIN), lastTurn: 'done' })) })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'close' })

  expect(await ui.find({ type: 'Text', text: /can't close live: it runs in a tab/ })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'ask-cancel' })
  await $.ui.press({ plugin: 'workstreams', key: 'next' })
  await $.ui.press({ plugin: 'workstreams', key: 'close' })
  await $.ui.press({ plugin: 'workstreams', key: 'ask-confirm' })

  expect(runs).toContain('rm -f /home/r/.claude/workstreams/old.json')
  expect(runs).not.toContain('rm -f /home/r/.claude/workstreams/live.json')
})

test('c asks for a prompt, then starts a background session in the selected row\'s project', async ($, on) => {
  world(on, { files: files(rec('lane', { cwd: '/code/acme-api/.claude/worktrees/send-time' })) })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'new' })

  expect(await ui.find({ type: 'Text', text: 'new background session in /code/acme-api' })).toBeDefined()

  const submit = (value: string) =>
    $.ui.input({ plugin: 'workstreams', key: 'new-prompt', text: value } as never)
  await submit('fix the flaky test')

  expect(runs).toContain('claude --bg fix the flaky test')
  expect(cwds['claude --bg fix the flaky test']).toBe('/code/acme-api')
  expect(toasts).toContain('claude --bg: started 7f3a91c2')
})

test('c does nothing when the prompt is left empty', async ($, on) => {
  world(on, { files: files(rec('lane')) })

  await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'new' })
  await $.ui.input({ plugin: 'workstreams', key: 'new-prompt', text: '  ' } as never)

  expect(runs.some(r => r.startsWith('claude --bg'))).toBe(false)
})

// The test engine cannot raise ui.close, so stopping the scan on close is checked by hand.
test('opens the pane with the keyboard and closes it on esc', async ($, on) => {
  world(on, { files: files(rec('a')) })

  await open($)

  expect(opened[0]).toMatchObject({ id: 'workstreams', focus: true, closeOnEscape: true })
})

test('lists background sessions that write no record, from claude agents', async ($, on) => {
  world(on, {
    files: files(rec('mine', { lastTurn: 'hi' })),
    agents: [
      { sessionId: 'bg-1', kind: 'background', cwd: '/code/acme-api', name: 'default dashboard', state: 'blocked', status: 'idle', pid: 10, startedAt: NOW - DAY },
      { sessionId: 'bg-2', kind: 'background', cwd: '/code/acme-api', name: 'review open branches', state: 'working', status: 'busy', pid: 11, startedAt: NOW - DAY },
      { sessionId: 'bg-3', kind: 'background', cwd: '/code/pp', name: 'Read-only analysis', state: 'blocked', startedAt: NOW - DAY },
      { sessionId: 'mine', kind: 'interactive', cwd: '/code/mine', status: 'busy', pid: 12, startedAt: NOW - DAY },
    ],
  })

  const rows = await rowTexts(await open($))

  expect(rows).toHaveLength(4)
  // Projects alphabetically: /code/acme-api, /code/mine, /code/pp.
  expect(rows[0]).toMatch(/^● default dashboard/)
  expect(rows[1]).toMatch(/^◌ review open branches/)
  expect(rows[2]).toMatch(/^○ hi/)
  expect(rows[3]).toMatch(/^● Read-only analysis ↻ resume/)
})

test('fills a background row from its job state, found by the agents view id', async ($, on) => {
  world(on, {
    files: files(rec('mine', { lastTurn: 'hi' })),
    agents: [
      // The live session id differs from the job folder's name, which is the agents view id.
      { id: 'b87bcf42', sessionId: 'de0c5a7b-live', kind: 'background', cwd: '/code/acme-api', name: 'default dashboard', state: 'blocked', status: 'idle', pid: 10, startedAt: NOW - DAY },
      { id: 'f2458493', sessionId: '98872496-live', kind: 'background', cwd: '/code/gap', name: 'review open branches', state: 'working', status: 'busy', pid: 11, startedAt: NOW - DAY },
    ],
    jobs: {
      b87bcf42: {
        state: 'blocked',
        needs: 'Separate ticket, or fold the fix into #2686?',
        detail: 'Separate ticket, or fold the fix into #2686?',
        intent: 'build the default dashboard',
        children: [
          { id: '2630', href: 'https://github.com/o/r/pull/2630', kind: 'pr' },
          { id: '2686', href: 'https://github.com/o/r/pull/2686', kind: 'pr' },
          { id: 'mock.html', href: 'https://claude.ai/artifact/x', kind: 'frame' },
        ],
        updatedAt: ago(40 * MIN),
      },
      f2458493: { state: 'working', detail: 'lanes 1-4 still running', updatedAt: ago(MIN) },
    },
  })

  const ui = await open($)
  const rows = await rowTexts(ui)

  expect(rows[0]).toMatch(/^● default dashboard · Separate ticket, or fold the fix into\s#2686\? +40m$/)
  expect(rows[1]).toMatch(/^◌ review open branches · lanes 1-4 still running .* —$/)

  // The first row is selected, so the banner and preview show it.
  expect(await ui.find({ type: 'Link', text: '#2686' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /build the default dashboard/ })).toBeDefined()
})

test('marks a row that changed since it was last selected, and selecting it clears the mark', async ($, on) => {
  world(on, {
    files: files(
      rec('panel-self', { cwd: '/code/a/self', stateSince: ago(MIN) }),
      rec('done', { cwd: '/code/b/done', lastTurn: 'Finished.', stateSince: ago(2 * MIN) }),
      rec('old', { cwd: '/code/c/old', lastTurn: 'Earlier.', stateSince: ago(DAY) }),
    ),
    store: { seen: { floor: ago(HOUR), ids: {} } },
  })

  const ui = await open($)
  let rows = await rowTexts(ui)

  // The panel's own session is never unread; one that finished before the floor is not either.
  expect(rows[0]).toMatch(/^○ (?!✦)/)
  expect(rows[1]).toMatch(/^○ ✦ Finished\./)
  expect(rows[2]).toMatch(/^○ Earlier\./)

  await $.ui.press({ plugin: 'workstreams', key: 'next' })
  rows = await rowTexts(ui)

  expect(rows[1]).toMatch(/^○ Finished\./)
})

test('marks nothing unread on the first open ever', async ($, on) => {
  world(on, { files: files(rec('done', { lastTurn: 'Finished.', stateSince: ago(2 * MIN) })) })

  const rows = await rowTexts(await open($))

  expect(rows[0]).toMatch(/^○ Finished\./)
})

test('u jumps to the next row that needs you or is unread, from the top again after the last', async ($, on) => {
  world(on, {
    files: files(
      rec('panel-self', { cwd: '/code/a/self' }),
      rec('w', { cwd: '/code/b/w', state: 'working', lastInstruction: 'run the tests' }),
      rec('ask', { cwd: '/code/c/ask', state: 'approve', ask: { kind: 'permission', text: 'Bash: rm -rf build' } }),
      rec('done', { cwd: '/code/d/done', lastTurn: 'Finished.', stateSince: ago(2 * MIN) }),
    ),
    store: { seen: { floor: ago(HOUR), ids: {} } },
  })

  const ui = await open($)

  await $.ui.press({ plugin: 'workstreams', key: 'next-for-you' })
  expect(await ui.find({ type: 'Link', text: 'ask' })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'next-for-you' })
  expect(await ui.find({ type: 'Link', text: 'done' })).toBeDefined()

  // The approve row still needs you, so u comes back around to it.
  await $.ui.press({ plugin: 'workstreams', key: 'next-for-you' })
  expect(await ui.find({ type: 'Link', text: 'ask' })).toBeDefined()
})

test('keeps a multi-line ask on one row, and leaves blank versions out', async ($, on) => {
  world(on, {
    files: files(rec('multi', { lastInstruction: 'Review this change\n\nfor security', version: '2.1.295' }), rec('old', { version: '2.1.286' })),
    agents: [{ sessionId: 'bg', kind: 'background', cwd: '/code/bg', name: 'bg work', state: 'working', pid: 1 }],
  })

  const ui = await open($)

  expect(await ui.find({ type: 'Text', text: 'Review this change for security' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'versions  2.1.295 · 2.1.286' })).toBeDefined()
})

test('shows key help in place of usage on h and hides it on h again', async ($, on) => {
  world(on, { files: files(rec('a')), limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 3.5 * DAY).toISOString() }] })

  const ui = await open($)
  expect(await ui.find({ type: 'Text', text: /↑\/↓  move/ })).toBeUndefined()

  await $.ui.press({ plugin: 'workstreams', key: 'help' })
  expect(await ui.find({ type: 'Text', text: /↑\/↓  move/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'asked  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'week ' })).toBeUndefined()

  await $.ui.press({ plugin: 'workstreams', key: 'help' })
  expect(await ui.find({ type: 'Text', text: /↑\/↓  move/ })).toBeUndefined()
})

test('names a row from claude agents, and lists an interactive session that writes no record', async ($, on) => {
  world(on, {
    files: files(rec('named')),
    agents: [
      { sessionId: 'named', kind: 'interactive', cwd: '/code/named', name: 'django-upgrade-31', status: 'idle', pid: 3 },
      { sessionId: 'old-tab', kind: 'interactive', cwd: '/code/old', name: 'Workstreams mod status row', status: 'busy', pid: 4 },
    ],
  })

  const rows = await rowTexts(await open($))

  expect(rows[0]).toMatch(/^○ django-upgrade-31/)
  expect(rows[1]).toMatch(/^◌ Workstreams mod status row/)
})

test('groups rows by project alphabetically, with ~/Code/ as an icon', async ($, on) => {
  world(on, {
    files: files(
      rec('calm', { cwd: '/home/r/Code/billing-web', state: 'working' }),
      rec('lane', { cwd: '/home/r/Code/acme-api/.claude/worktrees/send-time', state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } }),
      rec('root', { cwd: '/home/r/Code/acme-api', lastTurn: 'done' }),
    ),
  })

  const ui = await open($)
  const headers = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.startsWith('⌂'))

  expect(headers).toEqual(['⌂ acme-api', '⌂ billing-web'])
})

test('dims a finished session that is not running and puts it last in its project', async ($, on) => {
  world(on, {
    files: {},
    agents: [
      { sessionId: 'done', kind: 'background', cwd: '/code/acme-api', name: 'old work', state: 'done' },
      { sessionId: 'idle', kind: 'background', cwd: '/code/acme-api', name: 'live work', state: 'done', pid: 5 },
    ],
  })

  const ui = await open($)
  const rows = await rowTexts(ui)

  expect(rows[0]).toMatch(/live work/)
  expect(rows[1]).toMatch(/old work/)
  expect(await ui.find({ type: 'Button', text: 'old work' })).toMatchObject({ props: { dimColor: true } })
})

test('go opens a stopped session in a new cmux tab, leaving this session alone', async ($, on) => {
  world(on, { inCmux: true, files: files(rec('quiet', { updatedAt: ago(3 * MIN), lastTurn: 'bye' })) })

  const ui = await open($)
  await enter($, ui)

  expect(runs).toContain('cmux new-surface --workspace W-HERE --working-directory /code/quiet --command claude --resume quiet --focus true')
  expect(resumed).toEqual([])
  expect(closed).toEqual(['workstreams'])
})

test('go opens a background session in a new cmux tab through claude attach, as the agents view does', async ($, on) => {
  world(on, {
    inCmux: true,
    files: {},
    agents: [{ id: 'b554b746', sessionId: 'b554b746-9430', kind: 'background', cwd: '/code/pp', name: 'advisory', state: 'blocked', pid: 9 }],
  })

  const ui = await open($)
  await enter($, ui)

  expect(runs).toContain('cmux new-surface --workspace W-HERE --working-directory /code/pp --command claude attach b554b746 --focus true')
  expect(runs.some(r => r.includes('/exit'))).toBe(false)
  expect(resumed).toEqual([])
})

test('deletes the record of a session whose folder is gone and that is not running', async ($, on) => {
  world(on, { files: files(rec('dead', { updatedAt: ago(3 * MIN) })), gone: ['/code/dead'] })

  await open($)

  expect(runs).toContain('rm -f /home/r/.claude/workstreams/dead.json')
})

test('scrolls the list in a window so the preview and usage stay in view', async ($, on) => {
  const many = Array.from({ length: 30 }, (_, i) => rec(`s${String(i).padStart(2, '0')}`, { cwd: `/code/p/.claude/worktrees/l${i}`, lastTurn: `answer ${i}` }))
  world(on, { files: files(...many) })

  await $.command.run({ command: 'ws', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 24 } } } as never)

  expect((await rowTexts(ui)).length).toBeLessThan(30)
  // A scrollbar beside the list: its thumb at the top, over the track.
  const drawn = JSON.stringify(await ui.drawn())
  const at = drawn.indexOf('"scrollbar"')
  const bar = [...drawn.slice(at).matchAll(/"children":\["([┃│])"\]/g)].map(m => m[1])
  expect(bar[0]).toBe('┃')
  expect(bar.at(-1)).toBe('│')
  expect(await ui.find({ type: 'Text', text: /── preview/ })).toBeDefined()
})

test('holds the list still while the selection moves inside the window', async ($, on) => {
  const many = Array.from({ length: 30 }, (_, i) => rec(`s${String(i).padStart(2, '0')}`, { cwd: `/code/p/.claude/worktrees/l${i}`, lastTurn: `answer ${i}` }))
  world(on, { files: files(...many) })

  await $.command.run({ command: 'ws', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 24 } } } as never)
  const top = await rowTexts(ui)
  for (let i = 0; i < 6; i++) await $.ui.press({ plugin: 'workstreams', key: 'next' })
  const scrolled = await rowTexts(ui)
  expect(scrolled[0]).not.toBe(top[0])

  await $.ui.press({ plugin: 'workstreams', key: 'prev' })

  expect(await rowTexts(ui)).toEqual(scrolled)
})

type Lead = { tree: string; glyph: string; mode: string; flash?: number; isUnread: boolean }

// Each row's lead Client props, by row id.
async function leads(ui: { drawn: () => Promise<unknown> }) {
  const out: Record<string, Lead> = {}
  const walk = (n: unknown) => {
    const node = n as Drawn
    const key = String(node?.props?.key ?? '')
    if (node?.type === 'Client' && key.startsWith('lead-')) out[key.slice(5)] = node.props?.props as Lead
    node?.children?.forEach(walk)
  }
  walk(await ui.drawn())
  return out
}

test('draws tree lines in each project, a bar on the selected row, and a hint for it', async ($, on) => {
  world(on, {
    files: files(
      rec('panel-self', { cwd: '/code/p/.claude/worktrees/self' }),
      rec('ask', { cwd: '/code/p/.claude/worktrees/ask', state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } }),
    ),
  })

  const ui = await open($)
  const lead = await leads(ui)
  const drawn = JSON.stringify(await ui.drawn())

  expect(lead.ask?.tree).toBe('├─ ')
  expect(lead['panel-self']?.tree).toBe('└─ ')
  expect(drawn).toContain('"children":["▎"]')
  expect(await ui.find({ type: 'Text', text: '  ⏎ switch · u next for you' })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'prev' })

  expect(await ui.find({ type: 'Text', text: '  ⏎ switch and answer · u next for you' })).toBeDefined()
})

test('carries the tree line onto a wrapped ask\'s second line, and stops it after the last row', async ($, on) => {
  const long = 'Which of the two schedules should the reminder follow when they disagree about the send time?'
  world(on, {
    files: files(
      rec('first', { cwd: '/code/p/.claude/worktrees/a', state: 'approve', ask: { kind: 'permission', text: long } }),
      rec('last', { cwd: '/code/p/.claude/worktrees/b', state: 'approve', ask: { kind: 'permission', text: long } }),
    ),
  })

  const more: Record<string, string> = {}
  const walk = (n: unknown, row = '') => {
    const node = n as Drawn
    const key = String(node?.props?.key ?? '')
    if (key === 'lead-more') more[row] = flat({ children: node.children })
    node?.children?.forEach(c => walk(c, key.startsWith('row-') ? key.slice(4) : row))
  }
  walk(await (await open($)).drawn())

  expect(Object.keys(more).sort()).toEqual(['first', 'last'])
  expect(Object.values(more).filter(t => t.includes('│'))).toHaveLength(1)
})

test('pulses WORKING rows and breathes rows that wait on you', async ($, on) => {
  world(on, {
    files: files(
      rec('w', { cwd: '/code/a/w', state: 'working' }),
      rec('ask', { cwd: '/code/b/ask', state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } }),
      rec('idle', { cwd: '/code/c/idle' }),
    ),
  })

  const lead = await leads(await open($))

  expect([lead.w?.mode, lead.ask?.mode, lead.idle?.mode]).toEqual(['pulse', 'breathe', 'still'])
})

test('flashes a row whose type changed while the panel was open', async ($, on) => {
  const w: Parameters<typeof world>[1] = { files: files(rec('a', { state: 'working' }), rec('b')) }
  const clock = world(on, w)
  const ui = await open($)

  expect((await leads(ui)).a?.flash).toBeUndefined()

  w.files = files(rec('a', { state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } }), rec('b'))
  await clock.advance(10_000)
  const lead = await leads(ui)

  expect(lead.a?.flash).toBeDefined()
  expect(lead.b?.flash).toBeUndefined()
})

test('holds still with motion off: no pulse, no flash, no sliding meters', { options: { motion: 'off' } }, async ($, on) => {
  world(on, { files: files(rec('w', { state: 'working' })), limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 3.5 * DAY).toISOString() }] })

  const ui = await open($)
  const drawn = JSON.stringify(await ui.drawn())

  expect((await leads(ui)).w?.mode).toBe('still')
  expect(drawn).not.toContain('meter.tsx')
})

test('slides the panel meters with motion on, and holds still while the person types', async ($, on) => {
  world(on, { files: files(rec('w', { state: 'working' })), limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 3.5 * DAY).toISOString() }] })
  on('prompt.edit', ($, e) => ({ text: e.text, cursor: e.cursor }) as never)

  const ui = await open($)

  expect(JSON.stringify(await ui.drawn())).toContain('meter.tsx')

  // The kit raises prompt.edit as the composer does, though its typings leave the call off the test engine.
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'h' })

  expect((await leads(ui)).w?.mode).toBe('still')
  expect(JSON.stringify(await ui.drawn())).not.toContain('meter.tsx')

  await lastClock?.advance(1500)

  expect((await leads(ui)).w?.mode).toBe('pulse')
})

// The preview's recap and files, each line as label and text.
async function preview(ui: { drawn: () => Promise<unknown> }) {
  const drawn = (await ui.drawn()) as Drawn
  const out: string[] = []
  const walk = (n: unknown) => {
    const node = n as Drawn
    if (node?.props?.key === 'preview') return void node.children?.slice(1).forEach(c => out.push(flat(c)))
    node?.children?.forEach(walk)
  }
  walk(drawn)
  return out
}

test('recaps the last turn: what you asked, what its tools did, how it ended and what is next', async ($, on) => {
  world(on, {
    files: files(rec('panel-self', { cwd: '/code/mine', lastInstruction: 'wire the schedule', did: 'edited 2 files · ran 3 commands', lastTurn: 'Wired it.\nTests pass.\nShip it?' })),
    lanes: { '/code/mine': { branch: 'feat/mine', numstat: '120\t30\thooks/deep/register.tsx\n0\t15\told.ts\n' } },
  })

  const lines = await preview(await open($))

  expect(lines.slice(2)).toEqual([
    'asked  wire the schedule',
    'did    edited 2 files · ran 3 commands',
    'result Wired it.',
    '       Tests pass.',
    'next   Ship it?',
    'files  ████████  +120 −30  …/deep/register.tsx',
    '       █         +0 −15  old.ts',
    '       ',
  ])
})

test('names what comes next for a row that waits on you', async ($, on) => {
  world(on, {
    files: files(rec('panel-self', { cwd: '/code/mine', state: 'pick', ask: { kind: 'question', text: 'Which zone?', options: ['Phone', 'Site'] } })),
  })

  const lines = await preview(await open($))

  expect(lines).toContain('next   pick 1–2')
  expect(lines).toContain('files  —')
})

test('cuts a long ask to two lines', async ($, on) => {
  world(on, { files: files(rec('long', { lastTurn: 'word '.repeat(200) })) })

  const ui = await open($)
  const [row] = await rowTexts(ui)
  // The row's two lines in one Text, the preview's ask line, and its result line.
  const lines = (await ui.findAll({ type: 'Text' })).filter(t => t.text.startsWith('word'))

  expect(lines).toHaveLength(3)
  expect(lines[0]?.text.split('\n')).toHaveLength(2)
  expect(row).toMatch(/…/)
})

test('starts on this session, with folder, branch, changes and a PR link in the banner', async ($, on) => {
  world(on, {
    files: files(rec('aaa-other', { cwd: '/code/a' }), rec('panel-self', { cwd: '/code/repo/.claude/worktrees/mine' })),
    lanes: { '/code/repo/.claude/worktrees/mine': { branch: 'feat/mine', pr: pr(12, 'OPEN', 'randall', { url: 'https://github.com/o/r/pull/12' }) } },
  })

  const ui = await open($)

  expect(await ui.find({ type: 'Link', text: 'repo / mine' })).toMatchObject({ props: { href: 'file:///code/repo/.claude/worktrees/mine' } })
  expect(await ui.find({ type: 'Text', text: '  feat/mine' })).toBeDefined()
  // Removed in red and added in green, so blue stays the accent.
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('{"color":"#e66767"},"children":[" −37"]')
  expect(drawn).toContain('{"color":"#3fb950"},"children":[" +142"]')
  expect(await ui.find({ type: 'Link', text: '#12 ✓1 ✗appr' })).toMatchObject({ props: { href: 'https://github.com/o/r/pull/12' } })
})

test('j walks the rows in the order they are drawn and stops at the last', async ($, on) => {
  world(on, { files: files(rec('b2', { cwd: '/code/b/.claude/worktrees/2' }), rec('a1', { cwd: '/code/a' }), rec('b1', { cwd: '/code/b/.claude/worktrees/1' })) })

  const ui = await open($)
  const seen: string[] = []
  for (let i = 0; i < 4; i++) {
    // The banner names the selected lane.
    seen.push((await ui.find({ type: 'Link', text: /^(a|b \/ \d)$/ }))?.text ?? '')
    await $.ui.press({ plugin: 'workstreams', key: 'next' })
  }

  expect(seen).toEqual(['a', 'b / 1', 'b / 2', 'b / 2'])
})

test('shows a session listed twice by claude agents once, as its live entry, so j can move past it', async ($, on) => {
  world(on, {
    files: {},
    agents: [
      { id: 'dup', sessionId: 'dup-1', kind: 'background', cwd: '/code/a', name: 'twice', state: 'stopped' },
      { sessionId: 'dup-1', kind: 'interactive', cwd: '/code/a', name: 'twice', status: 'busy', pid: 7 },
      { sessionId: 'next-1', kind: 'background', cwd: '/code/b', name: 'after', state: 'done', pid: 8 },
    ],
  })

  const ui = await open($)
  const rows = await rowTexts(ui)
  await $.ui.press({ plugin: 'workstreams', key: 'next' })

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatch(/^◌ twice/)
  expect(await ui.find({ type: 'Link', text: /^b$/ })).toBeDefined()
})

test('a press on a row that is not selected selects it, and a second press opens it', async ($, on) => {
  world(on, { files: files(rec('a1', { cwd: '/code/a', updatedAt: ago(3 * MIN), lastTurn: 'x' }), rec('b1', { cwd: '/code/b', updatedAt: ago(3 * MIN), lastTurn: 'y' })) })

  const ui = await open($)
  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: 'row:b1' })

  expect(copied).toEqual([])
  expect(await ui.find({ type: 'Link', text: /^b$/ })).toBeDefined()

  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: 'row:b1' })

  expect(copied).toEqual(["cd '/code/b' && claude --resume b1"])
})

test('leaves out a session that ended without a prompt, so it cannot hide the one that worked in its folder', async ($, on) => {
  world(on, {
    files: files(
      rec('worked', { cwd: '/code/lane', lastTurn: 'did the work', updatedAt: ago(10 * MIN) }),
      rec('empty', { cwd: '/code/lane', updatedAt: ago(3 * MIN) }),
    ),
  })

  const rows = await rowTexts(await open($))

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatch(/did the work/)
})

test('n and p jump to the next and previous project', async ($, on) => {
  world(on, {
    files: files(
      rec('a1', { cwd: '/code/a/.claude/worktrees/1', lastTurn: 'x' }),
      rec('a2', { cwd: '/code/a/.claude/worktrees/2', lastTurn: 'x' }),
      rec('b1', { cwd: '/code/b', lastTurn: 'x' }),
    ),
  })

  const ui = await open($)
  await $.ui.press({ plugin: 'workstreams', key: 'next-group' })
  expect(await ui.find({ type: 'Link', text: /^b$/ })).toBeDefined()

  await $.ui.press({ plugin: 'workstreams', key: 'prev-group' })
  expect(await ui.find({ type: 'Link', text: 'a / 1' })).toBeDefined()
})

const ADVISORY = { id: 'b554b746', sessionId: 'b554b746-9430', kind: 'background', cwd: '/code/pp', name: 'advisory', state: 'blocked', pid: 9 }

test('from a normal session, Enter backgrounds it and has the shell attach the chosen background session', async ($, on) => {
  world(on, { inCmux: true, files: files(rec('panel-self', { cwd: '/code/me', lastInstruction: 'work' })), agents: [ADVISORY] })

  await open($)
  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: 'row:b554b746-9430' })
  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: 'row:b554b746-9430' })

  const typed = runs.find(r => r.startsWith('sh -c nohup'))
  expect(typed?.endsWith(' cmux S-HERE W-HERE claude attach b554b746')).toBe(true)
  expect(resumed).toEqual(['/background'])
})

test('from a background session, Enter detaches and picks the chosen one in the agents view by name', async ($, on) => {
  world(on, {
    inCmux: true,
    files: {},
    agents: [{ id: 'mine0001', sessionId: 'panel-self', kind: 'background', cwd: '/code/me', name: 'my lane', state: 'working', pid: 5 }, ADVISORY],
    tree: '        ├── surface surface:9 [terminal] "my lane" tty=ttys009\n        ├── surface surface:8 [terminal] "other" tty=ttys008',
  })

  await open($)
  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: 'row:b554b746-9430' })
  await lastClock?.advance(1000)
  await $.ui.press({ plugin: 'workstreams', key: 'row:b554b746-9430' })
  await lastClock?.advance(5000)

  expect(resumed).toEqual(['/exit'])
  expect(runs).toContain('cmux send --surface surface:9 --workspace W-HERE n:advisory')
  expect(runs).toContain('cmux send-key --surface surface:9 --workspace W-HERE enter')
})

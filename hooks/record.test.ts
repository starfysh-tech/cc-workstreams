import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PATH = '/home/r/.claude/workstreams/s-1.json'
const T0 = Date.parse('2026-10-09T18:00:00Z')

function world(on: On) {
  const files: Record<string, string> = {}
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/r' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ws' } }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.version', () => ({ value: { version: '2.1.295', release: '2.1.295' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 90_000, window: 1_000_000, percent: 9 }, rateLimits: [] },
  }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const w = {
    clock,
    record: () => JSON.parse(files[PATH] ?? 'null'),
    // The record as it stood while the tool ran, before the hook's own after-step.
    duringTool: undefined as unknown,
  }
  on('tool.call', () => {
    w.duringTool = w.record()
    return { result: {} }
  })
  on('classic.PermissionRequest', () => ({}))
  return w
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const done = (answer: string, agentId?: string) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId: 't-1',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

test('writes an idle record when the session starts', async ($, on) => {
  const w = world(on)
  await $.session.start(start)

  expect(w.record()).toEqual({
    sessionId: 's-1',
    cwd: '/repo',
    state: 'your-turn',
    context: { percent: 9, tokens: 90_000, window: 1_000_000 },
    model: 'claude-opus-5-5[1m]',
    version: '2.1.295',
    stateSince: '2026-10-09T18:00:00.000Z',
    updatedAt: '2026-10-09T18:00:00.000Z',
  })
})

test('is working from turn start, with the instruction cut to its first 500 chars', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await w.clock.advance(60_000)
  await $.turn.start({ text: 'x'.repeat(600), turnId: 't-1' })

  expect(w.record()).toMatchObject({ state: 'working', lastInstruction: 'x'.repeat(500), stateSince: '2026-10-09T18:01:00.000Z' })
})

test('keeps the typed instruction when the harness starts a turn with a tagged message', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'wire the schedule', turnId: 't-1' })
  await $.turn.start({ text: '<agent-message from="a95d"> [Subagent hand-off] done', turnId: 't-2' })

  expect(w.record()).toMatchObject({ state: 'working', lastInstruction: 'wire the schedule' })
})

test('is your turn when the turn ends, keeping the last 500 chars of the answer', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.turn.complete(done(`${'a'.repeat(600)}Ship it?`))

  expect(w.record().state).toBe('your-turn')
  expect(w.record().lastTurn).toHaveLength(500)
  expect(w.record().lastTurn.endsWith('Ship it?')).toBe(true)
})

test('records what the turn\'s own tools did, and clears it when the next turn starts', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts', agentId: 'agent-1' } as never)
  await $.turn.complete(done('Done.'))

  expect(w.record().did).toBe('edited 2 files · ran 1 command')

  await $.turn.start({ text: 'again', turnId: 't-2' })

  expect(w.record().did).toBeUndefined()

  await $.turn.complete(done('Nothing to do.'))

  expect(w.record().did).toBe('no tools')
})

test('ignores a subagent finishing its turn', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.turn.complete(done('sub done', 'agent-7'))

  expect(w.record().state).toBe('working')
  expect(w.record().lastTurn).toBeUndefined()
})

test('keeps state and stateSince when only the figures change', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await w.clock.advance(60_000)
  await $.session.start(start)

  expect(w.record().stateSince).toBe('2026-10-09T18:00:00.000Z')
  expect(w.record().updatedAt).toBe('2026-10-09T18:01:00.000Z')
})

test('rewrites the record every minute so the panel knows the session runs', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await w.clock.advance(60_000)

  expect(w.record().updatedAt).toBe('2026-10-09T18:01:00.000Z')
  expect(w.record().stateSince).toBe('2026-10-09T18:00:00.000Z')
})

test('is pick with the first question and its options while AskUserQuestion waits', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      { question: 'Which lane?', header: 'Lane', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    ],
  })

  expect(w.duringTool).toMatchObject({ state: 'pick', ask: { kind: 'question', text: 'Which lane?', options: ['A', 'B'] } })
  expect(w.record().state).toBe('working')
  expect(w.record().ask).toBeUndefined()
})

test('is approve with the tool and command while a permission dialog is up', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'mise run migrate' } })

  expect(w.record()).toMatchObject({ state: 'approve', ask: { kind: 'permission', text: 'Bash: mise run migrate' } })
})

test('stays approve while another tool call finishes, and clears when the asking call ends', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'mise run migrate' } })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })

  expect(w.record().state).toBe('approve')

  await $.tool.call({ tool: 'Bash', command: 'mise run migrate' })

  expect(w.record().state).toBe('working')
  expect(w.record().ask).toBeUndefined()
})

test('is approve when a subagent asks for permission', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'agent-7' })

  expect(w.record()).toMatchObject({ state: 'approve', ask: { kind: 'permission', text: 'Bash: ls' } })
})

test('clears the ask once the turn ends', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await $.turn.complete(done('done'))

  expect(w.record().state).toBe('your-turn')
  expect(w.record().ask).toBeUndefined()
})

test('writes no record for a session with no person at the prompt', async ($, on) => {
  const w = world(on)
  await $.session.start({ ...start, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.turn.complete(done('ok'))
  await w.clock.advance(60_000)

  expect(w.record()).toBeNull()
})

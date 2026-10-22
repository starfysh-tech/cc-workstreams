import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, TurnCompleteInput } from 'claude-code'

import type { FileChange, Limit, PanelRow, Pending, Pr, Repo, RowType, SessionRecord, Status, Wrap, Agent, Job, Seen, Checks, Filter, Others } from '../types'

const status = atom({ plugin: 'workstreams', key: 'status' } as const, null)
const record = atom({ plugin: 'workstreams', key: 'record' } as const, null)
// `board`, not `panel`: a hot reload keeps $.state, and `panel` still holds the old shape in open sessions.
const panel = atom({ plugin: 'workstreams', key: 'board' } as const, { rows: [], limits: [], now: 0 })
const selected = atom({ plugin: 'workstreams', key: 'selected' } as const, null)
const wrap = atom({ plugin: 'workstreams', key: 'wrap' } as const, null)
const asked = atom({ plugin: 'workstreams', key: 'pending' } as const, null)
const help = atom({ plugin: 'workstreams', key: 'help' } as const, false)
const seen = atom({ plugin: 'workstreams', key: 'seen' } as const, null)
// True while the person types at the prompt: the panel holds still meanwhile.
const typing = atom({ plugin: 'workstreams', key: 'typing' } as const, false)
const filter = atom({ plugin: 'workstreams', key: 'filter' } as const, 'all')
const others = atom({ plugin: 'workstreams', key: 'others' } as const, null)

const PANE = 'workstreams'
const PREVIEW_ROWS = 10
// An engine action with no default key whose handler is mounted only while the diff panel is open, so the
// chord ~/.claude/keybindings.json binds to it reaches the status row's Button (pane:next's did not).
const OPEN_ACTION = 'app:toggleDiffPreSession'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const CUT = 500

const METER_CELLS = 10
const EIGHTHS = ' ▏▎▍▌▋▊▉'

const PALETTE = {
  dark: { surface: '#1a1a19', accent: '#3987e5', track: '#0d366b', added: '#3fb950', removed: '#e66767' },
  light: { surface: '#fcfcfb', accent: '#2a78d6', track: '#cde2fb', added: '#1a7f37', removed: '#e34948' },
}
const WARNING = '#fab219'
const CRITICAL = '#d03b3b'

// Warning and critical have no track step in the palette; 20% of the fill over the surface stands in.
function mix(fill: string, surface: string, share = 0.2) {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const out = [0, 1, 2].map(i => Math.round(channel(fill, i) * share + channel(surface, i) * (1 - share)))
  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function severity(percent: number, isLight: boolean) {
  const p = PALETTE[isLight ? 'light' : 'dark']
  if (percent >= 80) return { fill: CRITICAL, track: mix(CRITICAL, p.surface) }
  if (percent >= 60) return { fill: WARNING, track: mix(WARNING, p.surface) }
  return { fill: p.accent, track: p.track }
}

// A context meter's colors by cell: each cell takes the severity of where it sits on the bar, so a filling bar
// turns amber at 60% and red at 80%, and its track shows those zones before the fill reaches them.
const ramp = (cells: number, isLight: boolean) => Array.from({ length: cells }, (_, i) => severity(((i + 0.5) / cells) * 100, isLight))

// Any use at all shows at least a sliver, so 1% never reads as empty.
const eighthsOf = (percent: number, cells: number) => Math.max(percent > 0 ? 1 : 0, Math.round((Math.min(100, percent) / 100) * cells * 8))

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

// $.session.model() gives the model id (`claude-opus-5-5[1m]`), not the name /model shows.
function modelName(id: string) {
  const [, family, major, minor] = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/) ?? []
  return family ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}` : id
}

const gitCells = (n: number) => (n === 0 ? 0 : Math.min(5, Math.ceil(2 * Math.log10(n + 1))))

async function git($: EngineInterface, cwd: string) {
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  if (branch.exitCode !== 0) return undefined
  // Against where the branch left the default branch, so a lane shows its whole change, committed or not.
  const upstream = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd })
  const base = upstream.exitCode === 0 ? await $.process.run(['git', 'merge-base', 'HEAD', upstream.stdout.trim()], { cwd }) : undefined
  const from = base?.exitCode === 0 && base.stdout.trim() ? base.stdout.trim() : 'HEAD'
  const { stdout } = await $.process.run(['git', 'diff', from, '--numstat'], { cwd })
  // `added<TAB>removed<TAB>path` per file; a binary file shows `-` for both.
  const files: FileChange[] = stdout.split('\n').flatMap(line => {
    const [added, removed, ...path] = line.split('\t')
    return path.length ? [{ path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }] : []
  })
  const sum = (key: 'added' | 'removed') => files.reduce((n, f) => n + f[key], 0)
  const top = [...files].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 3)
  return { branch: branch.stdout.trim(), added: sum('added'), removed: sum('removed'), files: top }
}

// Used memory as Activity Monitor's "memory used" reads it: active plus wired pages.
async function memory($: EngineInterface) {
  const [size, stats] = await Promise.all([$.process.run(['sysctl', '-n', 'hw.memsize']), $.process.run(['vm_stat'])])
  const pageSize = Number(stats.stdout.match(/page size of (\d+)/)?.[1] ?? 0)
  const pages = (label: string) => Number(stats.stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0)
  const total = Number(size.stdout.trim()) / 2 ** 30
  const used = ((pages('Pages active') + pages('Pages wired down')) * pageSize) / 2 ** 30
  return total > 0 && pageSize > 0 ? { used, total } : undefined
}

async function refresh($: EngineInterface, cwd: string) {
  const [model, { context, rateLimits }, colorfgbg, { version }, ram] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.env.get('COLORFGBG'),
    $.session.version(),
    memory($).catch(() => undefined),
  ])
  const repo = await repoInfo($, cwd).catch(() => undefined)
  const pr = repo ? await prInfo($, cwd, repo.branch, await $.clock.now()).catch(() => undefined) : undefined
  const next: Status = {
    model,
    percent: context.percent ?? 0,
    tokens: context.tokens ?? 0,
    window: context.window,
    isLight: ['7', '15'].includes(colorfgbg?.split(';').at(-1) ?? ''),
    version,
    ram,
    limits: rateLimits,
    now: await $.clock.now(),
    lane: { name: laneName(cwd), cwd, repo, pr },
  }
  await update($, status, () => next)
}

type Change = Partial<Omit<SessionRecord, 'stateSince' | 'updatedAt'>>

async function facts($: EngineInterface) {
  const [sessionId, cwd, model, { version }, { context }, surface, workspace] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.model(),
    $.session.version(),
    $.session.usage(),
    $.env.get('CMUX_SURFACE_ID'),
    $.env.get('CMUX_WORKSPACE_ID'),
  ])
  const figures = { percent: context.percent ?? 0, tokens: context.tokens ?? 0, window: context.window }
  return { sessionId, cwd, model, version, context: figures, ...(surface && workspace ? { cmux: { surface, workspace } } : {}) }
}

// The one writer: the record lives in $.state, so a hot reload keeps state and stateSince, and the file always gets the whole record.
// Only recordStart creates the record, and only for a session with a person at the prompt: a `claude -p` a hook spawns would otherwise stand in for its lane.
async function save($: EngineInterface, change: Change, isStart = false) {
  const now = new Date(await $.clock.now()).toISOString()
  const next = await update($, record, prev => {
    if (!prev && !isStart) return null
    const base = prev ?? { state: 'your-turn', stateSince: now }
    const merged = { ...base, ...change, updatedAt: now } as SessionRecord
    if (prev && merged.state !== prev.state) merged.stateSince = now
    if (merged.state === 'your-turn' || merged.state === 'working') delete merged.ask
    return merged
  })
  if (!next) return
  const home = await $.env.get('HOME')
  if (!home) return
  await $.fs.write(`${home}/.claude/workstreams/${next.sessionId}.json`, JSON.stringify(next, null, 2))
}

function askText(tool: string, input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>
  const detail = i.command ?? i.file_path ?? i.url
  return (typeof detail === 'string' ? `${tool}: ${detail}` : tool).slice(0, CUT)
}

const recordStart = async ($: EngineInterface) => save($, await facts($), true)

async function recordTurnEnd($: EngineInterface, e: TurnCompleteInput) {
  if (e.agentId) return
  await save($, { ...(await facts($)), state: 'your-turn', did: didText(), ...(e.answer ? { lastTurn: e.answer.slice(-CUT) } : {}) })
}

// What this turn's tools did, counted as they run, for the preview's `did` line.
let turnTools = { edited: new Set<string>(), ran: 0, read: 0, searched: 0, agents: 0, other: 0 }
const resetTools = () => void (turnTools = { edited: new Set<string>(), ran: 0, read: 0, searched: 0, agents: 0, other: 0 })

function countTool(tool: string, input: Record<string, unknown>) {
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) turnTools.edited.add(String(input.file_path ?? input.notebook_path ?? ''))
  else if (tool === 'Bash') turnTools.ran += 1
  else if (tool === 'Read') turnTools.read += 1
  else if (tool === 'Grep' || tool === 'Glob') turnTools.searched += 1
  else if (tool === 'Agent' || tool === 'Task') turnTools.agents += 1
  else if (tool !== 'AskUserQuestion') turnTools.other += 1
}

function didText() {
  const t = turnTools
  const n = (count: number, one: string, many: string) => (count ? [`${count === 1 ? one.replace('#', '1') : many.replace('#', String(count))}`] : [])
  const parts = [
    ...n(t.edited.size, 'edited # file', 'edited # files'),
    ...n(t.ran, 'ran # command', 'ran # commands'),
    ...n(t.read, 'read # file', 'read # files'),
    ...n(t.searched, '# search', '# searches'),
    ...n(t.agents, 'started # agent', 'started # agents'),
    ...n(t.other, '# other tool', '# other tools'),
  ]
  return parts.join(' · ') || 'no tools'
}

const TYPE: Record<SessionRecord['state'], RowType> = {
  approve: 'APPROVE',
  pick: 'PICK',
  'your-turn': 'YOUR TURN',
  working: 'WORKING',
}
const RANK: Record<RowType, number> = { APPROVE: 0, PICK: 0, 'NEEDS INPUT': 0, 'YOUR TURN': 1, REVIEW: 2, WORKING: 3, 'WRAP?': 4, ORPHANED: 4 }
const GLYPH: Record<RowType, string> = { APPROVE: '●', PICK: '●', 'NEEDS INPUT': '●', 'YOUR TURN': '○', REVIEW: '◆', WORKING: '◌', 'WRAP?': '✓', ORPHANED: '⚠' }
// The state strip's order, most urgent first.
const STRIP = ['●', '○', '◆', '◌', '✓', '⚠']
const strip = (rows: PanelRow[]) =>
  STRIP.map(glyph => [glyph, rows.filter(r => GLYPH[r.type] === glyph).length] as const)
    .filter(([, n]) => n > 0)
    .map(([glyph, n]) => `${glyph}${n}`)
    .join(' ')
const FILTERS: Filter[] = ['all', 'needs you', 'working', 'stopped']
const FILTER_TEST: Record<Filter, (r: PanelRow) => boolean> = {
  all: () => true,
  'needs you': r => RANK[r.type] === 0,
  working: r => r.type === 'WORKING',
  stopped: r => !r.isLive,
}
const GOOD = '#0ca30c'
const MUTED = '#898781'
const WINDOW: Record<string, number> = { five_hour: 5 * 60 * MINUTE, seven_day: 7 * DAY }
const LIMIT_LABEL: Record<string, string> = { seven_day: 'week', five_hour: '5h' }

// Used against the share of the window already gone: `60%/40%` is ahead of an even pace.
function paceOf(limit: Limit, now: number) {
  const window = WINDOW[limit.kind]
  const resetIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : undefined
  const elapsed = window && resetIn !== undefined ? Math.min(1, Math.max(0, 1 - resetIn / window)) : undefined
  const projected = elapsed ? limit.percentUsed / (elapsed * 100) : 0
  const ratio = elapsed === undefined ? `${Math.round(limit.percentUsed)}%` : `${Math.round(limit.percentUsed)}%/${Math.round(elapsed * 100)}%`
  return { window, resetIn, elapsed, projected, ratio, isAhead: projected > 1 }
}

function age(ms: number) {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// Breaks `text` at spaces into at most `max` lines of `width` columns; the last line ends in … when text is left over.
function wrapLines(text: string, width: number, max: number) {
  const out: string[] = []
  let rest = text.trim()
  while (rest && out.length < max) {
    if (rest.length <= width) {
      out.push(rest)
      rest = ''
      break
    }
    const cut = rest.lastIndexOf(' ', width)
    const at = cut > width / 3 ? cut : width
    out.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }
  if (rest && out.length) out[out.length - 1] = `${(out[out.length - 1] ?? '').slice(0, width - 1)}…`
  return out.length ? out : ['']
}

const lastLine = (text?: string) => text?.trim().split('\n').at(-1)?.trim()

// `acme-api/.claude/worktrees/send-time-tz` reads as `acme-api / send-time-tz`.
function laneName(cwd: string) {
  const parts = cwd.split('/').filter(Boolean)
  const at = parts.lastIndexOf('worktrees')
  return at > 1 && parts[at - 1] === '.claude' ? `${parts[at - 2]} / ${parts.slice(at + 1).join('/')}` : (parts.at(-1) ?? cwd)
}

function prText(pr?: Pr) {
  if (!pr) return ''
  if (pr.state !== 'OPEN') return `#${pr.number} ${pr.state.toLowerCase()}`
  const c = pr.checks
  const ci = c ? [`✓${c.pass}`, c.fail ? `✕${c.fail}` : '', c.pending ? `·${c.pending}` : ''].filter(Boolean).join(' ') : pr.ci === 'pass' ? '✓CI' : pr.ci === 'fail' ? '✗CI' : '·CI'
  return `#${pr.number} ${ci} ${pr.isApproved ? '✓appr' : '✗appr'}`
}

// Rows group under their project as the agents view does: a worktree's project is the repo that holds it.
// A worktree's project is the repo that holds it.
function rootOf(cwd: string) {
  const at = cwd.indexOf('/.claude/worktrees/')
  return at > 0 ? cwd.slice(0, at) : cwd
}

function projectOf(cwd: string, home: string) {
  const root = rootOf(cwd)
  return home && root.startsWith(home) ? `~${root.slice(home.length)}` : root
}

const projectLabel = (project: string) => project.replace(/^~\/Code\//, '⌂ ')

// The last PR a background session opened: its job state lists each PR it made, oldest first.
function prLinkOf(job?: Job) {
  const last = (job?.children ?? []).filter(c => c.kind === 'pr' && /^\d+$/.test(c.id ?? '') && c.href).at(-1)
  return last ? { prLink: { number: Number(last.id), url: last.href as string } } : {}
}

function buildRows(records: SessionRecord[], gone: Set<string>, now: number, repos: Map<string, Repo>, prs: Map<string, Pr>, agents: Agent[], home: string, jobs: Map<string, Job> = new Map()): PanelRow[] {
  // `claude agents` can list one session twice (a stopped background entry and its live tab); the live one wins.
  const bySession = new Map<string, Agent>()
  for (const a of agents) {
    if (!a.sessionId) continue
    const seen = bySession.get(a.sessionId)
    if (!seen || (!seen.pid && a.pid)) bySession.set(a.sessionId, { ...seen, ...a, id: a.id ?? seen?.id })
  }
  const names = new Map(agents.flatMap(a => (a.sessionId && a.name && !a.sessionId.startsWith(a.name) ? [[a.sessionId, a.name] as const] : [])))
  // A background session is switched to through the agents view, by its id and its name there.
  // Its job state sits under the agents view's id, which is not always the sessionId's prefix.
  const jobOf = (sessionId: string) => jobs.get(bySession.get(sessionId)?.id ?? '')
  const background = (sessionId: string) => {
    const a = bySession.get(sessionId)
    return a?.kind === 'background' ? { agentId: a.id, agentName: a.name, ...prLinkOf(jobOf(sessionId)) } : {}
  }
  const newest = new Map<string, SessionRecord>()
  const wasUsed = (r: SessionRecord) => Boolean(r.lastInstruction || r.lastTurn) || now - Date.parse(r.updatedAt) < 2 * MINUTE
  for (const r of records.filter(wasUsed)) {
    const seen = newest.get(r.cwd)
    if (!seen || r.updatedAt > seen.updatedAt) newest.set(r.cwd, r)
  }
  const rows: PanelRow[] = []
  for (const r of newest.values()) {
    // `claude agents --json` leaves out interactive sessions, so liveness is the heartbeat in updatedAt.
    const isLive = now - Date.parse(r.updatedAt) < 2 * MINUTE
    // stateSince, not updatedAt: the heartbeat keeps updatedAt fresh on an open session that sits idle.
    const isStale = now - Date.parse(r.stateSince) > 7 * DAY
    const base = { id: r.sessionId, isLive, isStale, record: r, project: projectOf(r.cwd, home) }
    if (gone.has(r.cwd)) {
      // A directory gone with no session left is a finished row; a live one is ORPHANED until it exits.
      if (isLive) rows.push({ ...base, type: 'ORPHANED', ask: 'directory removed, session still running', isAskDim: false, age: '—', waitedMs: 0 })
      continue
    }
    const repo = repos.get(r.cwd)
    const pr = prs.get(r.cwd)
    const isIdle = r.state === 'your-turn' || !isLive
    const waitedMs = now - Date.parse(r.stateSince)
    const extra = { repo, pr, waitedMs }
    if (pr && pr.state !== 'OPEN' && repo?.isClean && repo.unpushed === 0 && isIdle) {
      rows.push({ ...base, ...extra, type: 'WRAP?', ask: `PR #${pr.number} ${pr.state.toLowerCase()} · clean`, isAskDim: false, age: age(waitedMs) })
      continue
    }
    const type = r.state === 'your-turn' && pr?.state === 'OPEN' && !pr.isMine ? 'REVIEW' : TYPE[r.state]
    const answer = r.ask?.text ?? (r.state === 'your-turn' ? lastLine(r.lastTurn) : undefined)
    // An ask is one row: newlines in a prompt would stretch it over several.
    const name = names.get(r.sessionId)
    const ask = (answer || name || r.lastInstruction || 'new session').replace(/\s+/g, ' ')
    rows.push({ ...base, ...extra, ...background(r.sessionId), type, ask, isAskDim: !answer && !name, age: type === 'WORKING' ? '—' : age(waitedMs) })
  }
  // Sessions that write no record (background ones, and tabs opened before the mod loaded) come from `claude agents`, one row each.
  const recorded = new Set(records.map(r => r.sessionId))
  for (const a of bySession.values()) {
    if (!a.sessionId || !a.cwd || recorded.has(a.sessionId)) continue
    const type: RowType = a.state === 'blocked' ? 'NEEDS INPUT' : a.state === 'working' || a.status === 'busy' ? 'WORKING' : 'YOUR TURN'
    // A background session's job state says what it asks or did. Its last write stands in for when its state
    // began, which it does not record.
    const job = jobOf(a.sessionId)
    const wroteAt = Date.parse(job?.updatedAt ?? '')
    const since = new Date(Number.isNaN(wroteAt) ? (a.startedAt ?? now) : wroteAt).toISOString()
    const said = (job?.state === 'blocked' ? job.needs || job.detail : job?.detail || job?.output?.result)?.replace(/\s+/g, ' ').trim()
    const record: SessionRecord = {
      sessionId: a.sessionId,
      cwd: a.cwd,
      state: type === 'WORKING' ? 'working' : 'your-turn',
      context: { percent: 0, tokens: 0, window: 0 },
      model: '',
      version: '',
      ...(job?.intent ? { lastInstruction: job.intent.slice(0, CUT) } : {}),
      ...(job?.output?.result || job?.detail ? { lastTurn: (job.output?.result || job.detail || '').slice(-CUT) } : {}),
      stateSince: since,
      updatedAt: since,
    }
    // A finished session with no process left recedes with the 7-day-idle rows: dimmed, last in its project.
    const isFinished = !a.pid && (a.state === 'done' || a.state === 'stopped')
    const name = a.name ?? 'background session'
    const waitedMs = job ? now - Date.parse(since) : 0
    rows.push({ id: a.sessionId, type, ask: said ? `${name} · ${said}` : name, isAskDim: false, age: job && type !== 'WORKING' ? age(waitedMs) : '—', waitedMs, isLive: Boolean(a.pid), isStale: isFinished, record, ...background(a.sessionId), project: projectOf(a.cwd, home), repo: repos.get(a.cwd), pr: prs.get(a.cwd) })
  }
  // Display order: projects alphabetically, then the usual urgency order inside each, so j/k and the arrows walk the rows as drawn.
  return rows.sort((a, b) => a.project.localeCompare(b.project) || Number(a.isStale) - Number(b.isStale) || RANK[a.type] - RANK[b.type] || b.waitedMs - a.waitedMs || a.id.localeCompare(b.id))
}

async function repoInfo($: EngineInterface, cwd: string): Promise<Repo | undefined> {
  const g = await git($, cwd)
  if (!g) return undefined
  const [st, ahead] = await Promise.all([
    $.process.run(['git', 'status', '--porcelain'], { cwd }),
    $.process.run(['git', 'rev-list', '--count', '@{u}..HEAD'], { cwd }),
  ])
  return { ...g, isClean: st.stdout.trim() === '', unpushed: ahead.exitCode === 0 ? Number(ahead.stdout.trim()) : undefined }
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT']
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

function checksOf(checks: { conclusion?: string; state?: string }[] = []): { ci?: Pr['ci']; checks?: Checks } {
  if (checks.length === 0) return {}
  const results = checks.map(c => c.conclusion || c.state || '')
  const fail = results.filter(v => FAILED.includes(v)).length
  const pass = results.filter(v => PASSED.includes(v)).length
  return { ci: fail ? 'fail' : pass === results.length ? 'pass' : 'pending', checks: { pass, fail, pending: results.length - pass - fail } }
}

// gh is a network call: one look per lane and branch a minute, against the 10 s scan.
const prCache = new Map<string, { at: number; pr?: Pr }>()
let me: string | undefined

async function prInfo($: EngineInterface, cwd: string, branch: string, now: number) {
  const key = `${cwd}@${branch}`
  const hit = prCache.get(key)
  if (hit && now - hit.at < MINUTE) return hit.pr
  me ??= (await $.process.run(['gh', 'api', 'user', '--jq', '.login'])).stdout.trim() || undefined
  const view = await $.process.run(['gh', 'pr', 'view', '--json', 'number,state,author,statusCheckRollup,reviewDecision,url'], { cwd })
  let pr: Pr | undefined
  if (view.exitCode === 0) {
    try {
      const j = JSON.parse(view.stdout)
      pr = { number: j.number, state: j.state, isMine: j.author?.login === me, ...checksOf(j.statusCheckRollup), isApproved: j.reviewDecision === 'APPROVED', url: j.url }
    } catch {}
  }
  prCache.set(key, { at: now, pr })
  return pr
}

async function readRecords($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return []
  const dir = `${home}/.claude/workstreams`
  const entries = await $.fs.list(dir).catch(() => [])
  const parsed = await Promise.all(
    entries
      .filter(f => f.name.endsWith('.json'))
      .map(async f => {
        // A record caught mid-write fails to parse; the next scan reads it whole.
        try {
          return JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as SessionRecord
        } catch {
          return undefined
        }
      }),
  )
  return parsed.filter((r): r is SessionRecord => typeof r?.sessionId === 'string' && typeof r.cwd === 'string')
}

// Each session toasts in its own terminal when another lane starts to need you.
const seenStates = new Map<string, SessionRecord['state']>()

async function watch($: EngineInterface) {
  const [records, own, now] = await Promise.all([readRecords($), $.session.id(), $.clock.now()])
  await countOthers($, records.filter(r => r.sessionId !== own), now)
  for (const r of records) {
    const before = seenStates.get(r.sessionId)
    seenStates.set(r.sessionId, r.state)
    // A new session's first record is idle, not a change; it stays quiet.
    const turnedToYou = before !== undefined && before !== r.state && r.state !== 'working'
    if (turnedToYou && r.sessionId !== own) {
      const ask = r.ask?.text ?? lastLine(r.lastTurn) ?? ''
      $.ui.toast(`${laneName(r.cwd)}: ${TYPE[r.state]}${ask ? ` · ${ask}` : ''}`)
    }
  }
}

// Background sessions write no record, so these counts leave them out; the panel lists them.
async function countOthers($: EngineInterface, records: SessionRecord[], now: number) {
  const waiting = records.filter(r => r.state === 'approve' || r.state === 'pick').sort((a, b) => a.stateSince.localeCompare(b.stateSince))
  const first = waiting[0]
  const next: Others = {
    needYou: waiting.length,
    working: records.filter(r => r.state === 'working' && now - Date.parse(r.updatedAt) < 2 * MINUTE).length,
    ...(first ? { oldest: { id: first.sessionId, lane: laneName(first.cwd), ask: (first.ask?.text ?? '').replace(/\s+/g, ' '), more: waiting.length - 1 } } : {}),
  }
  // The status line and the band redraw on each write, so an unchanged count is not written.
  if (JSON.stringify(next) !== JSON.stringify(await read($, others))) await update($, others, () => next)
}

// The rows the panel lists under its filter.
const shown = async ($: EngineInterface) => {
  const [{ rows }, f] = await Promise.all([read($, panel), read($, filter)])
  return rows.filter(FILTER_TEST[f])
}

async function scan($: EngineInterface) {
  const records = await readRecords($)
  const now = await $.clock.now()
  const listed = await $.process.run(['claude', 'agents', '--json', '--all']).catch(() => undefined)
  let agents: Agent[] = []
  try {
    agents = JSON.parse(listed?.stdout ?? '[]')
  } catch {}
  const cwds = [...new Set([...records.map(r => r.cwd), ...agents.flatMap(a => (a.kind === 'background' && a.cwd ? [a.cwd] : []))])]
  const repos = new Map<string, Repo>()
  const prs = new Map<string, Pr>()
  const gone = new Set<string>()
  await Promise.all(
    cwds.map(async cwd => {
      if (!(await $.fs.exists(cwd))) return void gone.add(cwd)
      const repo = await repoInfo($, cwd).catch(() => undefined)
      if (!repo) return
      repos.set(cwd, repo)
      const pr = await prInfo($, cwd, repo.branch, now).catch(() => undefined)
      if (pr) prs.set(cwd, pr)
    }),
  )
  // A record whose folder is gone and whose session stopped has nothing left to show: delete it.
  const home = (await $.env.get('HOME')) ?? ''
  await Promise.all(
    records
      .filter(r => gone.has(r.cwd) && now - Date.parse(r.updatedAt) >= 2 * MINUTE)
      .map(r => $.process.run(['rm', '-f', `${home}/.claude/workstreams/${r.sessionId}.json`])),
  )
  const jobs = new Map<string, Job>()
  await Promise.all(
    agents
      .filter(a => a.kind === 'background' && a.id && /^[\w-]+$/.test(a.id))
      .map(async a => {
        // Not every job folder has a state file, and one caught mid-write does not parse.
        try {
          jobs.set(a.id as string, JSON.parse(await $.fs.read(`${home}/.claude/jobs/${a.id}/state.json`)) as Job)
        } catch {}
      }),
  )
  const { rateLimits } = await $.session.usage()
  const built = buildRows(records, gone, now, repos, prs, agents, home, jobs)
  // A row whose type changed since the last scan flashes. Only while the panel is open: on a reopen, a change
  // made while it was closed is old news, and the unread mark carries it.
  const before = await read($, panel)
  const wasOpen = now - before.now < 30_000
  const prior = new Map(before.rows.map(r => [r.id, r]))
  const rows = built.map(r => {
    const was = prior.get(r.id)
    const changedAt = wasOpen && was && was.type !== r.type ? now : was?.changedAt
    return changedAt === undefined ? r : { ...r, changedAt }
  })
  await update($, panel, () => ({ rows, limits: rateLimits, now }))
}

// The cmux tab showing a background session: the agents view titles the tab with the session's name. None when
// no tab, or more than one, carries that title.
async function tabShowing($: EngineInterface, cli: string, name: string) {
  const { stdout } = await $.process.run([cli, 'tree', '--all'])
  const tabs = stdout.split('\n').flatMap(line => {
    const m = line.match(/surface (surface:\d+) \[terminal\] "(.*)"/)
    return m && m[2] === name ? [m[1]] : []
  })
  return tabs.length === 1 ? tabs[0] : undefined
}

// Enter switches this tab to the chosen session the way the agents view does, and nothing is ended or lost:
// - a session running in its own cmux tab: that tab gets the focus.
// - this tab shows a background session: it detaches (the session runs on), the agents view comes up, and the
//   chosen background session is picked there by its name.
// - this tab runs a normal session: /background moves it into the background (it runs on, under a new id), and
//   the shell it leaves behind attaches or resumes the chosen session.
// Typing into the tab goes through cmux. What cannot switch in place opens in a new cmux tab, or outside cmux
// has its command copied. The panel closes once the switch starts.
async function go($: EngineInterface, row: PanelRow, rows: PanelRow[], surface: RenderSurface) {
  const { cmux, cwd, sessionId } = row.record
  const cli = (await $.env.get('CMUX_BUNDLED_CLI_PATH')) || 'cmux'
  const close = () => $.ui.close({ id: PANE })
  const isBackground = Boolean(row.agentId && /^[\w-]+$/.test(row.agentId))
  if (row.isLive && cmux && !isBackground) {
    const picked = await $.process.run([cli, 'select-workspace', '--workspace', cmux.workspace])
    const focused = picked.exitCode === 0 && (await $.process.run([cli, 'focus-panel', '--panel', cmux.surface, '--workspace', cmux.workspace]))
    if (focused && focused.exitCode === 0) return close()
    $.ui.toast(`cmux could not focus that tab: ${(focused || picked).stderr.trim() || 'no reason given'}`)
    return
  }
  const command = isBackground ? `claude attach ${row.agentId}` : `claude --resume ${sessionId}`
  const workspace = await $.env.get('CMUX_WORKSPACE_ID')
  const ownId = await $.session.id()
  const own = rows.find(r => r.id === ownId)
  const isUnique = (name?: string) => Boolean(name) && rows.filter(r => r.agentName === name).length === 1
  if (workspace && own?.agentId && own.agentName && isBackground && isUnique(row.agentName)) {
    // This tab shows a background session: detach, then pick the chosen one in the agents view by name.
    const tab = await tabShowing($, cli, own.agentName)
    if (tab) {
      await close()
      await $.command.run({ command: 'exit' })
      $.clock.after(2500, () => {
        void $.process
          .run([cli, 'send', '--surface', tab, '--workspace', workspace, `n:${row.agentName}`])
          .then(() => $.clock.sleep(1200))
          .then(() => $.process.run([cli, 'send-key', '--surface', tab, '--workspace', workspace, 'enter']))
      })
      return
    }
  }
  const here = await $.env.get('CMUX_SURFACE_ID')
  if (workspace && here && own && !own.agentId && (isBackground || !row.isLive)) {
    // This tab runs a normal session: move it into the background, then the shell runs the chosen session.
    // A session that never had a prompt has nothing to keep, so it just exits.
    await close()
    const leave = own.record.lastInstruction ? 'background' : 'exit'
    // The values reach the script as arguments, never as text spliced into it, so no value can run as shell.
    // It types only once this session's process ($4, the launching shell's parent) has exited, so nothing lands
    // in the prompt of a session that is still finishing; it gives up after a minute.
    const script = 'n=0; while kill -0 "$4" 2>/dev/null && [ $n -lt 200 ]; do sleep 0.3; n=$((n+1)); done; kill -0 "$4" 2>/dev/null || { sleep 0.5; "$0" send --surface "$1" --workspace "$2" "$3\\n"; }'
    await $.process.run(['sh', '-c', `nohup sh -c '${script}' "$0" "$@" "$PPID" >/dev/null 2>&1 &`, cli, here, workspace, command])
    await $.command.run({ command: leave })
    return
  }
  if (workspace && (isBackground || !row.isLive)) {
    const opened = await $.process.run([cli, 'new-surface', '--workspace', workspace, '--working-directory', cwd, '--command', command, '--focus', 'true'])
    if (opened.exitCode === 0) return close()
    $.ui.toast(`cmux could not open a tab: ${opened.stderr.trim() || 'no reason given'}`)
  }
  const line = `cd '${cwd.replaceAll("'", "'\\''")}' && ${command}`
  const { isCopied } = await $.ui.copy({ text: line, surface })
  $.ui.toast(isCopied ? `Copied: ${line}` : line)
}

// The panel does not tear down a lane itself: it hands the lane to this session's agent, whose /wrap skill checks the work is safe first.
function planWrap(row: PanelRow): Wrap {
  if (row.isLive) return { id: row.id, refusal: 'the session is still running' }
  return { id: row.id, prompt: `Use the /wrap skill to wrap up the workstream at ${row.record.cwd}.` }
}

// x stops a running background session, then deletes it; `claude rm` keeps a worktree that is not safe to remove.
// A session in a tab is the tab's to end: once it stopped, x takes its record off the list and /resume still has it.
function planClose(row: PanelRow, home: string): Pending {
  const name = row.agentName ?? laneName(row.record.cwd)
  if (row.agentId)
    return row.isLive
      ? { kind: 'close', id: row.id, verb: `stop ${name}`, note: 'its conversation is kept, and x again deletes it', argv: ['claude', 'stop', row.agentId] }
      : { kind: 'close', id: row.id, verb: `delete ${name}`, note: 'and its worktree when that is safe', argv: ['claude', 'rm', row.agentId] }
  if (row.isLive) return { kind: 'close', id: row.id, verb: `close ${name}`, refusal: 'it runs in a tab: end it there, then x takes it off the list' }
  return { kind: 'close', id: row.id, verb: `take ${name} off the list`, note: 'its conversation stays in /resume', argv: ['rm', '-f', `${home}/.claude/workstreams/${row.record.sessionId}.json`] }
}

function stepGroup(rows: PanelRow[], current: string | null, by: number) {
  const at = Math.max(0, rows.findIndex(r => r.id === current))
  const project = rows[at]?.project
  if (by > 0) return rows.slice(at).find(r => r.project !== project)?.id ?? rows[at]?.id ?? null
  // Back: the start of this project when the selection is inside it, else the start of the one before.
  const start = rows.findIndex(r => r.project === project)
  const target = start < at ? start : rows.findLastIndex((r, i) => i < start && r.project !== project && rows[i - 1]?.project !== r.project)
  return rows[Math.max(0, target)]?.id ?? null
}

function step(rows: PanelRow[], current: string | null, by: number) {
  const at = Math.max(0, rows.findIndex(r => r.id === current))
  return rows[Math.min(rows.length - 1, Math.max(0, at + by))]?.id ?? null
}

// Selecting a row is looking at it: it stops being unread, in every session's panel, through $.store.
async function look($: EngineInterface, id: string) {
  await update($, selected, () => id)
  const at = new Date(await $.clock.now()).toISOString()
  const stored = (await $.store.get('seen')) as Seen | undefined
  const next = await update($, seen, prev => {
    const base = prev ?? stored
    return base ? { floor: base.floor, ids: { ...stored?.ids, ...prev?.ids, [id]: at } } : null
  })
  if (next) await $.store.set('seen', next)
}

// The first open ever starts the clock: sessions that changed before it are not unread.
async function loadSeen($: EngineInterface) {
  const stored = (await $.store.get('seen')) as Seen | undefined
  const next = stored ?? { floor: new Date(await $.clock.now()).toISOString(), ids: {} }
  if (!stored) await $.store.set('seen', next)
  await update($, seen, () => next)
}

let refreshing: { cancel: () => void } | undefined

let focusMovedTo: string | undefined
// The list window's first item, kept between draws so the list holds still while the selection moves inside it.
let listTop = 0
let focusMovedAt = 0

async function focusSelected($: EngineInterface) {
  const rows = await shown($)
  const id = (await read($, selected)) ?? (await $.session.id())
  const row = rows.find(r => r.id === id) ?? rows[0]
  if (row) await $.ui.focus({ requestId: PANE, key: `row:${row.id}` }).catch(() => undefined)
}

async function togglePanel($: EngineInterface) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) return $.ui.close({ id: PANE })
  await openPanel($)
}

async function openPanel($: EngineInterface) {
  await Promise.all([scan($), loadSeen($)])
  await $.ui.open({ id: PANE, title: 'workstreams', focus: true, closeOnEscape: true })
  // The prompt takes the keyboard back after a command; this hands it to the pane once that settles.
  $.clock.after(150, () => void focusSelected($))
  refreshing ??= $.clock.every(10_000, () => void scan($))
}
let beating: { cancel: () => void } | undefined
let watching: { cancel: () => void } | undefined

// A failed record write must not cost the status row, or the reverse; the first failure still reaches the engine's log.
async function settle(work: Promise<unknown>[]) {
  const failed = (await Promise.allSettled(work)).find(r => r.status === 'rejected')
  if (failed) throw failed.reason
}

// The `motion` option: `on` animates everything, `calm` drops the one-shot flash and meter slide, `off` holds
// everything still.
let motion = 'on'
let typingStops: { cancel: () => void } | undefined

export const register: Register = (on, options) => {
  motion = typeof options.motion === 'string' ? options.motion : 'on'

  // The panel holds still while the person types: it flips at the start and the end of a burst, not per key.
  on('prompt.edit', async ($, e, next) => {
    const edited = await next(e)
    if (motion === 'off') return edited
    if (!typingStops) await update($, typing, () => true)
    typingStops?.cancel()
    typingStops = $.clock.after(1500, () => {
      typingStops = undefined
      void update($, typing, () => false)
    })
    return edited
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Timers first: a failed first refresh must not leave the session without its heartbeat.
    beating ??= $.clock.every(MINUTE, () => {
      void facts($).then(f => save($, f))
      void $.session.cwd().then(cwd => refresh($, cwd))
    })
    watching ??= $.clock.every(10_000, () => void watch($))
    void watch($)
    await settle([
      refresh($, e.cwd),
      e.isInteractive ? recordStart($) : Promise.resolve(),
      $.command.register({ name: 'ws', description: 'Open the workstreams panel' }),
    ])
    return started
  })

  on('command.run', { command: 'ws' }, async $ => {
    await openPanel($)
    return { text: 'Workstreams panel opened.' }
  })

  // Tab, the arrows and a click move the ring onto a row; the selection, and so the banner and preview, follow it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const id = e.element?.startsWith('row:') ? e.element.slice(4) : undefined
    if (id) {
      focusMovedTo = id
      focusMovedAt = await $.clock.now()
      await look($, id)
    }
    return next(e)
  })

  // The 10 s scan runs git and gh per lane: it stops once the pane closes.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      refreshing?.cancel()
      refreshing = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile surface has no Client; its selected row goes unmarked.
    const Client = 'Client' in elements ? elements.Client : undefined
    const Link = 'Link' in elements ? elements.Link : undefined
    // Mobile has no Input; c does nothing there.
    const Input = 'Input' in elements ? elements.Input : undefined
    // A hot reload drops the module's timer while the pane stays open; the next draw starts it again.
    refreshing ??= $.clock.every(10_000, () => void scan($))
    const { rows: everyRow, limits, now } = await read($, panel)
    const listing = await read($, filter)
    const rows = everyRow.filter(FILTER_TEST[listing])
    const here = await read($, status)
    const isLight = here?.isLight ?? false
    const ram = here?.ram
    const p = PALETTE[isLight ? 'light' : 'dark']
    const own = await $.session.id()
    const chosen = await read($, selected)
    // Until a row is chosen, the panel's own session is selected, so the banner starts on this lane.
    const current = rows.find(r => r.id === chosen) ?? rows.find(r => r.id === own) ?? rows[0]
    const lookedAt = await read($, seen)
    // A row that turned to need you, or finished, since you last selected it. The panel's own session never is.
    const isUnread = (r: PanelRow) => Boolean(lookedAt) && r.id !== own && RANK[r.type] <= 2 && r.record.stateSince > (lookedAt?.ids[r.id] ?? lookedAt?.floor ?? '')
    const columns = Math.max(30, e.props.bodyColumns ?? 80)
    const isDock = e.props.placement === 'dock' && e.props.scroll !== undefined

    // Every meter is one Text per cell, so each cell carries its own color.
    const isTyping = (await read($, typing)) === true
    const loops = motion !== 'off' && !isTyping
    const oneShots = motion === 'on' && !isTyping
    const meter = (percent: number, colors: { fill: string; track: string }[], tick?: number) => {
      const eighths = eighthsOf(percent, colors.length)
      return colors.map(({ fill, track }, i) => {
        if (i === tick) return <Text color={MUTED} backgroundColor={track}>┃</Text>
        const left = eighths - i * 8
        if (left >= 8) return <Text color={fill}>█</Text>
        if (left > 0) return <Text color={fill} backgroundColor={track}>{EIGHTHS[left]}</Text>
        return <Text backgroundColor={track}> </Text>
      })
    }
    // A panel meter between end caps; it slides to a new value where the surface can animate it.
    const capped = (key: string, percent: number, colors: { fill: string; track: string }[], tick?: number) => (
      <Box key={key} flexDirection="row" flexShrink={0}>
        <Text color={MUTED}>▕</Text>
        {Client && oneShots ? (
          <Client key={key} module="./meter.tsx" width={colors.length} props={{ percent, colors, tickColor: MUTED, ...(tick === undefined ? {} : { tick }) }} />
        ) : (
          <Text>{meter(percent, colors, tick)}</Text>
        )}
        <Text color={MUTED}>▏</Text>
      </Box>
    )
    const even = (cells: number, fill: string, track: string) => Array.from({ length: cells }, () => ({ fill, track }))
    // A section rule with its title in ink and an optional note at its right.
    const rule = (label: string, note = '') => (
      <Text wrap="truncate-end">
        <Text dimColor>── </Text>
        <Text bold>{label}</Text>
        <Text dimColor>{` ${note ? `${note} ` : ''}${'─'.repeat(Math.max(0, columns - label.length - note.length - (note ? 5 : 4)))}`}</Text>
      </Text>
    )

    const isHelpOpen = (await read($, help)) === true
    const toggleHelp = () => void update($, help, open => !open)
    const pending = await read($, wrap)
    const plan = pending && pending.id === current?.id ? pending : undefined
    // Handlers read the latest rows and selection, never what this draw captured.
    const selectedRow = async () => {
      const latest = await shown($)
      const mine = await $.session.id()
      const id = await read($, selected)
      return latest.find(r => r.id === id) ?? latest.find(r => r.id === mine) ?? latest[0]
    }
    const nextFilter = async () => {
      await update($, filter, f => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length] ?? 'all')
      await focusSelected($)
    }
    const startWrap = async () => {
      const row = await selectedRow()
      if (row) await update($, wrap, () => planWrap(row))
    }
    const confirmWrap = async () => {
      const prompt = (await read($, wrap))?.prompt
      await update($, wrap, () => null)
      if (prompt) await $.prompt.submit({ text: prompt, asUser: true })
    }
    const cancelWrap = () => void update($, wrap, () => null)
    const waiting = await read($, asked)
    const asking = waiting && waiting.id === current?.id ? waiting : undefined
    const cancelAsk = async () => {
      await update($, asked, () => null)
      await focusSelected($)
    }
    const startClose = async () => {
      const row = await selectedRow()
      const home = (await $.env.get('HOME')) ?? ''
      if (row) await update($, asked, () => planClose(row, home))
    }
    const startNew = async () => {
      const row = await selectedRow()
      if (!row) return
      await update($, asked, (): Pending => ({ kind: 'new', id: row.id, cwd: rootOf(row.record.cwd) }))
      await $.ui.focus({ requestId: PANE, key: 'new-prompt' }).catch(() => undefined)
    }
    // The command's own words say what went wrong, such as a worktree `claude rm` would not remove.
    const runAsk = async (argv: string[], cwd?: string) => {
      const ran = await $.process.run(argv, cwd ? { cwd } : undefined).catch(() => undefined)
      const said = `${ran?.stdout ?? ''}\n${ran?.stderr ?? ''}`.trim().split('\n')[0] ?? ''
      $.ui.toast(ran?.exitCode === 0 ? `${argv.slice(0, 2).join(' ')}: ${said || 'done'}` : `${argv.slice(0, 2).join(' ')} failed: ${said || 'no output'}`)
      await scan($)
    }
    const confirmClose = async () => {
      const latest = await read($, asked)
      await update($, asked, () => null)
      if (latest?.kind === 'close' && latest.argv) await runAsk(latest.argv)
      await focusSelected($)
    }
    const submitNew = async (text: string) => {
      const latest = await read($, asked)
      await update($, asked, () => null)
      if (latest?.kind === 'new' && text.trim()) await runAsk(['claude', '--bg', text.trim()], latest.cwd)
      await focusSelected($)
    }
    // A press right after the ring landed on a row is the click that put it there: it selects. A press on a row
    // the ring has rested on (Enter, or a second click) opens it.
    const pressRow = (id: string) => async () => {
      const landedJustNow = focusMovedTo === id && (await $.clock.now()) - focusMovedAt < 400
      const isSelected = (await selectedRow())?.id === id
      if (!isSelected || landedJustNow) {
        await look($, id)
        focusMovedTo = undefined
        return
      }
      const all = (await read($, panel)).rows
      const row = all.find(r => r.id === id)
      if (row) await go($, row, all, e.surface)
    }
    const move = (by: number, byGroup = false) => async () => {
      const latest = await shown($)
      const from = (await selectedRow())?.id ?? null
      const target = (byGroup ? stepGroup : step)(latest, from, by)
      if (!target) return
      await look($, target)
      await $.ui.focus({ requestId: PANE, key: `row:${target}` }).catch(() => undefined)
    }

    // The next row after the selection that needs you or is unread, from the top again after the last.
    const nextForYou = async () => {
      const latest = await shown($)
      const from = Math.max(0, latest.findIndex(r => r.id === (current?.id ?? '')))
      const order = [...latest.slice(from + 1), ...latest.slice(0, from + 1)]
      const target = order.find(r => RANK[r.type] === 0 || isUnread(r))
      if (!target) return
      await look($, target.id)
      await $.ui.focus({ requestId: PANE, key: `row:${target.id}` }).catch(() => undefined)
    }

    const pace = (limit: Limit) => {
      const { window, resetIn, elapsed, projected, ratio, isAhead } = paceOf(limit, now)
      const fill = projected > 1.2 ? CRITICAL : projected > 1 ? WARNING : p.accent
      const track = fill === p.accent ? p.track : mix(fill, p.surface)
      const runsOutIn = elapsed && window ? ((100 - limit.percentUsed) * elapsed * window) / limit.percentUsed : 0
      const label = projected > 1.2 ? `runs out ~${age(runsOutIn)}` : projected > 1 ? 'ahead' : 'on pace'
      return (
        <Box key={`limit-${limit.kind}`} flexDirection="row">
          <Text>{(LIMIT_LABEL[limit.kind] ?? limit.kind).padEnd(5)}</Text>
          {capped(`meter-${limit.kind}`, limit.percentUsed, even(16, fill, track), elapsed === undefined ? undefined : Math.min(15, Math.floor(elapsed * 16)))}
          {/* One Text cut at its end: a narrow dock must not wrap the row onto a second line. */}
          <Text wrap="truncate-end">
            <Text>{` ${ratio} `}</Text>
            <Text color={isAhead ? fill : MUTED}>{isAhead ? '◆ ' : '◇ '}</Text>
            <Text dimColor>{label}</Text>
            {resetIn !== undefined && (
              <Text dimColor={resetIn >= MINUTE} color={resetIn < MINUTE ? WARNING : undefined}>{`  ↻ ${age(resetIn)}`}</Text>
            )}
          </Text>
        </Box>
      )
    }

    const groups: { project: string; rows: PanelRow[] }[] = []
    for (const r of rows) {
      const group = groups.find(g => g.project === r.project)
      if (group) group.rows.push(r)
      else groups.push({ project: r.project, rows: [r] })
    }
    const versions = [...new Set(everyRow.filter(r => r.isLive && r.record.version).map(r => r.record.version))]

    // A row's ask is broken at spaces into at most two lines that fit, so its height is known before it is drawn.
    // The fixed parts: selection bar 1, tree line 3, glyph 2, unread mark 2, scrollbar 1, then resume, meter, age.
    const askWidth = (r: PanelRow) => Math.max(8, columns - 9 - ((r.isLive ? 0 : 9) + 1 + 3 + 4))
    const askLines = (r: PanelRow) => wrapLines(r.ask, askWidth(r), 2)
    // A merged PR's number is struck through: that work has landed.
    const struckAsk = (r: PanelRow) => {
      const text = askLines(r).join('\n')
      const struck = r.type === 'WRAP?' && r.pr?.state === 'MERGED' ? `PR #${r.pr.number}` : ''
      return struck && text.startsWith(struck) ? [<Text strikethrough>{struck}</Text>, text.slice(struck.length)] : text
    }

    // The list scrolls in a window of its own, so the banner, preview and usage always show.
    type Item = { kind: 'project'; project: string } | { kind: 'row'; row: PanelRow }
    const items: Item[] = groups.flatMap(g => [{ kind: 'project' as const, project: g.project }, ...g.rows.map(row => ({ kind: 'row' as const, row }))])
    const lines = (it: Item) => (it.kind === 'project' ? 2 : askLines(it.row).length)
    const turn = current?.record.lastTurn?.trim().split('\n').map(line => line.trim()).filter(Boolean) ?? []
    const previewLines = 2 + PREVIEW_ROWS
    const planLines = (plan?.refusal ? 1 : plan?.prompt ? 3 : 0) + (asking?.kind === 'new' || (asking?.kind === 'close' && !asking.refusal) ? 2 : asking ? 1 : 0)
    const keyLines = ['⏎    go to the session', '↑/↓  move (j/k too)', 'u    next that needs you or is unread (✦)', 'n/p  next / previous project', 'w    wrap the selected lane', 'x    stop, then delete (y/n first)', 'c    new background session in this project', 'f    list all, needs you, working, stopped', 'h    close this help', 'esc  close the panel']
    const usageLines = 2 + limits.filter(l => WINDOW[l.kind]).length + (ram ? 0 : 1) + (ram ? 1 : 0) + (versions.length > 1 ? 1 : 0)
    // Less one line for the hint under the list.
    // The help takes the usage section's place, and the list gives up lines when the help is taller.
    const footLines = isHelpOpen ? Math.max(usageLines, keyLines.length + 2) : usageLines
    const budget = isDock ? Math.max(4, (e.props.scroll?.bodyRows ?? 0) - 4 - previewLines - planLines - footLines - 1) : 14
    const at = Math.max(0, items.findIndex(it => it.kind === 'row' && it.row === current))
    // Scroll only when the selection leaves the window; a row scrolled up to brings its project's name.
    let lo = Math.min(listTop, Math.max(0, items.length - 1))
    if (at < lo) lo = items[at - 1]?.kind === 'project' ? at - 1 : at
    let hi = lo - 1
    let used = 0
    const size = (i: number) => (items[i] ? lines(items[i]) : Infinity)
    while (used + size(hi + 1) <= budget) used += size(++hi)
    if (items[at] && at > hi) {
      lo = hi = at
      used = lines(items[at])
    }
    // Room left at the end of the list, or above a row scrolled down to, shows the items above it.
    while ((hi === items.length - 1 || hi === at) && used + size(lo - 1) <= budget) used += size(--lo)
    listTop = lo
    // A scrollbar beside the list when it does not all fit: a ┃ thumb over a │ track, as tall as the window.
    const view = isDock ? Math.max(budget, used) : used
    const total = items.reduce((sum, it) => sum + lines(it), 0)
    const above = items.slice(0, lo).reduce((sum, it) => sum + lines(it), 0)
    const thumb = Math.max(1, Math.round((used / total) * view))
    const thumbTop = Math.min(view - thumb, Math.round((above / total) * view))
    const scrollbar = total > used ? Array.from({ length: view }, (_, i) => (i >= thumbTop && i < thumbTop + thumb ? '┃' : '│')) : []
    const lastInGroup = new Set(groups.map(g => g.rows.at(-1)?.id))
    const flashColors = [0.6, 0.5, 0.4, 0.3, 0.2, 0.12, 0.06].map(share => mix(p.accent, p.surface, share))
    const breathColors = [1, 0.85, 0.7, 0.55, 0.55, 0.7, 0.85, 1].map(share => mix(p.accent, p.surface, share))
    const verb = current?.isLive ? 'switch' : 'resume'
    const filterKey = listing === 'all' ? 'f filter' : listing === FILTERS.at(-1) ? 'f show all' : 'f next filter'
    const rowHint = !current
      ? listing === 'all' ? ' ' : `none ${listing}`
      : current.type === 'ORPHANED'
        ? `its folder is gone · ⏎ ${verb}`
        : RANK[current.type] === 0
          ? `⏎ ${verb} and answer · u next for you`
          : current.type === 'WRAP?'
            ? `⏎ ${verb} · w wrap`
            : current.type === 'WORKING'
              ? `⏎ ${verb} · j/k move · u next for you`
              : `⏎ ${verb} · u next for you`
    const hint = listing === 'all' && !current ? ' ' : `${rowHint} · ${filterKey}`

    const gitBar = (repo: Repo) => [
      <Text color={p.removed}>{'█'.repeat(gitCells(repo.removed))}</Text>,
      <Text dimColor>┊</Text>,
      <Text color={p.added}>{'█'.repeat(gitCells(repo.added))}</Text>,
      <Text color={p.removed}>{` −${repo.removed}`}</Text>,
      <Text color={p.added}>{` +${repo.added}`}</Text>,
      repo.isClean ? null : <Text color={WARNING}> ✎</Text>,
      (repo.unpushed ?? 0) > 0 ? <Text color={WARNING}>{` ↑${repo.unpushed}`}</Text> : null,
    ]

    // Two lines, always: the lane and branch, then git and the PR.
    const banner = (
      <Box key="banner" flexDirection="column">
        <Box key="banner-lane" flexDirection="row">
        {/* One line whatever the lane's length, so the list below does not move. */}
        <Text wrap="truncate-end">
          {current && Link ? <Link href={`file://${current.record.cwd}`} label={laneName(current.record.cwd)} /> : <Text bold>{current ? laneName(current.record.cwd) : ' '}</Text>}
          {current?.repo && <Text dimColor>{`  ${current.repo.branch}`}</Text>}
        </Text>
        </Box>
        <Box key="banner-git" flexDirection="row" justifyContent="center">
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              {current?.repo ? gitBar(current.repo) : <Text dimColor>{current ? 'not a git repo' : ' '}</Text>}
              {current?.pr || current?.prLink ? <Text>  </Text> : current?.repo ? <Text dimColor>  no PR</Text> : null}
            </Text>
          </Box>
          {current?.pr && (
            <Box flexShrink={0}>
              {Link && current.pr.url ? <Link href={current.pr.url} label={prText(current.pr)} /> : <Text>{prText(current.pr)}</Text>}
            </Box>
          )}
          {!current?.pr && current?.prLink && (
            <Box flexShrink={0}>
              {Link ? <Link href={current.prLink.url} label={`#${current.prLink.number}`} /> : <Text>{`#${current.prLink.number}`}</Text>}
            </Box>
          )}
        </Box>
      </Box>
    )

    // The preview keeps PREVIEW_ROWS lines whatever the row holds, so nothing below it moves.
    // The same slots for every session, each drawn even when empty, so the preview never changes shape.
    const ctxFigures = current && current.record.context.window > 0 ? severity(current.record.context.percent, isLight) : undefined
    const options = current?.record.ask?.kind === 'question' ? current.record.ask.options : []
    // A recap of the last turn from what the session recorded: what you asked, what its tools did, how it ended,
    // and what comes next. No model call, so it costs no usage.
    const labeled = (key: string, label: string, value: string) => (
      <Text key={key} wrap="truncate-end">
        <Text dimColor>{label.padEnd(7)}</Text>
        <Text>{value}</Text>
      </Text>
    )
    const lastQuestion = turn.at(-1)?.endsWith('?') ? turn.at(-1) : undefined
    const ask = current?.record.ask
    const next = !current
      ? '—'
      : RANK[current.type] === 0
        ? ask?.kind === 'question' ? `pick ${ask.options.length ? `1–${ask.options.length}` : 'an answer'}` : ask ? 'approve or deny' : 'answer it'
        : current.type === 'WRAP?'
          ? 'w wraps the lane'
          : (lastQuestion ?? (current.type === 'WORKING' ? 'working on it' : '—'))
    const result = (next === lastQuestion ? turn.slice(0, -1) : turn).slice(-2)
    // The lane's most changed files, tig's diffstat: added and removed cells scaled to the largest.
    const files = current?.repo?.files ?? []
    const largest = Math.max(1, ...files.map(f => f.added + f.removed))
    const cells = (n: number) => (n ? Math.max(1, Math.round((n / largest) * 8)) : 0)
    const shortPath = (path: string) => {
      const parts = path.split('/')
      return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
    }
    const fileRow = (i: number) => {
      const f = files[i]
      const label = i === 0 ? 'files' : ''
      if (!f) return labeled(`pv-file-${i}`, label, i > 0 ? '' : current?.repo ? 'no changes' : '—')
      const [a, r] = [cells(f.added), cells(f.removed)]
      return (
        <Text key={`pv-file-${i}`} wrap="truncate-end">
          <Text dimColor>{label.padEnd(7)}</Text>
          <Text color={p.added}>{'█'.repeat(a)}</Text>
          <Text color={p.removed}>{'█'.repeat(r)}</Text>
          <Text>{' '.repeat(Math.max(0, 10 - a - r))}</Text>
          <Text color={p.added}>{`+${f.added}`}</Text>
          <Text color={p.removed}>{` −${f.removed}`}</Text>
          <Text dimColor>{`  ${shortPath(f.path)}`}</Text>
        </Text>
      )
    }
    const previewBody = current
      ? [
          <Box key="pv-ctx" flexDirection="row">
            <Text dimColor>{'ctx  '}</Text>
            {ctxFigures ? capped('meter-ctx', current.record.context.percent, ramp(10, isLight)) : <Text dimColor>{' —'.padEnd(12)}</Text>}
            <Text wrap="truncate-end">
              {ctxFigures
                ? ` ${current.record.context.percent}%  ${tokens(current.record.context.tokens)}/${tokens(current.record.context.window)}  ${modelName(current.record.model)}`
                : '  no figures: this session writes no record'}
            </Text>
          </Box>,
          <Text key="pv-ask" wrap="truncate-end">
            <Text color={p.accent}>{current.type}</Text>
            <Text dimColor>{current.isLive ? ' · running · ' : ' · stopped · '}</Text>
            <Text>{options.length ? `${current.ask}  ${options.map((o, i) => `${i + 1}. ${o}`).join('  ')}` : current.ask}</Text>
          </Text>,
          labeled('pv-asked', 'asked', current.record.lastInstruction?.replace(/\s+/g, ' ') || '—'),
          labeled('pv-did', 'did', current.record.did ?? '—'),
          ...[0, 1].map(i => labeled(`pv-result-${i}`, i === 0 ? 'result' : '', result[i] ?? (i === 0 ? '—' : ''))),
          labeled('pv-next', 'next', next),
          ...[0, 1, 2].map(i => fileRow(i)),
        ]
      : []
    const previewRows = [...previewBody.slice(0, PREVIEW_ROWS), ...Array.from({ length: Math.max(0, PREVIEW_ROWS - previewBody.length) }, (_, i) => <Text key={`pv-pad-${i}`}> </Text>)]

    return (
      // A docked pane is at least its body tall, so the spacer below can push usage to the bottom.
      <Box flexDirection="column">
        {rule('workstreams', `${listing === 'all' ? everyRow.length : `${rows.length} of ${everyRow.length}`} · ${strip(everyRow)}${listing === 'all' ? '' : ` · ${listing}`}`)}
        {banner}
        <Box key="list" flexDirection="row">
          <Box key="list-rows" flexDirection="column" flexGrow={1} flexShrink={1}>
        {items.slice(lo, hi + 1).map(it => {
          if (it.kind === 'project')
            return (
              <Box key={`project-${it.project}`} marginTop={1}>
                <Text bold>{projectLabel(it.project)}</Text>
              </Box>
            )
          const r = it.row
          const needsYou = RANK[r.type] <= 2
          const isLate = needsYou && r.waitedMs > 15 * MINUTE
          const glyphColor = r.type === 'ORPHANED' ? CRITICAL : r.type === 'WRAP?' ? GOOD : needsYou ? p.accent : undefined
          const tree = lastInGroup.has(r.id) ? '└─ ' : '├─ '
          const bar = r === current ? '▎' : ' '
          const isDim = r.isStale || !needsYou
          // WORKING pulses and what waits on you breathes; a row whose type changed a moment ago flashes once.
          const mode = !loops || r.isStale ? 'still' : r.type === 'WORKING' ? 'pulse' : RANK[r.type] === 0 ? 'breathe' : 'still'
          const flash = oneShots && r.changedAt !== undefined && now - r.changedAt < 15_000 ? r.changedAt : undefined
          // Client props are plain data with no undefined in them, so absent fields are left out.
          const lead = { tree, glyph: GLYPH[r.type], ...(glyphColor ? { color: glyphColor } : {}), isDim, isUnread: isUnread(r), accent: p.accent, mode, ...(flash === undefined ? {} : { flash }), flashColors, breathColors }
          return (
            <Box key={`row-${r.id}`} flexDirection="row">
              {/* Fixed parts never shrink: a shrunk Text wraps inside its own width. */}
              <Box flexShrink={0} flexDirection="column">
                <Box key="lead" flexDirection="row">
                  <Text color={glyphColor ?? p.accent}>{bar}</Text>
                  {Client ? (
                    <Client key={`lead-${r.id}`} module="./lead.tsx" width={7} props={lead} />
                  ) : (
                    <Text>
                      <Text dimColor>{tree}</Text>
                      <Text dimColor={isDim} color={glyphColor}>{`${GLYPH[r.type]} `}</Text>
                      <Text color={p.accent}>{lead.isUnread ? '✦ ' : '  '}</Text>
                    </Text>
                  )}
                </Box>
                {/* A wrapped ask's second line carries the tree on, so the project's line stays unbroken. */}
                {askLines(r).length > 1 && (
                  <Box key="lead-more">
                    <Text>
                      <Text color={glyphColor ?? p.accent}>{bar}</Text>
                      <Text dimColor>{lastInGroup.has(r.id) ? '       ' : '│      '}</Text>
                    </Text>
                  </Box>
                )}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Button key={`row:${r.id}`} plain autoFocus={r === current || undefined} dimColor={r.isStale || r.isAskDim || !needsYou} onPress={pressRow(r.id)}>
                  <Text bold={r === current}>{struckAsk(r)}</Text>
                </Button>
              </Box>
              <Box flexShrink={0}>
                {!r.isLive && <Text dimColor> ↻ resume</Text>}
                <Text> </Text>
                {r.record.context.window > 0 ? <Text>{meter(r.record.context.percent, ramp(3, isLight))}</Text> : <Text>   </Text>}
                <Text dimColor={r.isStale} color={isLate && !r.isStale ? WARNING : undefined}>
                  {r.age.padStart(4)}
                </Text>
              </Box>
            </Box>
          )
        })}
        {isDock && Array.from({ length: Math.max(0, budget - used) }, (_, i) => <Text key={`list-pad-${i}`}> </Text>)}
          </Box>
          {scrollbar.length > 0 && (
            <Box key="scrollbar" flexDirection="column" flexShrink={0}>
              {scrollbar.map((cell, i) => (
                <Text key={`bar-${i}`} color={cell === '┃' ? MUTED : undefined} dimColor={cell === '│'}>
                  {cell}
                </Text>
              ))}
            </Box>
          )}
        </Box>
        <Text key="hint" dimColor wrap="truncate-end">{`  ${hint}`}</Text>
        <Box key="preview" flexDirection="column" marginTop={1}>
          {rule('preview')}
          {previewRows}
        </Box>
        {plan?.refusal && (
          <Box key="wrap-refused" flexDirection="row">
            <Text color={WARNING}>{`wrap refused: ${plan.refusal}  `}</Text>
            <Button key="cancel" hotkey="n" plain onPress={cancelWrap}>
              ok
            </Button>
          </Box>
        )}
        {plan?.prompt && (
          <Box key="wrap-confirm" flexDirection="column">
            <Text color={WARNING}>wrap asks this session:</Text>
            <Text wrap="truncate-end">{`  ${plan.prompt}`}</Text>
            <Box key="wrap-keys" flexDirection="row">
              <Button key="confirm" hotkey="y" plain onPress={confirmWrap}>
                send
              </Button>
              <Text dimColor> · </Text>
              <Button key="cancel" hotkey="n" plain onPress={cancelWrap}>
                cancel
              </Button>
            </Box>
          </Box>
        )}
        {asking?.kind === 'close' && asking.refusal && (
          <Box key="close-refused" flexDirection="row">
            <Text color={WARNING} wrap="truncate-end">{`can't ${asking.verb}: ${asking.refusal}  `}</Text>
            <Button key="ask-cancel" hotkey="n" plain onPress={cancelAsk}>
              ok
            </Button>
          </Box>
        )}
        {asking?.kind === 'close' && !asking.refusal && (
          <Box key="close-confirm" flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={WARNING}>{`${asking.verb}?`}</Text>
              <Text dimColor>{asking.note ? `  ${asking.note}` : ''}</Text>
            </Text>
            <Box key="close-keys" flexDirection="row">
              <Button key="ask-confirm" hotkey="y" plain onPress={confirmClose}>
                yes
              </Button>
              <Text dimColor> · </Text>
              <Button key="ask-cancel" hotkey="n" plain onPress={cancelAsk}>
                cancel
              </Button>
            </Box>
          </Box>
        )}
        {asking?.kind === 'new' && Input && (
          <Box key="new-session" flexDirection="column">
            <Text color={WARNING} wrap="truncate-end">{`new background session in ${asking.cwd}`}</Text>
            <Input key="new-prompt" label="› " placeholder="what should it do? (empty ⏎ cancels)" submitLabel="start" autoFocus onSubmit={value => void submitNew(value)} />
          </Box>
        )}
        {rule(isHelpOpen ? 'keys' : 'usage')}
        {isHelpOpen && [...keyLines.slice(0, -1), ...Array.from({ length: footLines - keyLines.length - 2 }, () => ' ')].map((line, i) => <Text key={`key-${i}`}>{line}</Text>)}
        {!isHelpOpen && limits.filter(l => WINDOW[l.kind]).map(pace)}
        {!isHelpOpen && versions.length > 1 && <Text dimColor>{`versions  ${versions.join(' · ')}`}</Text>}
        <Box key="last-row" flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            {isHelpOpen && <Text>{keyLines.at(-1)}</Text>}
            {!isHelpOpen && ram && (
              <Box key="ram" flexDirection="row">
                <Text>{'RAM'.padEnd(5)}</Text>
                {capped('meter-ram', (ram.used / ram.total) * 100, even(16, p.accent, p.track))}
                <Text wrap="truncate-end">{` ${Math.round((ram.used / ram.total) * 100)}%`}</Text>
              </Box>
            )}
          </Box>
          <Box key="keys" flexShrink={0} flexDirection="row">
            <Button key="help" hotkey="h" plain dimColor onPress={toggleHelp}>
              ?
            </Button>
          </Box>
        </Box>
        <Box key="hidden-keys" display="none">
          <Button key="next" hotkey="j" plain onPress={move(1)}>
            down
          </Button>
          <Button key="prev" hotkey="k" plain onPress={move(-1)}>
            up
          </Button>
          <Button key="filter" hotkey="f" plain onPress={nextFilter}>
            filter
          </Button>
          <Button key="next-for-you" hotkey="u" plain onPress={nextForYou}>
            next for you
          </Button>
          <Button key="next-group" hotkey="n" plain onPress={move(1, true)}>
            next project
          </Button>
          <Button key="prev-group" hotkey="p" plain onPress={move(-1, true)}>
            previous project
          </Button>
          {current && (
            <Button key="wrap" hotkey="w" plain onPress={startWrap}>
              wrap
            </Button>
          )}
          {current && (
            <Button key="close" hotkey="x" plain onPress={startClose}>
              close
            </Button>
          )}
          {current && Input && (
            <Button key="new" hotkey="c" plain onPress={startNew}>
              new session
            </Button>
          )}
        </Box>
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await settle([refresh($, await $.session.cwd()), recordTurnEnd($, e)])
    return done
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, status)
    if (s === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const p = PALETTE[s.isLight ? 'light' : 'dark']
    const o = await read($, others)
    const eighths = eighthsOf(s.percent, METER_CELLS)
    // Neighbouring cells of one color draw as one Text.
    const runs: { text: string; color?: string; track?: string }[] = []
    ramp(METER_CELLS, s.isLight).forEach(({ fill, track }, i) => {
      const left = eighths - i * 8
      const cell = left >= 8 ? { text: '█', color: fill } : left > 0 ? { text: EIGHTHS[left] ?? ' ', color: fill, track } : { text: ' ', track }
      const last = runs.at(-1)
      if (last && last.color === cell.color && last.track === cell.track) last.text += cell.text
      else runs.push(cell)
    })

    // The engine's hint, less the mode-cycling note and the PR pill: the PR lives in the panel's banner.
    const hint = e.props.hint
      .replace('(shift+tab to cycle)', '')
      .split(' · ')
      .map(part => part.trim())
      .filter(part => part && !/^PR #\d+$/.test(part))
      .join(' · ')

    // One Text with inline spans: as sibling flex items, each part wrapped on its own when the row ran short.
    return (
      <Box flexDirection="row">
        <Text wrap="truncate-end">
          <Text color={p.accent}>{modelName(s.model)}</Text>{' '}
          {runs.map(run => (
            <Text color={run.color} backgroundColor={run.track}>
              {run.text}
            </Text>
          ))}
          <Text>{` ${s.percent}% ${tokens(s.tokens)}/${tokens(s.window)}`}</Text>
          {s.version && <Text dimColor>{` · v${s.version}`}</Text>}
          {s.ram && <Text dimColor>{` · RAM ${Math.round((s.ram.used / s.ram.total) * 100)}%`}</Text>}
          {o && (o.needYou > 0 || o.working > 0) && <Text dimColor> ·</Text>}
          {o && o.needYou > 0 && <Text color={p.accent}>{` ●${o.needYou}`}</Text>}
          {o && o.working > 0 && <Text dimColor>{` ◌${o.working}`}</Text>}
          {(s.limits ?? [])
            .filter(l => LIMIT_LABEL[l.kind])
            .map(l => [l, paceOf(l, s.now ?? 0)] as const)
            .map(([l, pace]) => [
              <Text dimColor>{` · ${LIMIT_LABEL[l.kind]} `}</Text>,
              ...Array.from({ length: 5 }, (_, i) => {
                const left = Math.round((Math.min(100, l.percentUsed) / 100) * 40) - i * 8
                return left >= 8 ? (
                  <Text color={p.accent}>█</Text>
                ) : left > 0 ? (
                  <Text color={p.accent} backgroundColor={p.track}>
                    {EIGHTHS[left]}
                  </Text>
                ) : (
                  <Text backgroundColor={p.track}> </Text>
                )
              }),
              <Text>{` ${pace.ratio}`}</Text>,
              pace.elapsed === undefined ? null : <Text color={pace.isAhead ? WARNING : MUTED}>{pace.isAhead ? '◆' : '◇'}</Text>,
            ])}
          {hint && <Text dimColor>{` · ${hint}`}</Text>}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lane = (await read($, status))?.lane
    if (e.props.hasSurvey || !lane) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Link = 'Link' in elements ? elements.Link : undefined
    const p = PALETTE[(await read($, status))?.isLight ? 'light' : 'dark']
    const { repo, pr } = lane
    const oldest = (await read($, others))?.oldest
    const openAt = (id: string) => async () => {
      await update($, selected, () => id)
      await openPanel($)
    }
    return (
      <Box flexDirection="column">
      <Box key="lane" flexDirection="row">
        {Link && lane.cwd ? <Link href={`file://${lane.cwd}`} label={lane.name} /> : <Text bold>{lane.name}</Text>}
        <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {repo && <Text dimColor>{`  ${repo.branch}  `}</Text>}
          {repo && <Text color={p.removed}>{'█'.repeat(gitCells(repo.removed))}</Text>}
          {repo && <Text dimColor>┊</Text>}
          {repo && <Text color={p.added}>{'█'.repeat(gitCells(repo.added))}</Text>}
          {repo && <Text color={p.removed}>{` −${repo.removed}`}</Text>}
          {repo && <Text color={p.added}>{` +${repo.added}`}</Text>}
          {repo && !repo.isClean && <Text color={WARNING}> ✎</Text>}
          {repo && (repo.unpushed ?? 0) > 0 && <Text color={WARNING}>{` ↑${repo.unpushed}`}</Text>}
          {pr && <Text>  </Text>}
        </Text>
        </Box>
        {pr && <Box flexShrink={0}>{Link && pr.url ? <Link href={pr.url} label={prText(pr)} /> : <Text>{prText(pr)}</Text>}</Box>}
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Button key="open-panel" action={OPEN_ACTION} plain dimColor onPress={() => void togglePanel($)}>
            workstreams
          </Button>
        </Box>
      </Box>
      {/* The session that has waited on you longest, so it is seen without opening the panel. */}
      {oldest && (
        <Box key="alert" flexDirection="row">
          <Button key="alert" plain onPress={openAt(oldest.id)}>
            <Text wrap="truncate-end">
              <Text color={p.accent}>● </Text>
              <Text bold>{oldest.lane}</Text>
              <Text>{oldest.ask ? ` · ${oldest.ask}` : ' needs you'}</Text>
              {oldest.more > 0 && <Text dimColor>{` · +${oldest.more} more`}</Text>}
            </Text>
          </Button>
        </Box>
      )}
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    resetTools()
    // The last turn's `did` would sit beside the new instruction; it comes back when this turn ends.
    // A turn the harness starts (a subagent's hand-off, a task notice) opens with a tag; the last typed instruction stays.
    const isTyped = e.text && !/^\s*<[a-z][\w-]*[\s>]/i.test(e.text)
    await save($, { state: 'working', did: undefined, ...(isTyped ? { lastInstruction: e.text.slice(0, CUT) } : {}) })
    return started
  })

  // AskUserQuestion takes up to 4 questions; the record's ask carries the first.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const q = (e as { questions?: { question: string; options: { label: string }[] }[] }).questions?.[0]
    if (e.agentId || !q) return next(e)
    await save($, { state: 'pick', ask: { kind: 'question', text: q.question, options: q.options.map(o => o.label) } })
    return next(e)
  })

  // Only the call that raised the ask clears it: a parallel call can finish while the dialog is still up.
  on('tool.call', async ($, e, next) => {
    // Claude's own calls in this session, not a subagent's or another mod's.
    if (!e.agentId && next.origin.plugin === 'engine') countTool(e.tool, e as unknown as Record<string, unknown>)
    const result = await next(e)
    const ask = (await read($, record))?.ask
    const isAsker = ask?.kind === 'question' ? e.tool === 'AskUserQuestion' : ask?.text === askText(e.tool, e)
    if (ask && isAsker) await save($, { state: 'working' })
    return result
  })

  // A subagent's dialog waits on the person too, so it counts.
  on('classic.PermissionRequest', async ($, e, next) => {
    await save($, { state: 'approve', ask: { kind: 'permission', text: askText(e.tool_name, e.tool_input) } })
    return next(e)
  })
}

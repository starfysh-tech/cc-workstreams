export type Status = {
  model: string
  percent: number
  tokens: number
  window: number
  isLight: boolean
  version?: string
  ram?: { used: number; total: number }
  limits?: Limit[]
  now?: number
  // This session's lane, for the band above the prompt.
  lane?: { name: string; cwd?: string; repo?: Repo; pr?: Pr }
}

export type Ask = { kind: 'permission'; text: string } | { kind: 'question'; text: string; options: string[] }

// Written to ~/.claude/workstreams/<sessionId>.json for the panel to merge.
export type SessionRecord = {
  sessionId: string
  cwd: string
  state: 'approve' | 'pick' | 'your-turn' | 'working'
  ask?: Ask
  lastInstruction?: string
  lastTurn?: string
  // What the last turn's tools did, as `edited 3 files · ran 5 commands`.
  did?: string
  context: { percent: number; tokens: number; window: number }
  model: string
  version: string
  // The cmux surface the session runs in, for the panel's ⏎ to focus.
  cmux?: { surface: string; workspace: string }
  stateSince: string
  updatedAt: string
}

export type RowType = 'APPROVE' | 'PICK' | 'NEEDS INPUT' | 'YOUR TURN' | 'REVIEW' | 'WORKING' | 'WRAP?' | 'ORPHANED'

// `files`: the most changed files, most first, for the preview.
export type Repo = { branch: string; added: number; removed: number; files?: FileChange[]; isClean: boolean; unpushed?: number }

export type FileChange = { path: string; added: number; removed: number }

export type Pr = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; isMine: boolean; ci?: 'pass' | 'fail' | 'pending'; checks?: Checks; isApproved: boolean; url?: string }

export type Checks = { pass: number; fail: number; pending: number }

// Which rows the panel lists; `f` steps through them in this order.
export type Filter = 'all' | 'needs you' | 'working' | 'stopped'

// Other sessions, from their records, for the status line and the band: how many need you, how many work, and
// the one that has waited longest on you.
export type Others = { needYou: number; working: number; oldest?: { id: string; lane: string; ask: string; more: number } }

export type PanelRow = {
  id: string
  type: RowType
  ask: string
  // The ask is a stand-in (your last instruction, or `new session`), not the session's own words.
  isAskDim: boolean
  age: string
  waitedMs: number
  isLive: boolean
  isStale: boolean
  record: SessionRecord
  project: string
  // Set on a background session's row: the agents view's id and name for it, which the switch uses.
  agentId?: string
  agentName?: string
  repo?: Repo
  pr?: Pr
  // The last PR a background session opened, from its job state; a link only, it drives no row type.
  prLink?: { number: number; url: string }
  // When the panel saw the row's type change, for its one-time flash.
  changedAt?: number
}

// A background session's ~/.claude/jobs/<agent id>/state.json, the fields the panel reads.
export type Job = {
  state?: string
  detail?: string
  needs?: string
  intent?: string
  output?: { result?: string } | null
  children?: { id?: string; href?: string; kind?: string }[] | null
  updatedAt?: string
}

// When each session was last looked at in the panel; rows that changed after it are unread.
// `floor` stands in for sessions never looked at, so the first open marks nothing.
export type Seen = { floor: string; ids: Record<string, string> }

// A session as `claude agents --json --all` lists it.
export type Agent = { id?: string; sessionId?: string; kind?: string; cwd?: string; name?: string; state?: string; status?: string; pid?: number; startedAt?: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// A planned wrap of one row: why it is refused, or the prompt this session's agent gets once confirmed.
export type Wrap = { id: string; refusal?: string; prompt?: string }

// What x and c wait on: a y/n before a session is stopped, deleted or taken off the list, or the prompt for a new
// background session in a project.
export type Pending =
  | { kind: 'close'; id: string; verb: string; note?: string; argv?: string[]; refusal?: string }
  | { kind: 'new'; id: string; cwd: string }

export type Panel = { rows: PanelRow[]; limits: Limit[]; now: number }

declare module 'claude-code' {
  interface PluginState {
    workstreams: { status: Status | null; record: SessionRecord | null; board: Panel; selected: string | null; wrap: Wrap | null; pending: Pending | null; help: boolean; seen: Seen | null; typing: boolean; filter: Filter; others: Others | null }
  }
}

# workstreams — design

Personal Claude Code mod. Default interface across all projects. Not built for other users.

Goal: triage many parallel Claude Code sessions in cost-first order, then switch into the real session to act, the way the agents view does.

Mock of every state: [mock.html](mock.html). The mock predates the build; where they differ, this file wins.

## Setup

- `~/.claude/settings.json` sets `env.CLAUDE_CODE_PLUGIN_DIRS` to this checkout, so every session loads the mod, background sessions included. Each saved edit reloads the mod in every open session.
- A session started before that setting, or before a change to it, runs without the mod. Leave it with `/exit` and start or attach it again to load the mod.
- `~/.claude/keybindings.json` binds ctrl+q to `app:toggleDiffPreSession` globally and to `pane:close` in the `Pane` context. See Keys.
- The status line replaces ccstatusline, so `settings.json` has no `statusLine`.
- Switching sessions in place needs cmux. Outside cmux, Enter copies the command.

## Rows

- A row is one session. Records come from the sessions themselves (see Data); sessions with no record come from `claude agents --json --all`.
- Rows group under their project, as the agents view groups them. A worktree's project is the repo that holds it. Projects are alphabetical, with `~/Code/` drawn as `⌂`. Rows inside a project sort by urgency: APPROVE / PICK / NEEDS INPUT → YOUR TURN → REVIEW → WORKING → WRAP? / ORPHANED, then longest wait first.
  - PICK is an `AskUserQuestion` waiting for an answer. NEEDS INPUT is a background session the agents view calls `blocked`.
  - YOUR TURN is an idle session. A prose question at the end of a turn stays YOUR TURN, and its text shows as the ask. The mod does not guess whether prose is a question.
- A row draws: the selection mark, the type glyph, the unread mark `✦`, the ask (broken at spaces into at most two lines), `↻ resume` when the session is not running, a 3-cell context meter, and AGE.
- **Unread.** A row is unread when it needs you, is your turn, or is REVIEW, and its state changed after you last selected it. Selecting a row marks it seen. The seen times live in `$.store`, so a row seen in one session's panel is seen in all of them. The first open ever sets a floor, so older changes are not unread. The panel's own session is never unread.
- Running means the record's `updatedAt` is less than 2 minutes old, since each session rewrites its record every minute. For a row from `claude agents`, it means the session has a pid.
- A background session's row reads its job state, `~/.claude/jobs/<agents view id>/state.json`. The folder name is the agents view's id, which is not always the session id's prefix.
  - The ask is the session's name, then `needs` when it is blocked, else `detail`.
  - The preview's instruction is `intent`, and its last turn is `output.result` or `detail`.
  - AGE reads the job's `updatedAt`. The job does not record when its state began, so this is an approximation.
  - The banner links the last PR in `children` (kind `pr`). It is a link only, with no `gh` call, and it does not make a row REVIEW or WRAP?.
  - The job has a token count but no context window, so the context meter stays `—`.
- Rows idle for more than 7 days (by `stateSince`), and finished background sessions with no process left, are dimmed and go last in their project.
- Left out: a session that stopped without ever getting a prompt. It would otherwise stand in for the session that worked in the same folder.
- WRAP? requires all of these: PR merged or closed (from `gh`, because squash merges hide it from git), a clean tree, nothing unpushed, and a session that is idle or not running.
- ORPHANED: the session is live but its directory is gone. The row clears when the session exits.

## Screens

- **Band above the prompt.** This session's lane: folder (a link that opens it in Finder), branch, git bar, ✎ for uncommitted changes, ↑n for unpushed commits, the PR as a link, and a `workstreams` Button that opens the panel. A second line, shown only when another session needs you, names the one that has waited longest, its ask, and how many more wait; pressing it opens the panel on that row. It counts sessions that write a record, so background sessions are left out. No mod site draws at the top of the screen, so the band is the nearest place.
- **Status line** under the prompt, one line: model, context meter with % and tokens, version, RAM as a percentage (active plus wired pages), 5-hour and week usage as 5-cell bars with used against elapsed (`48%/86%`) and `◆` ahead of an even pace or `◇` behind it, `●n` other sessions that need you and `◌n` that work (from records, so background sessions are left out), then the engine's hint less `(shift+tab to cycle)` and the PR pill.
- **Toast** at the top right when another session turns to need you.
- **Panel.** ctrl+q, the band's `workstreams` Button, or `/ws` opens it; ctrl+q or esc closes it. It docks on the right beside a fullscreen transcript, or opens above the prompt otherwise. Top to bottom, each part at a fixed height:
  - Header: a section rule titled `workstreams`, with the row count and a strip of counts by glyph (`●3 ○4 ◆1 ◌2 ✓1`). Under a filter it reads `3 of 18` and names the filter.
  - Banner, two lines: the selected lane's folder (a Finder link) and branch, cut to one line, then its git bar (centered), ✎ and ↑n, and its PR as a link.
  - List, in a window of its own, so nothing below it moves. The window scrolls only when the selection leaves it. When it does not all fit, a scrollbar beside it shows a `┃` thumb over a `│` track.
  - Hint, one muted line for the selected row: what ⏎ does there (switch, or resume for a stopped session) and the key that fits it (`u`, `w`), then `f`.
  - Preview, the same 10 lines for every session: context meter and model (`—` for a session with no record), type, running or stopped, the ask with its options, then a recap of the last turn and the lane's changed files:
    - `asked`: your last instruction.
    - `did`: what the turn's own tools did (`edited 2 files · ran 3 commands`), counted in this session's `tool.call` hook, leaving out subagents and other mods. It is empty while the next turn works.
    - `result`: the last turn's last 2 lines.
    - `next`: `approve or deny`, `pick 1–n`, `w wraps the lane`, or the last turn's closing question.
    - `files`: the 3 most changed files, with added and removed cells scaled to the largest, and `+a −r`.
    No model call makes the recap, so it costs no usage.
  - Usage: 5-hour and week pace meters, RAM, the version line when sessions run different versions, and a `?` Button that toggles the key help. The help takes the usage section's place, so the preview stays. When the help is taller than usage, the list gives up the extra lines, so the footer stays at the bottom.

## Keys

- In the panel, ↑/↓ and Tab move the engine's focus ring between rows, and the selection follows it. A mod cannot bind the arrows, and they scroll instead of moving the ring when the pane is taller than its body, so the panel always fits its body.
- A click on a row that is not selected selects it. Enter, or a second click, opens the selected row.
- `j`/`k` move the selection, `n`/`p` jump to the next or previous project, `u` jumps to the next row that needs you or is unread (from the top again after the last), `w` wraps, `f` steps the list through all, needs you, working and stopped, `h` toggles the help.
- `x` closes the selected session, after a y/n. A running background session is stopped (`claude stop`), and its conversation is kept. A stopped one is deleted (`claude rm`), with its worktree when that is safe. A session in a tab is not touched: once it has stopped, `x` deletes its record, and `/resume` still has it. A toast shows what the command said.
- `c` starts a background session (`claude --bg`) in the selected row's project folder. It asks for the prompt first, in a field in the panel. An empty prompt cancels.
- Learned limits: a Button hidden with `display="none"` takes its hotkey but not a key bound to its action; Buttons in the status line are never pressed; an `action` whose engine handler is mounted (`pane:next`) never reaches the Button. That is why the opener lives in the band and uses `app:toggleDiffPreSession`.

## Actions

- **⏎ switches this tab to the chosen session** the way the agents view does. Nothing is ended or lost.
  - A session running in its own cmux tab: that tab gets the focus.
  - This tab shows a background session: it detaches (the session runs on), the agents view comes up, and cmux types `n:<name>` and Enter to pick the chosen background session. The tab is found by its title, which the agents view sets to the session's name. The name must be unique.
  - This tab runs a normal session: `/background` moves it into the background (it runs on, under a new id; a session with no prompt just exits). Once its process has exited, a detached helper types `claude attach <id>` or `claude --resume <id>` into the shell through `cmux send`. The values reach the helper as arguments, never spliced into shell text.
  - Anything else opens in a new cmux tab, or outside cmux has its command copied. The panel closes once the switch starts.
- **w wrap.** The panel does not tear a lane down itself. It refuses while the lane's session runs. Otherwise it shows the prompt `Use the /wrap skill to wrap up the workstream at <cwd>.` and, on `y`, submits it to the session the panel is open in, whose `/wrap` skill checks the work is safe and does the teardown. Nothing is archived: all changes are in the repo, so this is a cleanup.

## Visual language

Gauges are `Text` cells: 24-bit color per cell, with any width-1 glyph. Labels are `Text` in ink tokens and never in series color.

**Palette.** Reference dataviz palette.

| Role | Dark terminal | Light terminal |
|---|---|---|
| Accent fill | `#3987e5` | `#2a78d6` |
| Accent track | `#0d366b` | `#cde2fb` |
| Warning | `#fab219` | `#fab219` |
| Critical | `#d03b3b` | `#d03b3b` |
| Good | `#0ca30c` | `#0ca30c` |
| Added | `#3fb950` | `#1a7f37` |
| Removed | `#e66767` | `#e34948` |
| Muted ink | `#898781` | `#898781` |

- The git pair is red and green, so blue stays the accent and the meters. Red and green are hard to tell apart with some color vision; the side of `┊` and the `−`/`+` signs carry the same meaning.
- Status colors always come with a glyph and a label.
- Warning and critical tracks mix 20% of the fill over the surface. These are derived values, not palette steps.

**Meter.** One row. Full cells are `█` in the fill color. The partial cell is an eighth-block (`▏▎▍▌▋▊▉`) in the fill color over the track color. Empty cells are track-colored background. That gives 8 levels per cell. Any use above zero shows at least a one-eighth sliver. Panel meters sit between muted `▕` `▏` caps.

A context meter colors each cell by where it sits on the bar, so its fill and its track show the zones:

| Cell position | Accent | Warning | Critical |
|---|---|---|---|
| Context | < 60% | 60–80% | ≥ 80% |

**Pace meter** (weekly and 5-hour usage, in the panel). A meter plus a `┃` tick at the share of the window already elapsed, used against elapsed (`75%/50%`), `◆` in the fill color when ahead of an even pace or a muted `◇` when behind it, the label, then `↻ <time to reset>`, in warning color in the last minute. Its fill is one color, chosen by the projection below, not by cell position.

Projected use at reset = used % ÷ elapsed share. Fill and label:

| Projected at reset | Fill | Label |
|---|---|---|
| ≤ 100% | accent | `on pace` |
| 100–120% | warning | `ahead` |
| > 120% | critical | `runs out ~<time>` |

**Row mini-meter.** 3 cells (24 levels) of context, colored by cell position like every context meter, to spot lanes near auto-compact without opening them.

**Row lead.** Before the ask: a `▎` bar in the row's glyph color on the selected row, a muted tree line (`├─`, or `└─` on the last row of a project), carried on as `│` beside a wrapped ask's second line, the type glyph, and the unread mark.

**Git diff.** Changes since the branch left the default branch (`git merge-base HEAD origin/HEAD`), committed or not, from one `git diff --numstat`, which also gives the preview its files. A diverging bar centered on `┊`. Removed is red, extending left; added is green, extending right. Up to 5 cells per side, on a log scale. `−3 +12` labels beside it, each in its side's color. An open PR shows its checks as `✓12 ✕1 ·2` (passed, failed, pending). A WRAP? row strikes through its merged PR's number.

**Row type glyph.**

| Type | Glyph | Ink |
|---|---|---|
| APPROVE, PICK, NEEDS INPUT | `●` in accent | bright |
| YOUR TURN | `○` in accent | bright |
| REVIEW | `◆` in accent | bright |
| WORKING | `◌` | muted |
| WRAP? | `✓` in good | muted |
| ORPHANED | `⚠` in critical | — |

The selected row has the `▎` bar and bold text. Age turns warning after 15 minutes of waiting on you. What needs you is bright; the rest recedes.

**Status line.** Drawn as the mod's own tree at the `PromptHint` site: one `Text` with inline colored spans, cut at its end, because sibling flex items wrap one by one when the row runs short. `$.ui.status` is not used, because it takes plain text only.

**Motion.** The `motion` option (`/config`, default `on`) sets how the panel moves:

| Motion | WORKING `◌○◎◉` pulse, `●` breathes | Row flash on a type change, meters slide over 400 ms |
|---|---|---|
| `on` | yes | yes |
| `calm` | yes | no |
| `off` | no | no |

- The flash fades the lead's background from 60% accent to nothing over 1.4 s. It marks a type change the panel saw while it was open. A change made while it was closed shows as unread instead.
- Animation runs in `Client` modules (`hooks/lead.tsx`, `hooks/meter.tsx`) on the surface's own clock, so the pane is not redrawn for it. A `Client` redraws only while it moves.
- While the person types at the prompt, the panel holds still. It flips at the start of a burst and 1.5 s after the last key, not on each key.
- Mobile has no `Client`, so it draws the same parts still.

**Theme.** A mod can't read the terminal background. The mod reads `COLORFGBG` and falls back to dark. That is an inferred rule.

## Data

- Each interactive session's mod writes its own record to `~/.claude/workstreams/<sessionId>.json` (type `SessionRecord` in `types/index.d.ts`). A `claude -p` run, such as one a hook spawns, writes none. Background sessions count as interactive and write records.
  - `state`: `approve | pick | your-turn | working`. `approve` comes from `classic.PermissionRequest`, `pick` from an `AskUserQuestion` call, `working` from `turn.start`, and `your-turn` from the main loop's `turn.complete`. A subagent's `turn.complete` does not change it, but a subagent's permission dialog does. Only the tool call that raised the ask clears it.
  - `ask`: `{ kind: "permission", text }` or `{ kind: "question", text, options }` (the first question of an `AskUserQuestion`). It is absent for `your-turn` and `working`. A `your-turn` row shows the last line of `lastTurn` as its ask; without one, the session's name, then `lastInstruction` in dim, then `new session`.
  - `lastInstruction`: the first 500 characters of the last typed prompt. A turn the harness starts (a subagent's hand-off, a task notice) opens with a tag and keeps the previous one. `lastTurn`: the last 500 characters of the last answer.
  - `did`: what the last turn's tools did, written at `turn.complete` and cleared at `turn.start`.
  - `context` from `$.session.usage()`, `model`, `version`, and `cmux` (`CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`).
  - `stateSince` changes only when `state` changes, and AGE reads it. `updatedAt` changes on every write, at least once a minute.
- The record lives in `$.state`, so a hot reload keeps `state` and `stateSince`.
- `scan` compares each row's type with the last scan's and stamps `changedAt` on a change, for the flash. It stamps nothing when the last scan is more than 30 s old.
- `$.store` key `seen` holds `{ floor, ids }`: when each session was last selected in any panel (type `Seen`).
- REVIEW is not a session state. The panel derives it: a `your-turn` session in a checkout whose branch has an open PR by someone else (`lane pr N` lanes). A session on your own PR stays YOUR TURN.
- The panel scans every 10 s while open: records, `claude agents --json --all` (one row per session; a session listed twice keeps its live entry), git per folder, and `gh` once a minute per folder and branch.
- The panel deletes a record whose folder is gone and whose session stopped writing 2 minutes ago.
- `$.fs.write` has no atomic rename, so a reader can find a half-written file. The panel skips a record it cannot parse and reads it again on the next tick.

## Ruled out

Cross-session messaging, typing answers in the mod, pin, auto-delete, notifications from the mod, guessing prose questions, a recap on arrival, a WHERE column, ending or replacing a session to switch away from it.

## Build order

All six slices are built.

1. Status line.
2. Per-session state record.
3. Panel: list, banner, preview, usage.
4. ⏎ switch.
5. Toast on change.
6. Wrap.

Not built: the auto-compact tick on the context meter (the mod cannot read the compact point), and a `theme` option.

## Open

- How do toasts behave while the panel is open?
- The switch from an attached background session relies on the tab title matching the session's name. Two sessions with the same name fall back to a new tab.

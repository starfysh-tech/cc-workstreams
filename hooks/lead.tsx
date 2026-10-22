import type { ClientModule } from 'claude-code'

type Props = {
  tree: string
  glyph: string
  color?: string
  isDim: boolean
  isUnread: boolean
  accent: string
  mode: 'pulse' | 'breathe' | 'still'
  // A new value starts the flash; the hooks pass it only for a change seen moments ago.
  flash?: number
  flashColors: string[]
  breathColors: string[]
}
type State = { tick: number; flash?: number; flashAt: number }

const PULSE = '◌○◎◉◎○'
const latest = new WeakMap<object, Props>()

// A row's tree line, type glyph and unread mark. It animates on the surface's own clock, so the pane is not
// redrawn for it, and it ticks only while something moves.
const Lead: ClientModule<Props, State> = (props, surface) => {
  latest.set(surface, props)
  if (surface.state === undefined) {
    surface.setState({ tick: 0, flashAt: -99 })
    surface.every(200, () => {
      const p = latest.get(surface)
      const s = surface.state
      if (!p || !s) return
      if (p.flash !== undefined && p.flash !== s.flash) return surface.setState({ tick: s.tick + 1, flash: p.flash, flashAt: s.tick + 1 })
      if (p.mode !== 'still' || s.tick - s.flashAt < p.flashColors.length) surface.setState({ ...s, tick: s.tick + 1 })
    })
  }
  const { Box, Text } = surface.elements
  const s = surface.state ?? { tick: 0, flashAt: -99 }
  const since = s.tick - s.flashAt
  const backgroundColor = since >= 0 && since < props.flashColors.length ? props.flashColors[since] : undefined
  const glyph = props.mode === 'pulse' ? (PULSE[s.tick % PULSE.length] ?? props.glyph) : props.glyph
  const color = props.mode === 'breathe' ? props.breathColors[s.tick % props.breathColors.length] : props.color
  return Box({
    flexDirection: 'row',
    children: [
      Text({ dimColor: true, backgroundColor, children: [props.tree] }),
      Text({ color, dimColor: props.isDim, backgroundColor, children: [`${glyph} `] }),
      Text({ color: props.accent, backgroundColor, children: [props.isUnread ? '✦ ' : '  '] }),
    ],
  })
}

export default Lead

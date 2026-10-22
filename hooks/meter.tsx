import type { ClientModule } from 'claude-code'

type Props = { percent: number; colors: { fill: string; track: string }[]; tick?: number; tickColor: string }
type State = { shown: number; from: number; step: number }

const EIGHTHS = ' ▏▎▍▌▋▊▉'
const STEPS = 10
const latest = new WeakMap<object, Props>()

// A panel meter that slides to a new value over 400 ms with ease-out, on the surface's own clock.
const Meter: ClientModule<Props, State> = (props, surface) => {
  latest.set(surface, props)
  if (surface.state === undefined) {
    surface.setState({ shown: props.percent, from: props.percent, step: STEPS })
    surface.every(40, () => {
      const p = latest.get(surface)
      const s = surface.state
      if (!p || !s) return
      if (s.step >= STEPS && s.shown === p.percent) return
      // A new target restarts the slide from where the meter stands now.
      const from = s.step >= STEPS ? s.shown : s.from
      const step = s.step >= STEPS ? 1 : s.step + 1
      const t = 1 - (1 - step / STEPS) ** 3
      surface.setState({ from, step, shown: step >= STEPS ? p.percent : from + (p.percent - from) * t })
    })
  }
  const { Text } = surface.elements
  const shown = surface.state?.shown ?? props.percent
  const cells = props.colors.length
  // Any use at all shows at least a sliver, so 1% never reads as empty.
  const eighths = Math.max(shown > 0 ? 1 : 0, Math.round((Math.min(100, shown) / 100) * cells * 8))
  return Text({
    children: props.colors.map(({ fill, track }, i) => {
      if (i === props.tick) return Text({ color: props.tickColor, backgroundColor: track, children: ['┃'] })
      const left = eighths - i * 8
      if (left >= 8) return Text({ color: fill, children: ['█'] })
      if (left > 0) return Text({ color: fill, backgroundColor: track, children: [EIGHTHS[left] ?? ' '] })
      return Text({ backgroundColor: track, children: [' '] })
    }),
  })
}

export default Meter

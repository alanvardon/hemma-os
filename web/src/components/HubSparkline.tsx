import { LinePath } from '@visx/shape'
import { scaleLinear } from '@visx/scale'
import { curveMonotoneX } from '@visx/curve'

// Tiny trend line for the hub's wide bento cards (plan 30) — no axes, no
// tooltip; the figure next to it carries the meaning, so the SVG is
// aria-hidden. Stroke color comes from CSS (.hub-spark-line) so it follows
// theme flips without a JS re-render.

interface Props {
  values: number[]
  width?: number
  height?: number
}

export default function HubSparkline({ values, width = 120, height = 36 }: Props) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min) * 0.1 || 1
  const x = scaleLinear<number>({ domain: [0, values.length - 1], range: [1.5, width - 1.5] })
  const y = scaleLinear<number>({ domain: [min - pad, max + pad], range: [height - 1.5, 1.5] })
  return (
    <svg className="hub-spark" width={width} height={height} aria-hidden="true">
      <LinePath<number>
        className="hub-spark-line"
        data={values}
        x={(_, i) => x(i)}
        y={(d) => y(d)}
        curve={curveMonotoneX}
      />
    </svg>
  )
}

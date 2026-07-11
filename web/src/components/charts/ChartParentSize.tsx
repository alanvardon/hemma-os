import { useParentSize } from '@visx/responsive'
import type { ReactNode } from 'react'

// A drop-in for visx's <ParentSize> that measures the same way but does NOT
// clip. ParentSize wraps children in a hardcoded `overflow: hidden`
// measurement div (measurementStyles in its source, not overridable by any
// prop), which crops any tooltip that extends past the plot bounds — visible
// on short charts where the tooltip flips above a near-top point. This
// collapses to a single `position: relative` div with overflow visible so the
// absolutely-positioned tooltip can escape upward, while width/height are
// measured identically (same useParentSize hook).
export default function ChartParentSize({
  children,
}: {
  children: (size: { width: number; height: number }) => ReactNode
}) {
  const { parentRef, width, height } = useParentSize()
  return (
    <div ref={parentRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {width > 0 && height > 0 ? children({ width, height }) : null}
    </div>
  )
}

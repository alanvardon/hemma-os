// Swedish HUD text for Gå runt (v41 FP_WHERE and the headroom line, 1815–1826).

import { mustStoop, type Where } from '../../lib/vindsplanen/walk'

export const WHERE_TEXT: Record<Where, string> = {
  attic: 'På vinden',
  below: 'Våningen under · hallen',
  old: 'I den gamla trappan',
  new: 'I den nya trappan',
  ground: 'Bottenvåningen · vid foten av den gamla trappan',
}

/** The headroom line: with the stoop warning, and the B9 hint on the old stairs while B9 is a guess. */
export function headText(head: number, where: Where | '', b9Measured: boolean): string {
  const stoop = mustStoop(head)
  return (
    `Fri höjd ${Math.round(head * 100)} cm` +
    (stoop ? ' · se upp med huvudet, du måste böja dig' : '') +
    (where === 'old' && stoop && !b9Measured ? ' (den gamla trappans stegdjup är en gissning: mät B9)' : '')
  )
}

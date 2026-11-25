// English HUD text for walk mode (v41 FP_WHERE and the headroom line, 1815–1826).

import { mustStoop, type Where } from '../../lib/vindsplanen/walk'

export const WHERE_TEXT: Record<Where, string> = {
  attic: 'In the attic',
  below: 'Floor below · hallway',
  old: 'On the old stairs',
  new: 'On the new stairs',
  ground: 'Ground floor · foot of the old stairs',
}

/** The headroom line: with the stoop warning, and the B9 hint on the old stairs while B9 is a guess. */
export function headText(head: number, where: Where | '', b9Measured: boolean): string {
  const stoop = mustStoop(head)
  return (
    `Headroom ${Math.round(head * 100)} cm` +
    (stoop ? ' · mind your head, you have to stoop' : '') +
    (where === 'old' && stoop && !b9Measured ? ' (the old stairs’ step depth is a guess: measure B9)' : '')
  )
}

/* person-identity-suggestions.ts — read each tool's CURRENT A/B display names
   for the "Personer i hushållet" setup flow (plan 111, Stage 2). The three
   stores are imported dynamically so the always-mounted household menu does
   not pull the tool bundles until the setup editor actually opens. Loads go
   through the stores' own settings loaders (cloud with cache/default
   fallback), so the suggestions match exactly what each tool shows today. */

import type { IdentityTool } from './person-identity'

export interface ToolNameSuggestion {
  tool: IdentityTool
  label: string
  a: string
  b: string
}

export const IDENTITY_TOOL_LABELS: Record<IdentityTool, string> = {
  bolanekoll: 'Bolånekoll',
  hushallsbudget: 'Hushållsbudget',
  manadsavslut: 'Månadsavslut',
}

export async function loadIdentitySuggestions(): Promise<ToolNameSuggestion[]> {
  const [mortgage, budget, monthEnd] = await Promise.all([
    import('./mortgage-store').then((store) => store.getSettings()).catch(() => null),
    import('./hushallsbudget-store').then((store) => store.loadBudget()).catch(() => null),
    import('./manadsavslut-store').then((store) => store.getSettings()).catch(() => null),
  ])
  return [
    {
      tool: 'bolanekoll',
      label: IDENTITY_TOOL_LABELS.bolanekoll,
      a: mortgage?.owner_a_name || 'Alex',
      b: mortgage?.owner_b_name || 'Sam',
    },
    {
      tool: 'hushallsbudget',
      label: IDENTITY_TOOL_LABELS.hushallsbudget,
      a: budget?.people?.[0] || 'Alan',
      b: budget?.people?.[1] || 'Partner',
    },
    {
      tool: 'manadsavslut',
      label: IDENTITY_TOOL_LABELS.manadsavslut,
      a: monthEnd?.person_a_name || 'Alex',
      b: monthEnd?.person_b_name || 'Sam',
    },
  ]
}

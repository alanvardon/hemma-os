import { useCallback } from 'react'

// Shared owner/person display-name resolver for the tool routes. Bolånekoll
// (owner_a_name / owner_b_name) and Månadsavslut (person_a_name /
// person_b_name) both fall back to the same Alex/Sam defaults and map an
// 'a' | 'b' id to a name — extracted from the ~7 hand-written copies of that
// logic across the two routes (plan 39, section D). Pass the two raw name
// fields (either settings or an in-progress edit form); a null/undefined id
// resolves to '' for the sites where the id is optional (e.g. an unset debtor).
export function usePersonNames(aRaw?: string | null, bRaw?: string | null): {
  a: string
  b: string
  nameOf: (p: 'a' | 'b' | null | undefined) => string
} {
  const a = aRaw || 'Alex'
  const b = bRaw || 'Sam'
  const nameOf = useCallback(
    (p: 'a' | 'b' | null | undefined) => (p === 'b' ? b : p === 'a' ? a : ''),
    [a, b],
  )
  return { a, b, nameOf }
}

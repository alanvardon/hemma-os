// Swedish copy for the Measure tab's coded steps (v41 `walkSteps`, 1868–1960).
// The registry in lib/vindsplanen/measure.ts carries codes, fields and camera
// data; the words are the route's. A D step is worded from the door it measures.

import { fieldDisplay, type MeasureStep } from '../../lib/vindsplanen/measure'

export interface StepText {
  title: string
  sub: string
  how: string
  /** One label per field, in the registry's order. */
  fields: string[]
}

const TODAY = 'Mät vinden som den är idag, innan något tagits bort eller isolerats.'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })

export function stepText(st: MeasureStep, side: 'N' | 'S'): StepText {
  const longWall = side === 'S' ? 'södra' : 'norra'
  const farWall = side === 'S' ? 'norra' : 'södra'
  switch (st.code) {
    case 'A1':
      return { title: 'Vindens längd', sub: 'Västra gavelväggen till östra gavelväggen', how: `Längs golvet mitt på vinden, från västra gavelväggen till östra gavelväggen (den med fönstret). ${TODAY}`, fields: ['Västra gaveln till östra gaveln'] }
    case 'A2':
      return { title: 'Bredd mellan knäväggarna', sub: 'Södra knäväggen till norra knäväggen', how: `Tvärs över golvet, från den låga södra väggens yta till den låga norra väggens yta, i rät vinkel mot dem. ${TODAY}`, fields: ['Knävägg till knävägg'] }
    case 'A3':
      return { title: 'Knäväggens höjd', sub: 'Golv till knäväggens överkant', how: `Från golvet rakt upp till där den låga väggen möter det sluttande taket. ${TODAY}`, fields: ['Golv till knäväggens överkant'] }
    case 'A4':
      return { title: 'Nockhöjd', sub: 'Golv till takets högsta punkt', how: `Från golvet rakt upp till taket på dess högsta punkt, mitt på vinden. Mät till panelen, inte till en bjälke som hänger under den. ${TODAY}`, fields: ['Golv till taket högst upp'] }
    case 'A5':
      return { title: 'Första sparren', sub: 'Västra gavelväggen till mitten av första sparren', how: `Längs det sluttande taket (eller längs golvet med hjälp av ett vattenpass), från västra gavelväggen till mitten av första sparren. ${TODAY}`, fields: ['Västra gaveln till sparrens mitt'] }
    case 'A6':
      return { title: 'Sparrarnas avstånd', sub: 'Mitten av en sparre till mitten av nästa', how: `Från mitten av en sparre till mitten av nästa (samma som från vänster sida av en till vänster sida av nästa). Om de inte sitter jämnt, mät varje avstånd. ${TODAY}`, fields: ['Centrum till centrum'] }
    case 'A7':
      return { title: 'Antal sparrar', sub: 'På ena sidan av taket', how: `Räkna sparrarna på ett takfall, från gavel till gavel. Räkna inte själva gavelväggarna. ${TODAY}`, fields: ['Sparrar på ena sidan'] }
    case 'A8':
      return { title: 'Sparrens storlek', sub: 'Hur djup och tjock en sparre är', how: `På en sparre: hur långt den sticker ut under panelen (djupet) och hur tjock den är från sida till sida. ${TODAY}`, fields: ['Djup under panelen', 'Tjocklek'] }
    case 'B1':
      return { title: 'Takhöjd', sub: 'Hallens golv till tak', how: 'Stå i hallen och mät från golvet rakt upp till taket.', fields: ['Golv till tak'] }
    case 'B2':
      return { title: 'Våning till våning', sub: 'Hallens golv till vindsgolvet', how: 'Vid trapphålet, mät från hallens golv upp till vindsgolvets yta (genom luckan eller upp genom trappöppningen). Det ger tjockleken på bjälklaget emellan.', fields: ['Hallens golv till vindsgolv'] }
    case 'B3':
      return { title: 'Hallens längd', sub: 'Östra väggen till västra ändväggen', how: 'Från östra väggen (med fönstret) längs hallen till västra ändväggen (med dörrarna).', fields: ['Östra väggen till västra änden'] }
    case 'B4':
      return { title: 'Trapphålets längd', sub: 'Östra väggen till öppningens slut', how: 'Längs trapphålet: från östra väggen till trapphålsöppningens västra ände, där spjälskärmen börjar.', fields: ['Östra väggen till öppningens slut'] }
    case 'B5':
      return { title: 'Trapphålets bredd', sub: 'Långväggen till skärmlinjen', how: `Tvärs över trapphålet: från ${longWall} väggen till spjälskärmens och räckets linje.`, fields: ['Vägg till skärmlinje'] }
    case 'B6':
      return { title: 'Hallen intill trapphålet', sub: 'Skärmlinjen till motstående vägg', how: `Från spjälskärmen och räcket tvärs över hallen till ${farWall} väggen.`, fields: ['Skärmlinje till vägg'] }
    case 'B7':
      return { title: 'Spjälskärm', sub: 'Västra änden till den vita stolpen', how: 'Längs skärmen: från dess västra ände till den vita stolpen där det låga räcket börjar.', fields: ['Skärmens längd'] }
    case 'B8':
      return { title: 'Den gamla trappan', sub: 'Antal steg, steghöjd, bredd', how: 'Räkna stegen från bottenvåningen upp till den här hallen (räkna varje steg du lyfter foten upp på, inklusive det översta), mät höjden på ett steg och trappans bredd.', fields: ['Antal steg', 'Höjd på ett steg', 'Trappans bredd'] }
    case 'B9':
      return {
        title: 'Gamla trappan: form',
        sub: 'Stegdjup och hur stegen svänger',
        how: 'På en rak del av den gamla trappan, mät från framkanten av ett steg till framkanten av nästa, plant längs steget. Räkna sedan, på väg uppåt, de kilformade stegen i svängen (smala vid stolpen, breda vid väggen) och de raka stegen efter svängen innan du kliver upp på avsatsen. Tillsammans med B8 avgör det hur långt den gamla trappan går in under hallgolvet, och därmed takhöjden på vägen ned.',
        fields: ['Stegdjup', 'Kilformade steg i svängen', 'Raka steg efter svängen'],
      }
    case 'W1':
      return { title: 'Hallfönster', sub: 'I östra väggen i hallens ände', how: 'Nere vid fönstret i östra väggen: mät längs väggen från norra väggen (trapphålssidan) till fönsteröppningens närmaste kant, sedan bredd, höjd och från golvet upp till fönsterbänken. Mät öppningen i väggen, inte karmen.', fields: ['Norra väggen till fönsterkanten', 'Bredd', 'Höjd', 'Golv till fönsterbänk'] }
    case 'W2':
      return { title: 'Vindsfönster', sub: 'I vindens östra gavelvägg', how: 'På vinden vid fönstret i östra gavelväggen: mät längs väggen från hörnet med norra knäväggen till fönsteröppningens närmaste kant, sedan bredd, höjd och från golvet upp till fönsterbänken. Om det inte finns något fönster där, hoppa över och bocka ur det under Rummet → Fönster i östra gaveln.', fields: ['Norra knäväggen till fönsterkanten', 'Bredd', 'Höjd', 'Golv till fönsterbänk'] }
  }
  // D steps: the door being measured.
  const d = st.door
  const isW = d?.wall === 'W'
  const what = d?.kind === 'panel' ? 'skåp' : 'dörr'
  const where = isW ? 'västra ändväggen' : `${d?.wall === 'N' ? 'norra' : 'södra'} väggen`
  const ref = isW ? 'norra väggen' : 'östra väggen'
  return {
    title: `${cap(what)} i ${where}`,
    sub: `${cap(ref)} till närmaste kant, och bredd`,
    how: `Mät längs golvet från ${ref} till närmaste kant på ${what}söppningen (innanför karmen), sedan öppningens bredd.`,
    fields: [`Från ${ref} till kanten`, 'Öppningens bredd'],
  }
}

export const GROUPS: { code: 'A' | 'B' | 'W' | 'D'; title: string; note: string }[] = [
  { code: 'A', title: 'A · Vinden', note: 'Mät idag, innan något tas bort' },
  { code: 'B', title: 'B · Våningen under', note: 'Hallen och trapphålet under de nya trapporna' },
  { code: 'W', title: 'W · Fönster', note: 'Båda fönstren i östra väggen, ett över det andra' },
  { code: 'D', title: 'D · Dörrar på våningen under', note: 'Var varje dörr sitter längs sin vägg' },
]

/** v41 `valText`: the step's current values. */
export const valueText = (st: MeasureStep): string =>
  st.fields.map((f) => (f.raw ? String(fieldDisplay(f)) : `${nf.format(fieldDisplay(f))} cm`)).join(' · ')

/** v41 `whenText`. */
export const whenText = (v: string): string => (v === 'earlier' ? 'tidigare' : v)

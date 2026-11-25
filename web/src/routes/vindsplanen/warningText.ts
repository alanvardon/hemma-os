// Swedish wording for the structured warnings from lib/vindsplanen/warnings.ts.
// Translated from v41's English messages (vindsplanen-v41.html 1068–1291);
// the numbers are the ones v41 printed (whole cm, or one decimal where it did).
// One entry per WarningCode, so adding a code without wording fails the build.

import type { Warning, WarningCode } from '../../lib/vindsplanen/warnings'

type Params = Record<string, number | string>

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })
const n = (v: unknown): string => nf.format(Number(v))

const WALL: Record<string, string> = { W: 'västra änden', N: 'norra väggen', S: 'södra väggen' }

const TEXT: Record<WarningCode, (p: Params) => string> = {
  'furn-roof-clash': () => 'Går in i taklutningen. Flytta den mot mitten eller gör den lägre.',
  'furn-outside': () => 'Sticker ut bakom en knävägg eller genom en gavel.',
  'wall-door-low': (p) => `Dörren kan bara bli ${n(p.h)} cm hög här. Flytta den mot mitten.`,
  'wall-on-rafter': () => 'Sitter på en sparrlinje. Det är bra och ofta enklast att fästa i.',
  'sky-wider-than-bay': (p) => `${n(p.w)} cm är bredare än de ${n(p.clear)} cm mellan sparrarna. En sparre måste kapas och förstärkas.`,
  'sky-reaches-ridge': () => 'För högt upp. Fönstret når upp till nocken.',
  'sky-overlap': () => 'Överlappar ett annat takfönster. Flytta det ena.',
  'stairs-outside': () => 'Öppningen går förbi en knävägg eller gavel.',
  'stairs-steep-rise': (p) => `Varje steg är ${n(p.rise)} cm högt, vilket är brant. Sikta på ungefär 18 cm.`,
  'stairs-too-steep': (p) => `För brant för daglig användning (2 × stighöjd + stegdjup = ${n(p.blondel)} cm; 60–65 cm är bekvämt). Gör trappan längre.`,
  'stairs-shallow': (p) => `Mycket flacka steg (2 × stighöjd + stegdjup = ${n(p.blondel)} cm). Trappan kan göras kortare.`,
  'stairs-low-head': (p) => `Låg takhöjd i trappan: ${n(p.head)} cm på den trängsta punkten. Flytta den mot mitten av vinden.`,
  'up-walkway-narrow': (p) => `Bara ${n(p.free)} cm kvar att gå förbi i hallen under (cirka 80 cm behövs), vilket skulle blockera vägen till den befintliga trappan.`,
  'up-outside-hall': () => 'Trappan går utanför hallen under, genom en vägg. Flytta eller vrid den.',
  'up-over-well': (p) => `Första steget når ${n(p.reach)} cm över det befintliga trapphålet. Börja på fast golv: flytta trappan västerut, eller bygg ut hallgolvet ${n(p.need)} cm över trapphålet (Rummet → Våningen under).`,
  'up-low-head': (p) => `Låg takhöjd under taket: ${n(p.head)} cm vid det trängsta steget (sikta på 190 eller mer). Sväng mot mitten av vinden tidigare.`,
  'up-down-head': (p) => `Den som går ned i den befintliga trappan får bara ${n(p.head)} cm över huvudet under de nya trappstegen.`,
  'up-knee-wall': () => 'Öppningen i vindsgolvet går bakom en knävägg, så knäväggen måste flyttas eller byggas om runt trappan.',
  'up-hole-clash': () => 'Öppningen överlappar en annan trappöppning. Ta bort eller flytta den andra trappan.',
  'spiral-landing-head': (p) => `Den som går på steg ${n(p.step)} passerar under det övre planet med bara ${n(p.head)} cm över huvudet (cirka 2 m behövs). Vrid spiralen så att planet hamnar över de lägsta stegen.`,
  'spiral-shallow': (p) => `Stegen är bara ${n(p.going)} cm djupa längs gånglinjen (cirka 20 cm eller mer behövs). Gör spiralen bredare, vrid den längre eller lägg till steg.`,
  'up-steep-rise': (p) => `Varje steg är ${n(p.rise)} cm högt, vilket är brant (cirka 18–20 cm är bekvämt). Håll alla steg lika höga.`,
  'up-door-blocked': (p) => {
    const count = Number(p.count)
    const walls = String(p.walls ?? '')
      .split(',')
      .filter(Boolean)
      .map((w) => WALL[w] ?? w)
      .join(', ')
    return `Trappstegen står framför ${count > 1 ? `${count} dörrar` : 'en dörr'} på våningen under (${walls}). Flytta trappan eller dörren.`
  },
  'storage-hole-overlap': () => 'Förrådet överlappar trappöppningen. Gör det kortare eller skjut det längs väggen.',
  'storage-low-front': (p) => `Bara ${n(p.h)} cm högt framtill. Gör det grundare så att frontväggen hamnar där taket är högre.`,
  'closet-hole-overlap': () => 'Garderoben överlappar trappöppningen. Gör den grundare.',
  'closet-door-low': (p) => `Dörren kan bara bli ${n(p.h)} cm hög så långt in under sluttningen. Gör garderoben kortare så att dörrändan hamnar där taket är högre.`,
  'closet-shallow': (p) => `Bara ${n(p.depth)} cm djup invändigt: räcker till hyllor, inte till hängande kläder.`,
}

export function warningText(w: Warning): string {
  const f = TEXT[w.code]
  return f ? f(w.params) : w.code
}

export const WARNING_CODES = Object.keys(TEXT) as WarningCode[]

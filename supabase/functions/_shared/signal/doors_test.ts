// Run: deno test _shared/signal/doors_test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { parseDoorsHint } from './doors.ts'

Deno.test('doors_hint: a number tied to units/doors/homes/apartments/properties, lower bound of a range', () => {
  assertEquals(parseDoorsHint('over 1,000,000 apartments'), 1_000_000)
  assertEquals(parseDoorsHint('5,000 units'), 5000)
  assertEquals(parseDoorsHint('260+ cities across 24 states plus Washington D.C. (unit count not stated)'), null)
  assertEquals(parseDoorsHint('200-300 doors'), 200)
  assertEquals(parseDoorsHint('Manages 1,200+ single-family homes in Phoenix'), 1200)
  assertEquals(parseDoorsHint('about 2.5k rental units'), 2500)
  assertEquals(parseDoorsHint('150 properties managed'), 150)
  assertEquals(parseDoorsHint('founded 1998, 40 employees'), null)
  assertEquals(parseDoorsHint('multifamily, unit count not stated'), null)
  assertEquals(parseDoorsHint(null), null)
})

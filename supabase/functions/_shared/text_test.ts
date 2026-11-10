import { assertEquals } from 'jsr:@std/assert@1'
import { clip, deepWellFormed, wellFormed } from './text.ts'

const EMOJI = '\u{1F600}' // two UTF-16 units

Deno.test('clip never splits an emoji', () => {
  const s = 'ab' + EMOJI
  assertEquals(clip(s, 3), 'ab')
  assertEquals(clip(s, 4), s)
  assertEquals(JSON.parse(JSON.stringify(clip(s, 3))), 'ab')
})

Deno.test('wellFormed drops lone surrogates, keeps pairs', () => {
  assertEquals(wellFormed('x\uD83Dy' + EMOJI + '\uDE00'), 'xy' + EMOJI)
})

Deno.test('deepWellFormed walks objects and arrays', () => {
  assertEquals(deepWellFormed({ a: ['\uD83D', { b: 'ok' + EMOJI }], n: 1 }), { a: ['', { b: 'ok' + EMOJI }], n: 1 })
})

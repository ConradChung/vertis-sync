import { describe, expect, it } from 'vitest'
import { keyIntent, moveFocus } from '@/lib/validate/keyboard'

const k = (key: string, o: Partial<Parameters<typeof keyIntent>[0]> = {}) => keyIntent({ key, ...o })

describe('keyIntent', () => {
  it('maps J/K/A/R/E (either case)', () => {
    expect(k('j')).toBe('next')
    expect(k('J')).toBe('next')
    expect(k('k')).toBe('prev')
    expect(k('a')).toBe('approve')
    expect(k('r')).toBe('reject')
    expect(k('e')).toBe('edit')
  })
  it('ignores other keys', () => {
    expect(k('x')).toBeNull()
    expect(k('Enter')).toBeNull()
  })
  it('ignores modified keys (Cmd+R reloads, Ctrl+A selects)', () => {
    expect(k('r', { metaKey: true })).toBeNull()
    expect(k('a', { ctrlKey: true })).toBeNull()
    expect(k('j', { altKey: true })).toBeNull()
  })
  it('ignores keys while typing in inputs, textareas, selects and contenteditable', () => {
    expect(k('j', { targetTag: 'INPUT' })).toBeNull()
    expect(k('a', { targetTag: 'textarea' })).toBeNull()
    expect(k('r', { targetTag: 'SELECT' })).toBeNull()
    expect(k('e', { targetEditable: true })).toBeNull()
  })
  it('still works from a button or the card itself', () => {
    expect(k('j', { targetTag: 'BUTTON' })).toBe('next')
    expect(k('a', { targetTag: 'DIV' })).toBe('approve')
  })
  it('ignores auto-repeat for decisions but not for movement', () => {
    expect(k('a', { repeat: true })).toBeNull()
    expect(k('j', { repeat: true })).toBe('next')
  })
})

describe('moveFocus', () => {
  it('moves and clamps', () => {
    expect(moveFocus(0, 3, 'next')).toBe(1)
    expect(moveFocus(2, 3, 'next')).toBe(2)
    expect(moveFocus(0, 3, 'prev')).toBe(0)
    expect(moveFocus(2, 3, 'prev')).toBe(1)
  })
  it('starts at the first card from no focus', () => {
    expect(moveFocus(-1, 3, 'next')).toBe(0)
    expect(moveFocus(-1, 3, 'prev')).toBe(0)
  })
  it('empty list → -1', () => {
    expect(moveFocus(0, 0, 'next')).toBe(-1)
  })
})

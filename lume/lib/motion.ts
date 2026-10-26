/**
 * Reduced-motion switch for Lume. The owner chose to always animate, so this
 * ignores the OS "Reduce motion" setting and always returns false. Every
 * component asks here (not `motion/react` or matchMedia), so restoring the OS
 * behaviour later is a one-line change.
 */
export function useReducedMotion(): boolean {
  return false
}

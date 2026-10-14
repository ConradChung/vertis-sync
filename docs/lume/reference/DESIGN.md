# Lume design system

## Direction
Apple Liquid Glass meets a live trading terminal. Dark mode only, with elevated layers using the `.glass` utility and reading surfaces using `.surface`.

## Tokens
- Background: `#070711`; panels use `rgba(20, 19, 35, .76)`.
- Accent: violet `#8B5CF6`.
- Semantic: green `#22C55E`, amber `#F59E0B`, red `#F43F5E`, cyan `#06B6D4`.
- Text: white at 100%, 70%, 46%, and 24% opacity.
- UI font: DM Sans; mono metadata: JetBrains Mono.

## Spacing
Base unit is 4px. Common spacing values: 4, 8, 12, 16, 20, 24, 32, 40, 60. Cards use 16–18px internal padding, grid gutters are 16px in the dense desktop layout.

## Motion rules
Use motion to clarify live state: feed items enter from the top, shimmer marks pending work, and the orb communicates agent state. Keep transitions short (200–450ms). Respect `prefers-reduced-motion` when expanding the component library.

## Glass recipe
```css
.glass {
  background: linear-gradient(135deg, rgba(255,255,255,.09), rgba(255,255,255,.035));
  backdrop-filter: blur(22px);
  border: 1px solid rgba(255,255,255,.11);
  box-shadow: inset 0 1px rgba(255,255,255,.11);
}
```
Elevated surfaces use glass; tables remain 94% opaque for contrast.

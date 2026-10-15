'use client'

// Port of docs/lume/reference/orb.tsx. @react-three/fiber v9 augments React's
// JSX namespace with the three.js intrinsics itself, so the reference file's
// `declare module 'react'` hack is gone. Behaviour is otherwise as-is, plus a
// reduced-motion branch that freezes the mesh and stops the render loop.

import { Canvas, useFrame } from '@react-three/fiber'
import { MeshTransmissionMaterial } from '@react-three/drei'
import { useReducedMotion } from 'motion/react'
import { useRef } from 'react'
import type { Mesh } from 'three'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'acting' | 'needs-approval'

export type OrbProps = {
  /** Driven by `agent_runs` (Task 14). Defaults to idle. */
  state?: OrbState
  /** 42 px for the top bar, 122 px for the sheet. */
  compact?: boolean
}

const AMBER = '#f59e0b'
const VIOLET = '#8b5cf6'

export default function Orb({ state = 'idle', compact = false }: OrbProps) {
  const size = compact ? 42 : 122
  const reduceMotion = useReducedMotion() ?? false

  return (
    <div
      className={`orb-canvas ${state}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`agent ${state.replace('-', ' ')}`}
      data-state={state}
    >
      <Canvas
        camera={{ position: [0, 0, 3.2], fov: 35 }}
        dpr={[1, 2]}
        frameloop={reduceMotion ? 'demand' : 'always'}
      >
        <OrbMesh state={state} animate={!reduceMotion} />
      </Canvas>
      {state === 'acting' && <i className="orbit-ring" />}
    </div>
  )
}

function OrbMesh({ state, animate }: { state: OrbState; animate: boolean }) {
  const ref = useRef<Mesh>(null)

  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh || !animate) return
    const t = clock.getElapsedTime()
    const amp =
      state === 'listening'
        ? Math.sin(t * 5) * 0.07
        : state === 'thinking'
          ? Math.sin(t * 1.3) * 0.04
          : Math.sin(t * 0.9) * 0.018
    mesh.scale.setScalar(1 + amp)
    mesh.rotation.y = t * 0.12
    mesh.rotation.x = Math.sin(t * 0.4) * 0.08
  })

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[1, 64, 64]} />
      <MeshTransmissionMaterial
        backside
        backsideThickness={0.4}
        thickness={0.7}
        roughness={0.12}
        transmission={1}
        ior={1.35}
        chromaticAberration={0.12}
        anisotropy={0.25}
        color={state === 'needs-approval' ? AMBER : VIOLET}
      />
    </mesh>
  )
}

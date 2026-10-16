'use client'

// Port of docs/lume/reference/orb.tsx. @react-three/fiber v9 augments React's
// JSX namespace with the three.js intrinsics itself, so the reference file's
// `declare module 'react'` hack is gone. Behaviour is otherwise as-is, plus a
// reduced-motion branch that freezes the mesh and stops the render loop.
//
// Materials: a transmission material refracts what is behind it, and the
// 42 px top-bar canvas has nothing behind it and no lights, so it rendered
// solid black. The compact orb is an opaque MeshPhysicalMaterial (violet,
// emissive, clearcoat) under ambient + directional lights. The large orb
// (Task 14 sheet) keeps MeshTransmissionMaterial with the same lights, a local
// <Environment> built from <Lightformer>s (no HDR fetch) and a solid
// deep-violet `background` to refract.

import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Lightformer, MeshTransmissionMaterial } from '@react-three/drei'
import { useReducedMotion } from 'motion/react'
import { useMemo, useRef } from 'react'
import { Color, type Mesh } from 'three'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'acting' | 'needs-approval'

export type OrbProps = {
  /** Driven by `agent_runs` (Task 14). Defaults to idle. */
  state?: OrbState
  /** 42 px for the top bar, 122 px for the sheet. */
  compact?: boolean
}

const AMBER = '#f59e0b'
const VIOLET = '#8b5cf6'
const EMISSIVE_VIOLET = '#4c1d95'
const EMISSIVE_AMBER = '#78350f'

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
        <ambientLight intensity={0.55} />
        <directionalLight position={[2.5, 3, 4]} intensity={2.2} />
        <directionalLight position={[-3, -1.5, 2]} intensity={0.6} color="#c4b5fd" />
        {!compact && (
          <Environment resolution={64}>
            <Lightformer form="circle" intensity={3} position={[2, 2.5, 3]} scale={2} />
            <Lightformer form="rect" intensity={1.5} color="#c4b5fd" position={[-3, 0, 1]} scale={[1, 4, 1]} />
            <Lightformer form="ring" intensity={1} color={VIOLET} position={[0, -3, -2]} scale={3} />
          </Environment>
        )}
        <OrbMesh state={state} animate={!reduceMotion} compact={compact} />
      </Canvas>
      {state === 'acting' && <i className="orbit-ring" />}
    </div>
  )
}

function OrbMesh({ state, animate, compact }: { state: OrbState; animate: boolean; compact: boolean }) {
  const ref = useRef<Mesh>(null)
  const background = useMemo(() => new Color('#1b1236'), [])
  const amber = state === 'needs-approval'

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
      {compact ? (
        <meshPhysicalMaterial
          color={amber ? AMBER : VIOLET}
          emissive={amber ? EMISSIVE_AMBER : EMISSIVE_VIOLET}
          emissiveIntensity={0.5}
          roughness={0.15}
          metalness={0}
          clearcoat={1}
          clearcoatRoughness={0.1}
        />
      ) : (
        <MeshTransmissionMaterial
          background={background}
          backside
          backsideThickness={0.4}
          thickness={0.7}
          roughness={0.12}
          transmission={1}
          ior={1.35}
          chromaticAberration={0.12}
          anisotropy={0.25}
          color={amber ? AMBER : VIOLET}
        />
      )}
    </mesh>
  )
}

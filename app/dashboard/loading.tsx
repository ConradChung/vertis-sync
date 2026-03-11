'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import { useTheme } from '@/contexts/ThemeContext'

const PARTICLES = [
  { radius: 36, duration: 2.8, delay: 0,    size: 3 },
  { radius: 52, duration: 3.6, delay: 0.4,  size: 2 },
  { radius: 44, duration: 4.2, delay: 0.9,  size: 2.5 },
  { radius: 60, duration: 3.1, delay: 1.4,  size: 2 },
  { radius: 38, duration: 5.0, delay: 0.6,  size: 1.5 },
]

export default function Loading() {
  const { themeId } = useTheme()
  const logoSrc = (themeId === 'frost' || themeId === 'stark')
    ? '/northstar-logo-dark.png'
    : '/northstar-logo-white.png'

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-8 z-50"
      style={{ background: 'var(--bg)' }}
    >
      {/* Orbital system */}
      <div className="relative flex items-center justify-center" style={{ width: 140, height: 140 }}>

        {/* Orbiting particles */}
        {PARTICLES.map((p, i) => (
          <motion.div
            key={i}
            className="absolute"
            style={{
              width: p.size,
              height: p.size,
              borderRadius: '50%',
              background: 'var(--accent)',
              top: '50%',
              left: '50%',
              marginTop: -p.size / 2,
              marginLeft: -p.size / 2,
            }}
            animate={{
              rotate: [0, 360],
              x: [p.radius, -p.radius, p.radius],
              y: [0, p.radius * 0.6, 0, -p.radius * 0.6, 0],
              opacity: [0.3, 0.9, 0.4, 0.9, 0.3],
            }}
            transition={{
              duration: p.duration,
              delay: p.delay,
              repeat: Infinity,
              ease: 'linear',
            }}
          />
        ))}

        {/* Center logo — pulsing */}
        <motion.div
          className="relative z-10"
          animate={{
            scale: [0.95, 1.05, 0.95],
            opacity: [0.7, 1, 0.7],
          }}
          transition={{
            duration: 2.4,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          <Image
            src={logoSrc}
            alt="Northstar"
            width={40}
            height={40}
            className="rounded-xl"
          />
        </motion.div>
      </div>

      {/* Wordmark */}
      <motion.p
        className="text-[13px] font-medium tracking-wide"
        style={{ color: 'var(--text-tertiary)' }}
        animate={{ opacity: [0.4, 0.8, 0.4] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      >
        Northstar
      </motion.p>
    </div>
  )
}

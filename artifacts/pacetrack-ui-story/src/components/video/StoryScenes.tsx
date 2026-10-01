import { motion } from 'framer-motion';

const enter = {
  initial: { opacity: 0, y: 36, filter: 'blur(8px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, scale: 0.97, filter: 'blur(8px)' },
  transition: { duration: 0.48, ease: [0.16, 1, 0.3, 1] as const },
};

function BrandLine({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand-line${light ? ' brand-line--light' : ''}`}>
      <span>PACE</span>
      <b>/</b>
      <span>TRACK</span>
    </div>
  );
}

function TrackGraphic({ className = '' }: { className?: string }) {
  return (
    <motion.svg
      className={`track-graphic ${className}`}
      viewBox="0 0 420 250"
      fill="none"
      aria-hidden="true"
      initial={{ opacity: 0, scale: 0.82, rotate: -12 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={{ duration: 0.9, ease: 'easeOut' }}
    >
      <motion.ellipse
        cx="210"
        cy="125"
        rx="184"
        ry="78"
        transform="rotate(-18 210 125)"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="7 10"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: 'easeInOut' }}
      />
      <motion.ellipse
        cx="210"
        cy="125"
        rx="145"
        ry="51"
        transform="rotate(-18 210 125)"
        stroke="currentColor"
        strokeWidth="16"
        strokeOpacity=".12"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.05, delay: 0.15, ease: 'easeInOut' }}
      />
      <motion.circle
        cx="358"
        cy="88"
        r="8"
        fill="#ffae42"
        animate={{ scale: [1, 1.6, 1], opacity: [1, 0.62, 1] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.path
        d="M24 207H396"
        stroke="#ffae42"
        strokeWidth="2"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 0.75 }}
        transition={{ duration: 0.9, delay: 0.3 }}
      />
    </motion.svg>
  );
}

export function HookScene() {
  return (
    <motion.section
      className="story-stage story-stage--hook"
      {...enter}
      aria-label="La pista sigue. PaceTrack se renueva."
    >
      <div className="scene-grid" />
      <TrackGraphic className="hook-track" />
      <div className="story-safe">
        <div className="story-topline">
          <BrandLine light />
          <span className="topline-tag">UI / 2026</span>
        </div>

        <div className="hook-copy">
          <motion.p
            className="story-kicker"
            initial={{ opacity: 0, x: -22 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.12, duration: 0.4 }}
          >
            ACTUALIZACIÓN COMPLETA
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 44 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.62, ease: [0.16, 1, 0.3, 1] }}
          >
            LA PISTA
            <br />
            SIGUE.
          </motion.h1>
          <motion.div
            className="hook-accent"
            initial={{ clipPath: 'inset(0 100% 0 0)' }}
            animate={{ clipPath: 'inset(0 0 0 0)' }}
            transition={{ delay: 0.54, duration: 0.5 }}
          >
            PACE TRACK CAMBIA.
          </motion.div>
        </div>

        <motion.div
          className="hook-bottom"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.76, duration: 0.42 }}
        >
          <span>01 — 04</span>
          <span>NUEVA INTERFAZ / MISMO PULSO</span>
          <span className="scroll-arrow">↓</span>
        </motion.div>
      </div>
    </motion.section>
  );
}

export function InterfaceScene() {
  return (
    <motion.section
      className="story-stage story-stage--interface"
      {...enter}
      aria-label="PaceTrack estrena una interfaz renovada"
    >
      <div className="story-safe interface-safe">
        <div className="story-topline">
          <BrandLine />
          <span className="topline-tag topline-tag--ink">NUEVA ERA</span>
        </div>

        <div className="interface-heading">
          <motion.p
            className="story-kicker story-kicker--ink"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
          >
            TODA LA EXPERIENCIA
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.16, duration: 0.52 }}
          >
            ESTRENA
            <br />
            INTERFAZ.
          </motion.h2>
          <motion.p
            className="interface-subtitle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.38 }}
          >
            Renovada de principio a fin.
          </motion.p>
        </div>

        <motion.div
          className="home-screen"
          initial={{ opacity: 0, y: 100, rotate: 3 }}
          animate={{ opacity: 1, y: 0, rotate: -2 }}
          transition={{ delay: 0.22, duration: 0.64, type: 'spring', stiffness: 120 }}
        >
          <div className="screen-chrome">
            <BrandLine />
            <span className="screen-menu">MENU&nbsp; ☰</span>
          </div>
          <div className="screen-index">01 / HERRAMIENTAS DE PISTA</div>
          <div className="screen-hero">
            <div>
              <span className="screen-eyebrow">ENTRENA. MIDE. REPITE.</span>
              <strong>
                El tiempo
                <br />
                no <i>espera.</i>
              </strong>
              <span className="screen-cta">ABRIR CRONÓMETRO&nbsp; ↗</span>
            </div>
            <div className="screen-track">
              <div className="screen-track-line" />
              <span>00:00.000</span>
            </div>
          </div>
          <div className="screen-bottom">
            <span>PRECISIÓN PARA CADA VUELTA</span>
            <span>SCROLL ↓</span>
          </div>
        </motion.div>

        <div className="interface-footnote">
          <span className="footnote-dot" />
          DISEÑO NUEVO. IDENTIDAD PACE TRACK.
        </div>
      </div>
    </motion.section>
  );
}

const modes = [
  { number: '01', name: 'ORIGINAL', description: 'Control total de cada vuelta', time: '00:24.186' },
  { number: '02', name: 'LOOP', description: 'Repite. Mejora. Repite.', time: '00:18.402' },
  { number: '03', name: 'SECTOR', description: 'Precisión en cada tramo', time: '00:09.827' },
];

export function ScreensScene() {
  return (
    <motion.section
      className="story-stage story-stage--screens"
      {...enter}
      aria-label="Toda la interfaz, de la portada al cronómetro"
    >
      <div className="story-safe screens-safe">
        <div className="story-topline">
          <BrandLine light />
          <span className="topline-tag">02 / 03</span>
        </div>

        <div className="screens-heading">
          <motion.p
            className="story-kicker"
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
          >
            DE LA PORTADA AL CRONO
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5 }}
          >
            CADA
            <br />
            PANTALLA,
            <br />
            <span>AFINADA.</span>
          </motion.h2>
        </div>

        <div className="mode-stack">
          {modes.map((mode, index) => (
            <motion.div
              className={`mode-card mode-card--${index + 1}`}
              key={mode.name}
              initial={{ opacity: 0, x: 90, rotate: 5 }}
              animate={{ opacity: 1, x: 0, rotate: 0 }}
              transition={{
                delay: 0.18 + index * 0.17,
                type: 'spring',
                stiffness: 170,
                damping: 20,
              }}
            >
              <span className="mode-number">{mode.number}</span>
              <span className="mode-name">{mode.name}</span>
              <span className="mode-description">{mode.description}</span>
              <span className="mode-time">{mode.time}</span>
              <span className="mode-trail" />
            </motion.div>
          ))}
        </div>

        <motion.p
          className="screens-caption"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.72 }}
        >
          Toda PaceTrack, renovada.
        </motion.p>
      </div>
    </motion.section>
  );
}

export function OutroScene() {
  return (
    <motion.section
      className="story-stage story-stage--outro"
      {...enter}
      aria-label="PaceTrack: nueva interfaz, el mismo pulso"
    >
      <motion.div
        className="outro-orbit"
        initial={{ scale: 0.45, rotate: -35, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      >
        <TrackGraphic />
      </motion.div>

      <div className="story-safe outro-safe">
        <motion.div
          className="outro-mark"
          initial={{ opacity: 0, y: 22, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ delay: 0.12, duration: 0.48 }}
        >
          <BrandLine />
        </motion.div>
        <div className="outro-copy">
          <motion.p
            className="story-kicker story-kicker--ink"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.24 }}
          >
            NUEVA INTERFAZ
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.54 }}
          >
            MISMO
            <br />
            PULSO.
          </motion.h2>
          <motion.div
            className="outro-cta"
            initial={{ opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.62, type: 'spring', stiffness: 210, damping: 17 }}
          >
            DESCUBRE PACE TRACK <span>↗</span>
          </motion.div>
        </div>
        <div className="outro-footer">
          <span>CRONOMETRAJE DE PRECISIÓN</span>
          <span>FINISH / START</span>
        </div>
      </div>
    </motion.section>
  );
}
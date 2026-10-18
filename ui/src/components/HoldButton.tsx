import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Press and hold to confirm, like the andon cord: one accidental click can never change production.
 * A bar fills while held; releasing early cancels. Space or Enter held on the keyboard works too.
 */
export function HoldButton({ onConfirm, children, className = '', holdMs = 1000, disabled, title, label }: {
  onConfirm: () => void
  children: ReactNode
  className?: string
  holdMs?: number
  disabled?: boolean
  title?: string
  /** accessible name; defaults to the visible text */
  label?: string
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const raf = useRef(0)
  const start = useRef(0)
  const setP = (p: number) => btn.current?.style.setProperty('--p', String(p))
  const cancel = () => { cancelAnimationFrame(raf.current); setP(0) }
  useEffect(() => cancel, [])

  const tick = () => {
    const p = Math.min(1, (performance.now() - start.current) / holdMs)
    setP(p)
    if (p >= 1) { cancel(); onConfirm() } else raf.current = requestAnimationFrame(tick)
  }
  const begin = () => {
    if (disabled) return
    start.current = performance.now()
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(tick)
  }

  return (
    <button
      ref={btn}
      type="button"
      className={`hold ${className}`}
      disabled={disabled}
      title={title}
      aria-label={label}
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin() } }}
      onKeyUp={cancel}
    >
      {children}
    </button>
  )
}

import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

export function ProgressBar({ value, good = false }: { value: number; good?: boolean }): ReactNode {
  return (
    <div className={`bar${good ? ' good' : ''}`}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }): ReactNode {
  return <Loader2 size={size} className="spin" />
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): ReactNode {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)} />
}

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: SegmentOption<T>[]; onChange: (v: T) => void }): ReactNode {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, right }: { label: string; children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="field">
      <div className="row">
        <span className="label grow">{label}</span>
        {right}
      </div>
      {children}
    </div>
  )
}

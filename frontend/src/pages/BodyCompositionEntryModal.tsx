import { useState } from 'react'
import { shanghaiToday } from '../lib/shanghai'
import { upsertBodyComposition, type BodyCompositionScanInput } from '../api'

type SegmentRow = {
  segment: 'left_arm' | 'right_arm' | 'trunk' | 'left_leg' | 'right_leg'
  lean_mass_kg: string
  fat_mass_kg: string
  lean_pct_of_standard: string
  fat_pct_of_standard: string
}

const SEGMENT_KEYS: SegmentRow['segment'][] = ['left_arm', 'right_arm', 'trunk', 'left_leg', 'right_leg']
const SEGMENT_LABELS: Record<SegmentRow['segment'], string> = {
  left_arm: '左臂',
  right_arm: '右臂',
  trunk: '躯干',
  left_leg: '左腿',
  right_leg: '右腿',
}

const makeBlankSegments = (): SegmentRow[] =>
  SEGMENT_KEYS.map((s) => ({
    segment: s,
    lean_mass_kg: '',
    fat_mass_kg: '',
    lean_pct_of_standard: '',
    fat_pct_of_standard: '',
  }))

export default function BodyCompositionEntryModal({
  user,
  existingDates,
  onClose,
  onSaved,
}: {
  user: string
  existingDates: Set<string>
  onClose: () => void
  onSaved: () => void
}) {
  const [scanDate, setScanDate] = useState(shanghaiToday())
  const [weight, setWeight] = useState('')
  const [bf, setBf] = useState('')
  const [smm, setSmm] = useState('')
  const [fatMass, setFatMass] = useState('')
  const [vfl, setVfl] = useState('')
  const [showOptional, setShowOptional] = useState(false)
  const [bmr, setBmr] = useState('')
  const [protein, setProtein] = useState('')
  const [water, setWater] = useState('')
  const [smi, setSmi] = useState('')
  const [inbodyScore, setInbodyScore] = useState('')
  const [showSegments, setShowSegments] = useState(false)
  const [segments, setSegments] = useState<SegmentRow[]>(makeBlankSegments())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function validate(): { ok: true; payload: BodyCompositionScanInput } | { ok: false; message: string } {
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    const required: Array<[string, string, number, number]> = [
      ['weight_kg', weight, 30, 150],
      ['body_fat_pct', bf, 3, 50],
      ['smm_kg', smm, 10, 60],
      ['fat_mass_kg', fatMass, 0, 80],
      ['visceral_fat_level', vfl, 1, 20],
    ]
    for (const [name, raw, lo, hi] of required) {
      const v = num(raw)
      if (v == null || Number.isNaN(v) || v < lo || v > hi) {
        return { ok: false, message: `${name} 必填且需在 [${lo}, ${hi}]` }
      }
    }

    // Segment all-or-none rule
    const segFilled = segments.map(s =>
      s.lean_mass_kg.trim() !== '' || s.fat_mass_kg.trim() !== ''
    )
    const filledCount = segFilled.filter(Boolean).length
    let segmentPayload: BodyCompositionScanInput['segments'] = undefined
    if (filledCount > 0 && filledCount < 5) {
      return { ok: false, message: '节段数据必须 5 个都填，或者全部留空' }
    }
    if (filledCount === 5) {
      segmentPayload = segments.map((s) => {
        const lean = num(s.lean_mass_kg)
        const fat = num(s.fat_mass_kg)
        if (lean == null || fat == null) {
          throw new Error('segment lean/fat must be numeric when filled')
        }
        return {
          segment: s.segment,
          lean_mass_kg: lean,
          fat_mass_kg: fat,
          lean_pct_of_standard: num(s.lean_pct_of_standard),
          fat_pct_of_standard: num(s.fat_pct_of_standard),
        }
      })
    }

    return {
      ok: true,
      payload: {
        scan_date: scanDate,
        weight_kg: num(weight)!,
        body_fat_pct: num(bf)!,
        smm_kg: num(smm)!,
        fat_mass_kg: num(fatMass)!,
        visceral_fat_level: num(vfl)!,
        bmr_kcal: num(bmr),
        protein_kg: num(protein),
        water_l: num(water),
        smi: num(smi),
        inbody_score: num(inbodyScore),
        segments: segmentPayload,
      },
    }
  }

  async function handleSubmit() {
    setError(null)
    const result = validate()
    if (!result.ok) {
      setError(result.message)
      return
    }
    if (existingDates.has(scanDate)) {
      if (!window.confirm(`该日期 ${scanDate} 已有数据，覆盖？`)) return
    }
    setSubmitting(true)
    try {
      await upsertBodyComposition(user, result.payload)
      onSaved()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`提交失败：${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="录入体测数据"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">录入体测数据</h2>
            <p className="text-xs font-mono text-text-muted">Body Composition Manual Entry</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-text-muted hover:text-text-primary text-lg leading-none">×</button>
        </div>

        <div className="space-y-4">
          <Field label="扫描日期" required>
            <input type="date" value={scanDate} onChange={(e) => setScanDate(e.target.value)} className={inputCls} />
          </Field>

          <div>
            <h3 className="text-xs font-mono text-text-muted mb-2">主指标 (必填)</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="体重 (kg)" required>
                <input type="number" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} className={inputCls} />
              </Field>
              <Field label="体脂率 (%)" required>
                <input type="number" step="0.1" value={bf} onChange={(e) => setBf(e.target.value)} className={inputCls} />
              </Field>
              <Field label="骨骼肌量 (kg)" required>
                <input type="number" step="0.1" value={smm} onChange={(e) => setSmm(e.target.value)} className={inputCls} />
              </Field>
              <Field label="脂肪量 (kg)" required>
                <input type="number" step="0.1" value={fatMass} onChange={(e) => setFatMass(e.target.value)} className={inputCls} />
              </Field>
              <Field label="内脏脂肪等级" required>
                <input type="number" step="1" value={vfl} onChange={(e) => setVfl(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </div>

          <details open={showOptional} onToggle={(e) => setShowOptional((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-xs font-mono text-text-muted mb-2">可选指标 (5)</summary>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Field label="BMR (kcal)"><input type="number" value={bmr} onChange={(e) => setBmr(e.target.value)} className={inputCls} /></Field>
              <Field label="蛋白质 (kg)"><input type="number" step="0.1" value={protein} onChange={(e) => setProtein(e.target.value)} className={inputCls} /></Field>
              <Field label="水分 (L)"><input type="number" step="0.1" value={water} onChange={(e) => setWater(e.target.value)} className={inputCls} /></Field>
              <Field label="SMI"><input type="number" step="0.1" value={smi} onChange={(e) => setSmi(e.target.value)} className={inputCls} /></Field>
              <Field label="InBody Score"><input type="number" value={inbodyScore} onChange={(e) => setInbodyScore(e.target.value)} className={inputCls} /></Field>
            </div>
          </details>

          <details open={showSegments} onToggle={(e) => setShowSegments((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-xs font-mono text-text-muted mb-2">节段数据 (5×4，要么全填，要么全空)</summary>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="text-left py-1 px-2 font-medium">节段</th>
                    <th className="text-left py-1 px-2 font-medium">肌肉 kg</th>
                    <th className="text-left py-1 px-2 font-medium">脂肪 kg</th>
                    <th className="text-left py-1 px-2 font-medium">肌肉 % 标准</th>
                    <th className="text-left py-1 px-2 font-medium">脂肪 % 标准</th>
                  </tr>
                </thead>
                <tbody>
                  {segments.map((s, i) => (
                    <tr key={s.segment}>
                      <td className="py-1 px-2">{SEGMENT_LABELS[s.segment]}</td>
                      {(['lean_mass_kg', 'fat_mass_kg', 'lean_pct_of_standard', 'fat_pct_of_standard'] as const).map((field) => (
                        <td key={field} className="py-1 px-2">
                          <input
                            type="number"
                            step="0.1"
                            aria-label={`${SEGMENT_LABELS[s.segment]} ${field}`}
                            value={s[field]}
                            onChange={(e) => {
                              const v = e.target.value
                              setSegments((prev) => prev.map((row, idx) => idx === i ? { ...row, [field]: v } : row))
                            }}
                            className={`${inputCls} text-xs`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {error && (
            <div className="px-3 py-2 rounded-md bg-accent-red/10 border border-accent-red/30 text-xs font-mono text-accent-red">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 text-xs font-mono rounded-md bg-bg-secondary text-text-secondary hover:bg-bg-card-hover">取消</button>
            <button type="button" onClick={handleSubmit} disabled={submitting} className="px-4 py-2 text-xs font-mono rounded-md bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 disabled:opacity-50">
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full px-2 py-1 text-sm bg-bg-secondary border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent-amber'

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-mono text-text-muted mb-1">
        {label}{required && <span className="text-accent-red ml-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}

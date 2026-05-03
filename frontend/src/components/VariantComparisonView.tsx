import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  getPlanVariants,
  overallRating,
  ratePlanVariant,
  selectPlanVariant,
  totalKcalTarget,
  totalRunKm,
  type SelectVariantConflict,
} from '../api'
import type {
  PlanVariant,
  RatingDimension,
  RatingScore,
  VariantsResponse,
} from '../types/plan'
import VariantStatusBadge from './VariantStatusBadge'

interface Props {
  user: string
  folder: string
  initialData?: VariantsResponse
  onChange?: (data: VariantsResponse) => void
}

const DIMENSIONS: { key: RatingDimension; label: string }[] = [
  { key: 'overall', label: '总体' },
  { key: 'suitability', label: '适宜性' },
  { key: 'structure', label: '结构合理性' },
  { key: 'nutrition', label: '营养' },
  { key: 'difficulty', label: '难度匹配' },
]

const DEBOUNCE_MS = 800

/** Multi-variant comparison grid + ratings + select.
 *
 * Layout: CSS grid auto-fit min(280px) — 3 columns on desktop, stacks on
 * mobile. The component owns its own state for the variants response and
 * the per-variant rating drafts; debounces rating writes 800ms before
 * POSTing to /rate.
 */
export default function VariantComparisonView({ user, folder, initialData, onChange }: Props) {
  const [data, setData] = useState<VariantsResponse | null>(initialData ?? null)
  const [showHistorical, setShowHistorical] = useState(false)
  const [busyVariantId, setBusyVariantId] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{ variant: PlanVariant; alreadyPushed: number } | null>(null)

  // Initial load (skipped when initialData is provided).
  useEffect(() => {
    if (initialData) return
    let cancel = false
    getPlanVariants(user, folder, false).then(d => {
      if (!cancel) setData(d)
    }).catch(e => setErrorMsg(`加载 variants 失败: ${e?.message ?? e}`))
    return () => { cancel = true }
  }, [user, folder, initialData])

  const refresh = async (includeSuperseded: boolean) => {
    try {
      const d = await getPlanVariants(user, folder, includeSuperseded)
      setData(d)
      onChange?.(d)
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e)
      setErrorMsg(`加载 variants 失败: ${msg}`)
    }
  }

  const onToggleHistorical = async () => {
    const next = !showHistorical
    setShowHistorical(next)
    await refresh(next)
  }

  // ── Select flow ──
  const tryselect = async (v: PlanVariant, force: boolean) => {
    setBusyVariantId(v.variant_id)
    setErrorMsg(null)
    try {
      const res = await selectPlanVariant(user, folder, v.variant_id, force)
      setConfirmDialog(null)
      const droppedN = res.dropped_scheduled_workout_ids.length
      setErrorMsg(droppedN > 0 ? `已选定 ${v.model_id}; ${droppedN} 条手表训练标为孤儿` : `已选定 ${v.model_id}`)
      await refresh(showHistorical)
    } catch (e: unknown) {
      const err = e as { status?: number; error?: string; already_pushed_count?: number; message?: string }
      const status = err.status
      if (status === 409 && err.error === 'selection_conflict') {
        const conflict = err as SelectVariantConflict
        setConfirmDialog({ variant: v, alreadyPushed: conflict.already_pushed_count ?? 0 })
      } else if (status === 426) {
        setErrorMsg('variant schema 已过期,请重新生成')
      } else {
        setErrorMsg(`选定失败: ${err.message ?? String(e)}`)
      }
    } finally {
      setBusyVariantId(null)
    }
  }

  if (!data) return <div data-testid="variants-loading">加载方案中…</div>

  const active = data.variants.filter(v => !v.superseded_at)
  const superseded = data.variants.filter(v => !!v.superseded_at)

  return (
    <div>
      {errorMsg && (
        <div role="alert" style={{ background: '#fef3c7', color: '#92400e', padding: '8px', marginBottom: '8px' }}>
          {errorMsg}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>本周方案 ({active.length})</h3>
        <button
          type="button"
          onClick={onToggleHistorical}
          data-testid="toggle-historical"
        >
          {showHistorical ? '隐藏历史版本' : '显示历史版本'}
        </button>
      </div>

      <div
        data-testid="variants-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 12,
        }}
      >
        {active.map(v => (
          <VariantCard
            key={v.variant_id}
            variant={v}
            user={user}
            isBusy={busyVariantId === v.variant_id}
            onSelectClick={() => tryselect(v, false)}
            onRated={() => refresh(showHistorical)}
            readOnly={false}
          />
        ))}
      </div>

      {showHistorical && superseded.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h4>历史版本 ({superseded.length})</h4>
          <div
            data-testid="superseded-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 12,
              opacity: 0.6,
            }}
          >
            {superseded.map(v => (
              <VariantCard
                key={v.variant_id}
                variant={v}
                user={user}
                isBusy={false}
                onSelectClick={() => { /* superseded is unselectable */ }}
                onRated={() => { /* read-only ratings */ }}
                readOnly={true}
              />
            ))}
          </div>
        </div>
      )}

      {confirmDialog && (
        <div role="dialog" aria-modal="true" data-testid="select-confirm-dialog" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ background: 'white', padding: 24, borderRadius: 8, maxWidth: 480 }}>
            <h4 style={{ marginTop: 0 }}>确认改选</h4>
            <p>
              改选会丢弃 <strong>{confirmDialog.alreadyPushed}</strong> 条已推送的手表训练映射。
              新计划中匹配的训练需要在 COROS 上手动清理。继续?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmDialog(null)}>取消</button>
              <button
                type="button"
                onClick={() => tryselect(confirmDialog.variant, true)}
                data-testid="confirm-force-select"
                style={{ background: '#dc2626', color: 'white' }}
              >
                确认改选
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── VariantCard (per-column) ─────────────────────────────────────────


interface CardProps {
  variant: PlanVariant
  user: string
  isBusy: boolean
  onSelectClick: () => void
  onRated: () => void
  readOnly: boolean
}

function VariantCard({ variant: v, user, isBusy, onSelectClick, onRated, readOnly }: CardProps) {
  const [showDetails, setShowDetails] = useState(false)
  const [draftRatings, setDraftRatings] = useState(v.ratings)
  const [draftComment, setDraftComment] = useState(v.rating_comment ?? '')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = (next: typeof v.ratings, comment: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        await ratePlanVariant(user, v.variant_id, next, comment || null)
        onRated()
      } catch {
        /* swallow; outer error UI handles surfacing */
      }
    }, DEBOUNCE_MS)
  }

  const setDim = (dim: RatingDimension, score: RatingScore) => {
    const next = { ...draftRatings, [dim]: score }
    setDraftRatings(next)
    flush(next, draftComment)
  }

  const onCommentChange = (s: string) => {
    setDraftComment(s)
    flush(draftRatings, s)
  }

  // Cleanup on unmount.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const overall = overallRating(v)
  const km = totalRunKm(v)
  const kcal = totalKcalTarget(v)
  const sessionByKind = useMemo(() => {
    const m: Record<string, number> = {}
    v.sessions.forEach(s => { m[s.kind] = (m[s.kind] ?? 0) + 1 })
    return m
  }, [v.sessions])

  const longRunM = useMemo(() => {
    return v.sessions
      .filter(s => s.kind === 'run' && typeof s.total_distance_m === 'number')
      .reduce((max, s) => Math.max(max, s.total_distance_m ?? 0), 0)
  }, [v.sessions])

  const selectButtonLabel = v.is_selected ? '已选定 ✓'
    : !v.selectable ? `不可用${v.unselectable_reason ? ` (${v.unselectable_reason})` : ''}`
    : '选定'

  return (
    <div
      data-testid={`variant-card-${v.variant_id}`}
      style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: 12, background: 'white' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{v.model_id}</span>
        <VariantStatusBadge
          status={v.variant_parse_status}
          unselectableReason={v.unselectable_reason}
        />
        {overall !== null && (
          <span title={`总体评分 ${overall}/5`}>{'★'.repeat(overall)}{'☆'.repeat(5 - overall)}</span>
        )}
      </div>

      {!readOnly && (
        <button
          type="button"
          onClick={onSelectClick}
          disabled={v.is_selected || !v.selectable || isBusy}
          data-testid={`select-button-${v.variant_id}`}
          title={v.unselectable_reason ?? ''}
          style={{
            width: '100%', marginBottom: 12,
            background: v.is_selected ? '#dcfce7' : (v.selectable ? '#0ea5e9' : '#e5e7eb'),
            color: v.is_selected ? '#166534' : (v.selectable ? 'white' : '#6b7280'),
            border: 'none', padding: '6px 12px', borderRadius: 4,
            cursor: (v.is_selected || !v.selectable || isBusy) ? 'not-allowed' : 'pointer',
          }}
        >
          {isBusy ? '处理中…' : selectButtonLabel}
        </button>
      )}

      <dl data-testid="variant-stats" style={{ fontSize: 12, margin: 0 }}>
        <div><dt style={{ display: 'inline', color: '#6b7280' }}>周跑量</dt>: <dd style={{ display: 'inline', margin: 0 }}>{km.toFixed(1)} km</dd></div>
        <div><dt style={{ display: 'inline', color: '#6b7280' }}>长跑</dt>: <dd style={{ display: 'inline', margin: 0 }}>{(longRunM / 1000).toFixed(1)} km</dd></div>
        <div><dt style={{ display: 'inline', color: '#6b7280' }}>总热量</dt>: <dd style={{ display: 'inline', margin: 0 }}>{kcal.toLocaleString()} kcal</dd></div>
        <div>
          <dt style={{ display: 'inline', color: '#6b7280' }}>类型</dt>:{' '}
          <dd style={{ display: 'inline', margin: 0 }}>
            {Object.entries(sessionByKind).map(([k, n]) => `${k}×${n}`).join(' / ') || '—'}
          </dd>
        </div>
      </dl>

      <div style={{ marginTop: 12 }}>
        {DIMENSIONS.map(({ key, label }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
            <span style={{ width: 70, color: '#6b7280' }}>{label}</span>
            <input
              type="range"
              min={1}
              max={5}
              value={draftRatings[key] ?? 0}
              disabled={readOnly}
              onChange={e => setDim(key, Number(e.target.value) as RatingScore)}
              data-testid={`rating-slider-${v.variant_id}-${key}`}
            />
            <span style={{ width: 16, textAlign: 'right' }}>{draftRatings[key] ?? '—'}</span>
          </div>
        ))}
        <textarea
          rows={2}
          value={draftComment}
          disabled={readOnly}
          placeholder="评论…"
          onChange={e => onCommentChange(e.target.value)}
          data-testid={`rating-comment-${v.variant_id}`}
          style={{ width: '100%', fontSize: 12, marginTop: 4 }}
        />
      </div>

      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={() => setShowDetails(s => !s)} style={{ fontSize: 12 }}>
          {showDetails ? '收起 markdown' : '展开 markdown'}
        </button>
        {showDetails && (
          <div style={{ marginTop: 8, fontSize: 12, maxHeight: 400, overflow: 'auto', padding: 8, background: '#f9fafb' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{v.content_md}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

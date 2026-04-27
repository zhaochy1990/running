import { useState, type FormEvent } from 'react'
import { postProfile, type ProfileIn, type TargetDistance } from '../../api'

interface FieldError {
  [field: string]: string
}

interface Props {
  onSuccess: (profile: ProfileIn) => void
}

export default function ProfileStep({ onSuccess }: Props) {
  const [displayName, setDisplayName] = useState('')
  const [dob, setDob] = useState('')
  const [sex, setSex] = useState('')
  const [heightCm, setHeightCm] = useState('')
  const [weightKg, setWeightKg] = useState('')
  const [targetRace, setTargetRace] = useState('')
  const [targetDistance, setTargetDistance] = useState<TargetDistance | ''>('')
  const [targetRaceDate, setTargetRaceDate] = useState('')
  const [targetTime, setTargetTime] = useState('')
  const [pb5k, setPb5k] = useState('')
  const [pb10k, setPb10k] = useState('')
  const [pbHm, setPbHm] = useState('')
  const [pbFm, setPbFm] = useState('')
  const [weeklyMileage, setWeeklyMileage] = useState('')
  const [constraints, setConstraints] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldError>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setFieldErrors({})
    setLoading(true)

    const pbs: Record<string, string> = {}
    if (pb5k) pbs['5k'] = pb5k
    if (pb10k) pbs['10k'] = pb10k
    if (pbHm) pbs['hm'] = pbHm
    if (pbFm) pbs['fm'] = pbFm

    if (!targetDistance) {
      setFieldErrors({ target_distance: '请选择目标距离' })
      setLoading(false)
      return
    }

    const profile: ProfileIn = {
      display_name: displayName,
      dob,
      sex,
      height_cm: parseFloat(heightCm),
      weight_kg: parseFloat(weightKg),
      target_race: targetRace,
      target_distance: targetDistance,
      target_race_date: targetRaceDate,
      target_time: targetTime,
      ...(Object.keys(pbs).length > 0 && { pbs }),
      ...(weeklyMileage && { weekly_mileage_km: parseFloat(weeklyMileage) }),
      ...(constraints && { constraints }),
    }

    try {
      const { ok, status, data } = await postProfile(profile)
      if (ok) {
        onSuccess(profile)
      } else if (status === 422) {
        const detail = (data as { detail?: unknown }).detail
        if (Array.isArray(detail)) {
          const errs: FieldError = {}
          for (const item of detail) {
            const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : 'error'
            errs[String(field)] = item.msg || '无效值'
          }
          setFieldErrors(errs)
        } else {
          setError('输入数据有误，请检查各字段')
        }
      } else {
        setError('提交失败，请重试')
      }
    } catch {
      setError('请求失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  const inputCls = (field?: string) =>
    `w-full rounded-lg border px-3 py-2 text-sm text-text-primary bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent-green ${
      field && fieldErrors[field]
        ? 'border-red-500/60 focus:border-red-500'
        : 'border-border-subtle focus:border-accent-green'
    }`

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">完善个人资料</h2>
        <p className="text-sm text-text-muted mt-1">填写基本信息以个性化你的训练计划</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Identity & Body */}
        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">身份与体型</h3>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">显示名称</label>
            <input type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls('display_name')} />
            {fieldErrors.display_name && <p className="text-xs text-red-400 mt-1">{fieldErrors.display_name}</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">出生日期</label>
              <input type="date" required value={dob} onChange={(e) => setDob(e.target.value)} className={inputCls('dob')} />
              {fieldErrors.dob && <p className="text-xs text-red-400 mt-1">{fieldErrors.dob}</p>}
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">性别</label>
              <select required value={sex} onChange={(e) => setSex(e.target.value)} className={inputCls('sex')}>
                <option value="">请选择</option>
                <option value="male">男</option>
                <option value="female">女</option>
              </select>
              {fieldErrors.sex && <p className="text-xs text-red-400 mt-1">{fieldErrors.sex}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">身高 (cm)</label>
              <input type="number" required min="100" max="250" step="0.1" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} className={inputCls('height_cm')} />
              {fieldErrors.height_cm && <p className="text-xs text-red-400 mt-1">{fieldErrors.height_cm}</p>}
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">体重 (kg)</label>
              <input type="number" required min="30" max="300" step="0.1" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className={inputCls('weight_kg')} />
              {fieldErrors.weight_kg && <p className="text-xs text-red-400 mt-1">{fieldErrors.weight_kg}</p>}
            </div>
          </div>
        </section>

        {/* Goal */}
        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">目标赛事</h3>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">目标比赛</label>
            <input type="text" required placeholder="例：上海马拉松 2026" value={targetRace} onChange={(e) => setTargetRace(e.target.value)} className={inputCls('target_race')} />
            {fieldErrors.target_race && <p className="text-xs text-red-400 mt-1">{fieldErrors.target_race}</p>}
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">目标距离</label>
            <select
              required
              value={targetDistance}
              onChange={(e) => setTargetDistance(e.target.value as TargetDistance | '')}
              className={inputCls('target_distance')}
            >
              <option value="">请选择</option>
              <option value="5K">5K</option>
              <option value="10K">10K</option>
              <option value="HM">半马 (HM)</option>
              <option value="FM">全马 (FM)</option>
            </select>
            {fieldErrors.target_distance && <p className="text-xs text-red-400 mt-1">{fieldErrors.target_distance}</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">比赛日期</label>
              <input type="date" required value={targetRaceDate} onChange={(e) => setTargetRaceDate(e.target.value)} className={inputCls('target_race_date')} />
              {fieldErrors.target_race_date && <p className="text-xs text-red-400 mt-1">{fieldErrors.target_race_date}</p>}
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">目标成绩 (H:MM:SS)</label>
              <input type="text" required placeholder="例：3:30:00" value={targetTime} onChange={(e) => setTargetTime(e.target.value)} className={inputCls('target_time')} />
              {fieldErrors.target_time && <p className="text-xs text-red-400 mt-1">{fieldErrors.target_time}</p>}
            </div>
          </div>
        </section>

        {/* Baseline */}
        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">训练基线（选填）</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">5K PB</label>
              <input type="text" placeholder="例：20:30" value={pb5k} onChange={(e) => setPb5k(e.target.value)} className={inputCls()} />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">10K PB</label>
              <input type="text" placeholder="例：42:00" value={pb10k} onChange={(e) => setPb10k(e.target.value)} className={inputCls()} />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">半马 PB</label>
              <input type="text" placeholder="例：1:32:00" value={pbHm} onChange={(e) => setPbHm(e.target.value)} className={inputCls()} />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">全马 PB</label>
              <input type="text" placeholder="例：3:10:00" value={pbFm} onChange={(e) => setPbFm(e.target.value)} className={inputCls()} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">当前周跑量 (km)</label>
            <input type="number" min="0" max="300" step="1" value={weeklyMileage} onChange={(e) => setWeeklyMileage(e.target.value)} className={inputCls()} />
          </div>
        </section>

        {/* Constraints */}
        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">限制条件（选填）</h3>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">伤病 / 注意事项</label>
            <textarea
              rows={3}
              placeholder="例：左膝轻微髌骨疼痛，避免下坡跑"
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green resize-none"
            />
          </div>
        </section>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer"
        >
          {loading ? '保存中...' : '保存并继续'}
        </button>
      </form>
    </div>
  )
}

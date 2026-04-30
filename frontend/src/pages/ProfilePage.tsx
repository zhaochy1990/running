import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { deleteMyAccount, getMyProfile, patchMyProfile, type ProfilePatchIn, type TargetDistance } from '../api'
import { useAuthStore } from '../store/authStore'
import { useUser } from '../UserContextValue'

interface FieldError {
  [field: string]: string
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const { refresh } = useUser()
  const clearSession = useAuthStore((s) => s.clearSession)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldError>({})
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // form fields
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

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        const profile = (p.profile || {}) as Record<string, unknown>
        setDisplayName((p.display_name as string) || (profile.display_name as string) || '')
        setDob((profile.dob as string) || '')
        setSex((profile.sex as string) || '')
        setHeightCm(profile.height_cm != null ? String(profile.height_cm) : '')
        setWeightKg(profile.weight_kg != null ? String(profile.weight_kg) : '')
        setTargetRace((profile.target_race as string) || '')
        setTargetDistance((profile.target_distance as TargetDistance | '') || '')
        setTargetRaceDate((profile.target_race_date as string) || '')
        setTargetTime((profile.target_time as string) || '')
        const pbs = (profile.pbs || {}) as Record<string, string>
        setPb5k(pbs['5K'] || pbs['5k'] || '')
        setPb10k(pbs['10K'] || pbs['10k'] || '')
        setPbHm(pbs['HM'] || pbs['hm'] || '')
        setPbFm(pbs['FM'] || pbs['fm'] || '')
        setWeeklyMileage(profile.weekly_mileage_km != null ? String(profile.weekly_mileage_km) : '')
        setConstraints((profile.constraints as string) || '')
      })
      .catch(() => setError('加载资料失败'))
      .finally(() => setLoading(false))
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    setFieldErrors({})
    setSaving(true)

    const patch: ProfilePatchIn = {}
    if (displayName.trim()) patch.display_name = displayName.trim()
    if (dob) patch.dob = dob
    if (sex) patch.sex = sex
    if (heightCm) patch.height_cm = parseFloat(heightCm)
    if (weightKg) patch.weight_kg = parseFloat(weightKg)
    if (targetRace.trim()) patch.target_race = targetRace.trim()
    if (targetDistance) patch.target_distance = targetDistance
    if (targetRaceDate) patch.target_race_date = targetRaceDate
    if (targetTime) patch.target_time = targetTime
    if (weeklyMileage) patch.weekly_mileage_km = parseFloat(weeklyMileage)
    if (constraints.trim()) patch.constraints = constraints.trim()

    const pbs: Record<string, string> = {}
    if (pb5k) pbs['5K'] = pb5k
    if (pb10k) pbs['10K'] = pb10k
    if (pbHm) pbs['HM'] = pbHm
    if (pbFm) pbs['FM'] = pbFm
    if (Object.keys(pbs).length > 0) patch.pbs = pbs

    try {
      const { ok, status, data } = await patchMyProfile(patch)
      if (ok) {
        setSuccess('已保存')
        await refresh()
        setTimeout(() => setSuccess(''), 2000)
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
        setError(`保存失败 (${status})`)
      }
    } catch {
      setError('请求失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = (field?: string) =>
    `w-full rounded-lg border px-3 py-2 text-sm text-text-primary bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent-green ${
      field && fieldErrors[field]
        ? 'border-red-500/60 focus:border-red-500'
        : 'border-border-subtle focus:border-accent-green'
      }`

  const deletionErrorMessage = (status: number, detail: unknown) => {
    if (status === 409) {
      return '注销失败：你仍然拥有团队。请先到团队页面转让队长或解散团队，然后再注销账号。'
    }
    if (typeof detail === 'string' && detail.trim()) return detail
    if (detail && typeof detail === 'object' && 'message' in detail) {
      const message = (detail as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return message
    }
    return `注销失败 (${status})`
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirm.trim() !== '删除账号' || deleting) return
    setError('')
    setSuccess('')
    setDeleting(true)
    try {
      const { ok, status, data } = await deleteMyAccount()
      if (!ok) {
        setError(deletionErrorMessage(status, data.detail))
        return
      }
      clearSession()
      navigate('/login', { replace: true })
    } catch {
      setError('注销请求失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-20 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
      <button
        onClick={() => navigate(-1)}
        className="text-xs font-mono text-text-muted hover:text-text-secondary mb-4"
      >
        ← 返回
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">个人资料</h1>
        <p className="text-sm font-mono text-text-muted mt-1">更新你的显示名称和训练资料</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-lg bg-accent-green/10 border border-accent-green/30 px-3 py-2 text-sm text-accent-green">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
            身份与体型
          </h3>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              显示名称
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls('display_name')}
              placeholder="队友们看到的名字"
            />
            {fieldErrors.display_name && (
              <p className="text-xs text-red-400 mt-1">{fieldErrors.display_name}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                出生日期
              </label>
              <input
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className={inputCls('dob')}
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                性别
              </label>
              <select value={sex} onChange={(e) => setSex(e.target.value)} className={inputCls('sex')}>
                <option value="">不变</option>
                <option value="male">男</option>
                <option value="female">女</option>
                <option value="other">其他</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                身高 (cm)
              </label>
              <input
                type="number"
                min="100"
                max="250"
                step="0.1"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                className={inputCls('height_cm')}
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                体重 (kg)
              </label>
              <input
                type="number"
                min="30"
                max="300"
                step="0.1"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                className={inputCls('weight_kg')}
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
            目标赛事
          </h3>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              目标比赛
            </label>
            <input
              type="text"
              value={targetRace}
              onChange={(e) => setTargetRace(e.target.value)}
              className={inputCls('target_race')}
              placeholder="例：上海马拉松 2026"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              目标距离
            </label>
            <select
              value={targetDistance}
              onChange={(e) => setTargetDistance(e.target.value as TargetDistance | '')}
              className={inputCls('target_distance')}
            >
              <option value="">不变</option>
              <option value="5K">5K</option>
              <option value="10K">10K</option>
              <option value="HM">半马 (HM)</option>
              <option value="FM">全马 (FM)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                比赛日期
              </label>
              <input
                type="date"
                value={targetRaceDate}
                onChange={(e) => setTargetRaceDate(e.target.value)}
                className={inputCls('target_race_date')}
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                目标成绩 (H:MM:SS)
              </label>
              <input
                type="text"
                value={targetTime}
                onChange={(e) => setTargetTime(e.target.value)}
                className={inputCls('target_time')}
                placeholder="例：3:30:00"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
            训练基线
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                5K PB
              </label>
              <input
                type="text"
                value={pb5k}
                onChange={(e) => setPb5k(e.target.value)}
                className={inputCls()}
                placeholder="例：20:30"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                10K PB
              </label>
              <input
                type="text"
                value={pb10k}
                onChange={(e) => setPb10k(e.target.value)}
                className={inputCls()}
                placeholder="例：42:00"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                半马 PB
              </label>
              <input
                type="text"
                value={pbHm}
                onChange={(e) => setPbHm(e.target.value)}
                className={inputCls()}
                placeholder="例：1:32:00"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                全马 PB
              </label>
              <input
                type="text"
                value={pbFm}
                onChange={(e) => setPbFm(e.target.value)}
                className={inputCls()}
                placeholder="例：3:10:00"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              当前周跑量 (km)
            </label>
            <input
              type="number"
              min="0"
              max="300"
              step="1"
              value={weeklyMileage}
              onChange={(e) => setWeeklyMileage(e.target.value)}
              className={inputCls('weekly_mileage_km')}
            />
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
            限制条件
          </h3>
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              伤病 / 注意事项
            </label>
            <textarea
              rows={3}
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              placeholder="例：左膝轻微髌骨疼痛，避免下坡跑"
              className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green resize-none"
            />
          </div>
        </section>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </form>

      <section className="mt-10 rounded-2xl border border-red-500/30 bg-red-500/5 p-5">
        <h3 className="text-sm font-semibold text-red-400">危险区：注销账号</h3>
        <p className="mt-2 text-sm leading-6 text-text-secondary">
          注销会永久删除你的账号、登录信息、刷新令牌、团队成员关系，以及本地训练数据、手表凭据与配置、个人资料、健康/InBody/能力数据和生成的总结。该操作无法恢复。
        </p>
        <p className="mt-2 text-sm text-text-muted">
          如果你仍然是某个团队的队长，需要先在团队页面转让队长或解散团队。
        </p>
        <label className="mt-4 block text-xs font-mono text-text-muted uppercase tracking-wider">
          输入“删除账号”以确认
        </label>
        <input
          type="text"
          value={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.value)}
          className="mt-2 w-full rounded-lg border border-red-500/30 bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
          placeholder="删除账号"
        />
        <button
          type="button"
          onClick={handleDeleteAccount}
          disabled={deleting || deleteConfirm.trim() !== '删除账号'}
          className="mt-4 w-full rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {deleting ? '正在注销...' : '永久注销账号'}
        </button>
      </section>
    </div>
  )
}

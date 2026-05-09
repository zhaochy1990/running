import { useState, type FormEvent } from 'react'
import { postProfile, type ProfileIn } from '../../api'

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
  const [fieldErrors, setFieldErrors] = useState<FieldError>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setFieldErrors({})
    setLoading(true)

    const profile: ProfileIn = {
      display_name: displayName,
      dob,
      sex,
      height_cm: parseFloat(heightCm),
      weight_kg: parseFloat(weightKg),
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
        <p className="text-sm text-text-muted mt-1">填写基本信息，比赛目标稍后在训练计划中设置</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
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

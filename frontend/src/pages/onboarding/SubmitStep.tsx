import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postOnboardingComplete, getSyncStatus, type ProfileIn } from '../../api'

interface Props {
  profile: ProfileIn
}

export default function SubmitStep({ profile }: Props) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const MAX_POLL_ATTEMPTS = 200 // 200 * 3s = 10 min

  const pollSyncStatus = (attempt = 0) => {
    getSyncStatus()
      .then((status) => {
        if (status.state === 'done') {
          navigate('/health')
        } else if (status.state === 'error') {
          setError(status.error || '同步出错，请重试')
          setLoading(false)
        } else {
          // still running — poll again
          if (attempt < MAX_POLL_ATTEMPTS) {
            setTimeout(() => pollSyncStatus(attempt + 1), 3000)
          } else {
            setError('同步超时，请刷新页面查看状态')
            setLoading(false)
          }
        }
      })
      .catch(() => {
        if (attempt < MAX_POLL_ATTEMPTS) {
          setTimeout(() => pollSyncStatus(attempt + 1), 3000)
        } else {
          setError('无法获取同步状态，请刷新页面')
          setLoading(false)
        }
      })
  }

  const handleSubmit = async () => {
    setError('')
    setLoading(true)
    try {
      const { data } = await postOnboardingComplete()
      if ((data as { state?: string }).state === 'already-complete') {
        navigate('/')
        return
      }
      // Poll for sync to finish, then navigate to /health (身体指标) when done.
      pollSyncStatus()
    } catch {
      setError('请求失败，请重试')
      setLoading(false)
    }
  }

  const handleRetry = () => {
    setError('')
    handleSubmit()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">确认并提交</h2>
        <p className="text-sm text-text-muted mt-1">确认以下信息后开始初始化你的训练仪表盘</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={handleRetry}
            className="text-xs font-medium text-red-400 underline underline-offset-2 hover:text-red-300 shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {/* Summary card */}
      <div className="bg-bg-base rounded-xl border border-border-subtle p-4 space-y-3 text-sm">
        <Row label="显示名称" value={profile.display_name} />
        <Row label="出生日期" value={profile.dob} />
        <Row label="性别" value={profile.sex === 'male' ? '男' : '女'} />
        <Row label="身高" value={`${profile.height_cm} cm`} />
        <Row label="体重" value={`${profile.weight_kg} kg`} />
        <div className="border-t border-border-subtle pt-3 space-y-3">
          <Row label="目标比赛" value={profile.target_race} />
          <Row label="目标距离" value={profile.target_distance} />
          <Row label="比赛日期" value={profile.target_race_date} />
          <Row label="目标成绩" value={profile.target_time} />
        </div>
        {profile.weekly_mileage_km != null && (
          <div className="border-t border-border-subtle pt-3">
            <Row label="周跑量" value={`${profile.weekly_mileage_km} km`} />
          </div>
        )}
        {profile.pbs && Object.keys(profile.pbs).length > 0 && (
          <div className="border-t border-border-subtle pt-3 space-y-3">
            {Object.entries(profile.pbs).map(([dist, time]) => (
              <Row key={dist} label={`${dist.toUpperCase()} PB`} value={time} />
            ))}
          </div>
        )}
        {profile.constraints && (
          <div className="border-t border-border-subtle pt-3">
            <Row label="限制条件" value={profile.constraints} />
          </div>
        )}
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <span className="w-4 h-4 border-2 border-bg-base/30 border-t-bg-base rounded-full animate-spin" />
            正在初始化...
          </>
        ) : (
          '开始使用 STRIDE'
        )}
      </button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-xs font-mono text-text-muted uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-text-primary text-right">{value}</span>
    </div>
  )
}

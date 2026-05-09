import { useNavigate, useSearchParams } from 'react-router-dom'
import ProfilePage from './ProfilePage'
import WatchPage from './WatchPage'

type Tab = 'profile' | 'watch'

export default function UserCenterPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const rawTab = searchParams.get('tab')
  const activeTab: Tab = rawTab === 'watch' ? 'watch' : 'profile'

  const switchTab = (tab: Tab) => {
    setSearchParams(tab === 'profile' ? {} : { tab })
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'profile', label: '个人资料' },
    { key: 'watch', label: '手表管理' },
  ]

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
      <button
        onClick={() => { window.history.length > 1 ? navigate(-1) : navigate('/') }}
        className="text-xs font-mono text-text-muted hover:text-text-secondary mb-4"
      >
        &larr; 返回
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">用户中心</h1>
        <p className="text-sm font-mono text-text-muted mt-1">管理你的个人资料和手表绑定</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => switchTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === tab.key
                ? 'text-accent-green'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-green rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'profile' ? (
        <ProfilePage embedded />
      ) : (
        <WatchPage embedded />
      )}
    </div>
  )
}

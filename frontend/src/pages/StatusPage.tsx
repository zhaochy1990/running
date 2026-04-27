import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getMyStatus, postOnboardingComplete } from '../api'

type PageState = 'loading' | 'loaded' | 'empty' | 'error' | 'generating'

export default function StatusPage() {
  const [state, setState] = useState<PageState>('loading')
  const [markdown, setMarkdown] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const load = () => {
    setState('loading')
    getMyStatus()
      .then((data) => {
        setMarkdown(data.markdown)
        setState('loaded')
      })
      .catch((err: Error) => {
        if (err.message.includes('404')) {
          setState('empty')
        } else {
          setErrorMsg('加载失败，请重试')
          setState('error')
        }
      })
  }

  useEffect(() => {
    load()
  }, [])

  const handleGenerate = () => {
    setState('generating')
    postOnboardingComplete()
      .then(() => {
        // Poll until status.md is ready (up to ~30s)
        let attempts = 0
        const poll = () => {
          getMyStatus()
            .then((data) => {
              setMarkdown(data.markdown)
              setState('loaded')
            })
            .catch(() => {
              attempts++
              if (attempts < 10) {
                setTimeout(poll, 3000)
              } else {
                setErrorMsg('生成超时，请稍后刷新页面')
                setState('error')
              }
            })
        }
        setTimeout(poll, 2000)
      })
      .catch(() => {
        setErrorMsg('生成请求失败，请重试')
        setState('error')
      })
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">Current Status</h1>
        <p className="text-sm text-text-muted mt-1">你的训练状态快照</p>
      </div>

      {state === 'loading' && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
        </div>
      )}

      {state === 'generating' && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
          <p className="text-sm text-text-muted">正在生成状态报告...</p>
        </div>
      )}

      {state === 'error' && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400 flex items-center justify-between gap-3">
          <span>{errorMsg}</span>
          <button onClick={load} className="text-xs font-medium underline underline-offset-2 hover:text-red-300 shrink-0">
            重试
          </button>
        </div>
      )}

      {state === 'empty' && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-10 flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 rounded-full bg-accent-green/10 flex items-center justify-center">
            <span className="text-accent-green text-xl font-bold font-mono">?</span>
          </div>
          <div>
            <p className="text-text-primary font-medium">状态报告尚未生成</p>
            <p className="text-sm text-text-muted mt-1">完成初始同步后将自动生成；或点击下方手动触发</p>
          </div>
          <button
            onClick={handleGenerate}
            className="rounded-lg bg-accent-green/90 px-5 py-2 text-sm font-medium text-bg-base hover:bg-accent-green transition-colors cursor-pointer"
          >
            Generate now
          </button>
        </div>
      )}

      {state === 'loaded' && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-6">
          <div className="prose max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

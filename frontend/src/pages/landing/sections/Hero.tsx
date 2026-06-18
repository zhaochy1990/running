import { useReveal, useCountUp } from '../useReveal'

// Hero mini-bars heights (deterministic)
const HERO_BAR_HEIGHTS = [44, 60, 52, 78, 66, 90, 72, 84, 58, 96, 70, 82]

export default function Hero({ onLogin }: { onLogin: () => void }) {
  const cardRef = useReveal<HTMLDivElement>()
  const mileage = useCountUp(58.4, { suffix: ' km' })
  const load = useCountUp(412)

  return (
    <header className="hero" id="top">
      <div className="hero-in wrap">
        <div>
          <span className="hero-badge"><span className="dot"></span>系统 · 全面 · 为你而生</span>
          <h1>每一步都有数据<br /><span className="grad">每一份计划都属于你</span></h1>
          <p className="lede">STRIDE 把<b>跑步、力量、饮食</b>拧成一套完整系统,读懂你的身体、<b>为你量身定制</b>——系统、全面、只属于你。每一天,都在把你练成<b>更强的自己</b>。</p>
          <div className="hero-actions">
            <button type="button" className="big-cta" onClick={onLogin}>免费开始训练
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
            </button>
            <a className="ghost-cta" href="#reverse">看看怎么倒推 ↓</a>
          </div>
        </div>

        {/* live device card */}
        <div className="hero-card reveal" ref={cardRef}>
          <div className="hc-top">
            <span className="tag">本周概览 · W12</span>
            <span className="live">同步中</span>
          </div>
          <div className="hc-metrics">
            <div className="hc-m"><div className="l">本周里程</div><div className="v green">{mileage}</div></div>
            <div className="hc-m"><div className="l">平均配速</div><div className="v">4'38<span className="u">/km</span></div></div>
            <div className="hc-m"><div className="l">训练负荷</div><div className="v">{load}</div></div>
          </div>
          <div className="hc-chart">
            <div className="ct"><span>配速曲线 · 今日</span><span>10 KM</span></div>
            <svg viewBox="0 0 320 96" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="sg" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#0097a7"></stop>
                  <stop offset="1" stopColor="#3ee08a"></stop>
                </linearGradient>
                <linearGradient id="sf" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="rgba(62,224,138,.28)"></stop>
                  <stop offset="1" stopColor="rgba(62,224,138,0)"></stop>
                </linearGradient>
              </defs>
              <path className="sparkfill" fill="url(#sf)" d="M0,70 C40,68 56,40 96,44 C140,48 156,22 196,30 C240,38 256,58 320,50 L320,96 L0,96 Z"></path>
              <path className="spark" d="M0,70 C40,68 56,40 96,44 C140,48 156,22 196,30 C240,38 256,58 320,50"></path>
            </svg>
            <div className="hc-bars">
              {HERO_BAR_HEIGHTS.map((h, i) => (
                <span
                  key={i}
                  style={{ height: `${h}%`, animationDelay: `${2 + i * 0.05}s` }}
                ></span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

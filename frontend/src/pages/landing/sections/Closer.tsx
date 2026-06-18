export default function Closer({ onLogin }: { onLogin: () => void }) {
  return (
    <section className="closer">
      <div className="wrap">
        <span className="eyebrow">开始你的下一个周期</span>
        <h2>Every stride, measured.<br /><em>Every plan, yours.</em></h2>
        <p>设定一场目标赛事,STRIDE 从比赛日倒推出你的无伤 PB 之路——跑步、力量、饮食,一套系统全包，个性化专为你设计。</p>
        <button type="button" className="big-cta" onClick={onLogin}>免费开始训练
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6"></path>
          </svg>
        </button>
        <div className="sub-note">2 分钟接入手表数据</div>
      </div>
    </section>
  )
}

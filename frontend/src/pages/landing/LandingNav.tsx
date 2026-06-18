export default function LandingNav({ onLogin }: { onLogin: () => void }) {
  return (
    <nav className="nav">
      <div className="nav-in">
        <a className="brand" href="#top">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">STRIDE</div>
            <div className="brand-sub">训练中心</div>
          </div>
        </a>
        <div className="nav-links">
          <a href="#reverse">目标驱动</a>
          <a href="#pillars">三维训练</a>
          <a href="#data">训练数据</a>
        </div>
        <div className="nav-spacer"></div>
        <button type="button" className="btn-login" onClick={onLogin}>登录</button>
        <button type="button" className="btn-cta" onClick={onLogin}>开始训练
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
        </button>
      </div>
    </nav>
  )
}

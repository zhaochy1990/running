export default function LandingFooter({ onLogin }: { onLogin: () => void }) {
  return (
    <footer>
      <div className="wrap">
        <div className="foot-grid">
          <div className="foot-brand">
            <a className="brand" href="#top">
              <div className="brand-mark">S</div>
              <div><div className="brand-name">STRIDE</div><div className="brand-sub">训练中心</div></div>
            </a>
            <p>以目标赛事为导向,从比赛日倒推。跑步、力量、饮食,一套系统,助你无伤 PB。</p>
          </div>
          <div className="foot-col">
            <h4>产品</h4>
            <a href="#reverse">STRIDE Coach Agent</a>
            <a href="#pillars">STRIDE Training Load</a>
            <a href="#features">STRIDE Performance Evaluator</a>
          </div>
          <div className="foot-col">
            <h4>资源</h4>
            <a href="#">训练指南</a>
            <a href="#">设备接入</a>
            <a href="#">帮助中心</a>
            <a href="#">更新日志</a>
          </div>
          <div className="foot-col">
            <h4>账户</h4>
            <button type="button" onClick={onLogin} style={{ display: 'block', fontSize: '13px', color: '#aeb3c4', marginBottom: '10px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>登录</button>
            <button type="button" onClick={onLogin} style={{ display: 'block', fontSize: '13px', color: '#aeb3c4', marginBottom: '10px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>创建档案</button>
            <a href="#">订阅方案</a>
            <a href="#">联系我们</a>
          </div>
        </div>
        <div className="foot-bottom">
          <span>STRIDE © 2026 · BUILT FOR RUNNERS</span>
          <span>隐私 · 条款 · Cookie</span>
        </div>
      </div>
    </footer>
  )
}

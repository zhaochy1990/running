import { useReveal } from '../useReveal'

export default function Features() {
  const secHeadRef = useReveal<HTMLDivElement>()
  const feat1Ref = useReveal<HTMLDivElement>()
  const feat2Ref = useReveal<HTMLDivElement>()
  const feat3Ref = useReveal<HTMLDivElement>()

  return (
    <section id="features">
      <div className="wrap">
        <div className="sec-head reveal" ref={secHeadRef}>
          <div className="eyebrow">驱动这套系统的引擎</div>
          <h2>个性化训练方案</h2>
          <p>排好的周期不是一成不变的死计划。STRIDE 每天读你的状态,把宏观周期落实成今天该做的事。</p>
        </div>
        <div className="feat-grid">
          <div className="feat reveal" ref={feat1Ref}>
            <span className="fnum">01</span>
            <div className="ficon">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4"></path>
                <circle cx="12" cy="12" r="3.2"></circle>
              </svg>
            </div>
            <h3>每日自适应调整</h3>
            <p>恢复不足就退阶,状态正好就加量。每天根据负荷与睡眠重算今天的训练,把伤病风险扼杀在前一晚。</p>
            <span className="meta">每日重算 · 永不照本宣科</span>
          </div>
          <div className="feat reveal" ref={feat2Ref}>
            <span className="fnum">02</span>
            <div className="ficon">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <h3>AI 教练对话</h3>
            <p>"今天跑完小腿有点紧,明天强度课该照常跑吗?"——直接问。教练读得懂你的训练历史,给的是建议,不是模板。</p>
            <span className="meta">懂你的历史 · 随时可问</span>
          </div>
          <div className="feat reveal" ref={feat3Ref}>
            <span className="fnum">03</span>
            <div className="ficon">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18"></path>
                <path d="M7 14l3-4 3 3 4-7"></path>
              </svg>
            </div>
            <h3>成果分析</h3>
            <p>VO₂max 趋势、配速进步、训练负荷平衡——把几个月的数据折成一眼能看懂的曲线,知道自己到底有没有变强。</p>
            <span className="meta">VO₂ · 负荷 · 配速进步</span>
          </div>
        </div>
      </div>
    </section>
  )
}

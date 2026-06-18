import { useReveal } from '../useReveal'

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5"></path>
  </svg>
)

export default function Pillars() {
  const secHeadRef = useReveal<HTMLDivElement>()
  const pillar1Ref = useReveal<HTMLDivElement>()
  const pillar2Ref = useReveal<HTMLDivElement>()
  const pillar3Ref = useReveal<HTMLDivElement>()
  const synthRef = useReveal<HTMLDivElement>()

  return (
    <section className="pillars" id="pillars">
      <div className="wrap">
        <div className="sec-head reveal" ref={secHeadRef}>
          <div className="eyebrow">系统性训练 · 三位一体</div>
          <h2>跑得快,是练出来的整体结果</h2>
          <p>无脑堆跑量枯燥而且会撞上瓶颈,负荷控制不好还容易受伤。STRIDE 把跑步、力量、饮食编进同一份计划,三个维度一起推进——这才是"系统性地变强"。</p>
        </div>

        <div className="pillar-grid">
          <div className="pillar reveal" ref={pillar1Ref}>
            <div className="ptop"></div>
            <div className="picon">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="13.5" cy="4" r="2"></circle>
                <path d="M11.5 6.2 9 11.5l3.4 2.1L13.5 20"></path>
                <path d="M9 11.5 5.5 13l-1 4.5"></path>
                <path d="M13 13.6 17.5 12"></path>
              </svg>
            </div>
            <div className="pcap">Run</div>
            <h3>跑步</h3>
            <p>周期化的跑量与强度分配,把每一次轻松跑、节奏跑、间歇都放在该出现的位置。</p>
            <ul>
              <li><CheckIcon />周期化跑量与长距离</li>
              <li><CheckIcon />配速分区 · 间歇 / 节奏跑</li>
              <li><CheckIcon />根据训练反馈灵活调整</li>
            </ul>
          </div>

          <div className="pillar reveal" ref={pillar2Ref}>
            <div className="ptop"></div>
            <div className="picon">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6.5 6.5 11 11"></path>
                <path d="m21 21-1.5-1.5"></path>
                <path d="m3 3 1.5 1.5"></path>
                <path d="m18 22 4-4"></path>
                <path d="m2 6 4-4"></path>
                <path d="m3 10 7-7"></path>
                <path d="m14 21 7-7"></path>
              </svg>
            </div>
            <div className="pcap">Strength</div>
            <h3>力量</h3>
            <p>跑者专项力量与稳定性训练,我们始终认为应该通过力量训练来增强跑步能力,把受伤的概率压到最低。</p>
            <ul>
              <li><CheckIcon />根据你的目标制定跑者专项力量训练</li>
              <li><CheckIcon />根据你的伤病史调整训练动作，降低伤病风险</li>
              <li><CheckIcon />不同备赛周期训练重点不同</li>
            </ul>
          </div>

          <div className="pillar reveal" ref={pillar3Ref}>
            <div className="ptop"></div>
            <div className="picon">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"></path>
                <path d="M10 2c1 .5 2 2 2 5"></path>
              </svg>
            </div>
            <div className="pcap">Nutrition</div>
            <h3>饮食</h3>
            <p>跟着训练负荷走的营养与补给建议,练得动、恢复得快,把吃进去的每一口都用在刀刃上。</p>
            <ul>
              <li><CheckIcon />按负荷配比碳水 / 蛋白</li>
              <li><CheckIcon />赛前储备与补给方案</li>
              <li><CheckIcon />日常恢复营养建议</li>
            </ul>
          </div>
        </div>

        <div className="synth reveal" ref={synthRef}>
          <div className="synth-eq">
            <span className="node">跑步</span><span className="op">+</span>
            <span className="node">力量</span><span className="op">+</span>
            <span className="node">饮食</span><span className="op">=</span>
            <span className="res">整体变强 · 无伤 PB</span>
          </div>
          <div className="synth-note">三个维度,一套系统。<b>系统性地把你练得更强、更稳、更耐练</b>——这才是 STRIDE 把你带到 PB 的方式。</div>
        </div>
      </div>
    </section>
  )
}

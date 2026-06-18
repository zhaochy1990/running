import { useReveal } from '../useReveal'

// 26-week mileage curve (periodized base→speed→marathon→peak→taper→race)
const WEEK_KM = [38, 42, 46, 35, 48, 52, 42, 50, 54, 44, 56, 58, 48, 60, 64, 52, 66, 68, 56, 70, 72, 60, 68, 44, 30, 42.2]
const MAX_KM = 78

function weekPhase(i: number): string {
  if (i <= 6)  return 'base'
  if (i <= 12) return 'speed'
  if (i <= 18) return 'marathon'
  if (i <= 22) return 'peak'
  if (i <= 24) return 'taper'
  return 'race'
}

export default function ReversePlan() {
  const secHeadRef = useReveal<HTMLDivElement>()
  const revCardRef = useReveal<HTMLDivElement>()
  const mileageRef = useReveal<HTMLDivElement>()

  return (
    <section className="reverse" id="reverse">
      <div className="wrap">
        <div className="sec-head reveal" ref={secHeadRef}>
          <div className="eyebrow">以目标赛事为导向</div>
          <h2>从比赛日倒推,精准规划每一步</h2>
          <p>我们认为周期化,才是系统性变强的底层逻辑。定下你的目标赛事和成绩,STRIDE帮你生成系统性、周期化的训练计划，分几个阶段，每个阶段该练什么、练到什么程度,都帮你精确地安排在抵达终点的路上。</p>
        </div>

        <div className="rev-card reveal" ref={revCardRef}>
          <div className="rev-head">
            <div className="rev-goal">
              <span className="gk">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3ee08a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"></circle>
                  <circle cx="12" cy="12" r="4.5"></circle>
                  <circle cx="12" cy="12" r="0.5" fill="#3ee08a"></circle>
                </svg>
                目标赛事
              </span>
              <div className="gv">西安马拉松（2026夏训） · <em>目标 3:30:00</em></div>
            </div>
            <div className="rev-goalmeta">
              <div className="m"><div className="v g">26<span style={{ fontSize: '11px', color: '#7a8092' }}>周</span></div><div className="l">距离比赛</div></div>
              <div className="m"><div className="v">10/18</div><div className="l">比赛日</div></div>
              <div className="m"><div className="v">42.2<span style={{ fontSize: '11px', color: '#7a8092' }}>K</span></div><div className="l">距离</div></div>
            </div>
          </div>

          <div className="rev-chart-head">
            <div>
              <div className="rch-t">26 周周量曲线</div>
              <div className="rch-sub">从今天到比赛日,每周的训练计划STRIDE都替你算好——基础打底,速度提速,专项拉满,巅峰收尾。</div>
            </div>
            <div className="rch-peak">峰值 <b>72</b><span>km</span> · W21 · 巅峰期</div>
          </div>

          <div className="rev-mileage" ref={mileageRef}>
            {WEEK_KM.map((v, i) => {
              const h = ((v / MAX_KM) * 100).toFixed(1)
              const phase = weekPhase(i)
              return (
                <div
                  key={i}
                  className={`mb ${phase}`}
                  style={{ height: `${h}%` }}
                  title={`W${String(i + 1).padStart(2, '0')} · ${v} km`}
                >
                  {i === 20 && <span className="mb-tag">72km</span>}
                  {i === 25 && <span className="mb-tag race">PB</span>}
                </div>
              )
            })}
          </div>

          <div className="rev-axis">
            <span>W01 · 起点</span><span>W08</span><span>W14</span><span>W20</span><span>赛事 · 10/18</span>
          </div>

          <div className="rev-legend">
            <span><i className="sw base"></i>基础期 · 7周</span>
            <span><i className="sw speed"></i>速度训练 · 6周</span>
            <span><i className="sw marathon"></i>马拉松专项 · 6周</span>
            <span><i className="sw peak"></i>巅峰期 · 4周</span>
            <span><i className="sw taper"></i>减量期 · 2周</span>
            <span><i className="sw race"></i>比赛周</span>
          </div>

          <div className="rev-foot">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              <path d="M22 4 12 14.01l-3-3"></path>
            </svg>
            <span>赛事变了、状态变了,整条时间轴会<b>自动重排</b>——你永远走在通往终点的最优路径上。</span>
          </div>
        </div>
      </div>
    </section>
  )
}

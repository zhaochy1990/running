import { useReveal } from '../useReveal'

// Weekly mileage bars data
const WEEK_DATA = [
  { km: 38, day: 'W6' },
  { km: 45, day: 'W7' },
  { km: 42, day: 'W8' },
  { km: 52, day: 'W9' },
  { km: 48, day: 'W10' },
  { km: 58, day: 'W11', peak: true },
  { km: 54, day: 'W12' },
]
const WEEK_MAX = 60

// Load rings data
const RINGS_DATA = [
  { label: '强度', value: 72, sub: '阈值跑 ·1次', color: '#00a85a' },
  { label: '有氧', value: 88, sub: '轻松跑 ·4次', color: '#0097a7' },
  { label: '恢复', value: 64, sub: '休息 ·2天', color: '#e68a00' },
]
const RING_CIRCUMFERENCE = 2 * Math.PI * 30

export default function DataShowcase() {
  const secHeadRef = useReveal<HTMLDivElement>()
  const panel1Ref = useReveal<HTMLDivElement>()
  const panel2Ref = useReveal<HTMLDivElement>()
  const panel3Ref = useReveal<HTMLDivElement>()
  const panel4Ref = useReveal<HTMLDivElement>()

  return (
    <section className="showcase" id="data">
      <div className="wrap">
        <div className="sec-head reveal" ref={secHeadRef}>
          <div className="eyebrow">训练数据 · 成果展示</div>
          <h2>你的训练,一屏看懂</h2>
          <p>这是 STRIDE 仪表盘的示例视图——里程、配速、负荷、分段,全都用同一套语言说话。</p>
        </div>

        <div className="show-grid">
          {/* Weekly mileage bars */}
          <div className="panel reveal" ref={panel1Ref}>
            <div className="panel-head">
              <div><div className="pt">周里程趋势</div><div className="ph" style={{ marginTop: '3px' }}>最近 7 周 · 公里</div></div>
              <span className="pill">↑ 周环比 +6%</span>
            </div>
            <div className="week-bars">
              {WEEK_DATA.map((w, i) => (
                <div key={i} className={`wb${w.peak ? ' peak' : ''}`}>
                  <div className="km">{w.km}</div>
                  <div className="col">
                    <div
                      className="fill"
                      style={{ transform: `scaleY(${(w.km / WEEK_MAX).toFixed(3)})` }}
                    ></div>
                  </div>
                  <div className="d">{w.day}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Pace progression */}
          <div className="panel reveal" ref={panel2Ref}>
            <div className="panel-head">
              <div><div className="pt">平均配速进步</div><div className="ph" style={{ marginTop: '3px' }}>10K 配速 · 越低越好</div></div>
              <span className="pill">−14"/km</span>
            </div>
            <div className="pace-wrap">
              <svg viewBox="0 0 480 158" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="pa" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="rgba(0,168,90,.18)"></stop>
                    <stop offset="1" stopColor="rgba(0,168,90,0)"></stop>
                  </linearGradient>
                </defs>
                <path className="pace-area" d="M0,40 L80,52 L160,46 L240,78 L320,92 L400,108 L480,124 L480,158 L0,158 Z"></path>
                <path className="pace-line" d="M0,40 L80,52 L160,46 L240,78 L320,92 L400,108 L480,124"></path>
                <circle className="pace-pt" cx="0" cy="40" r="3.4"></circle>
                <circle className="pace-pt" cx="80" cy="52" r="3.4"></circle>
                <circle className="pace-pt" cx="160" cy="46" r="3.4"></circle>
                <circle className="pace-pt" cx="240" cy="78" r="3.4"></circle>
                <circle className="pace-pt" cx="320" cy="92" r="3.4"></circle>
                <circle className="pace-pt" cx="400" cy="108" r="3.4"></circle>
                <circle className="pace-pt" cx="480" cy="124" r="3.4"></circle>
              </svg>
              <div className="pace-labels"><span>3月</span><span>4月</span><span>5月</span><span>6月</span></div>
            </div>
          </div>

          {/* Load rings */}
          <div className="panel reveal" ref={panel3Ref}>
            <div className="panel-head">
              <div><div className="pt">本周负荷平衡</div><div className="ph" style={{ marginTop: '3px' }}>强度 / 有氧 / 恢复</div></div>
              <span className="pill">平衡良好</span>
            </div>
            <div className="rings">
              {RINGS_DATA.map((r, i) => {
                const off = RING_CIRCUMFERENCE * (1 - r.value / 100)
                return (
                  <div key={i} className="ring">
                    <svg viewBox="0 0 84 84">
                      <circle cx="42" cy="42" r="30" fill="none" stroke="#e8eaf0" strokeWidth="7" />
                      <circle
                        className="rprog"
                        cx="42"
                        cy="42"
                        r="30"
                        fill="none"
                        stroke={r.color}
                        strokeWidth="7"
                        strokeLinecap="round"
                        strokeDasharray={String(RING_CIRCUMFERENCE)}
                        strokeDashoffset={String(off)}
                      />
                      <text x="42" y="46" textAnchor="middle" className="rv" transform="rotate(90 42 42)">{r.value}%</text>
                    </svg>
                    <div className="rl">{r.label}</div>
                    <div className="rs">{r.sub}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Split table */}
          <div className="panel reveal" ref={panel4Ref}>
            <div className="panel-head">
              <div><div className="pt">长距离分段</div><div className="ph" style={{ marginTop: '3px' }}>周日 · 21.1 KM</div></div>
              <span className="pill">负分段达成</span>
            </div>
            <table className="splits">
              <thead>
                <tr>
                  <th>KM</th>
                  <th className="barcell">配速</th>
                  <th className="r">用时</th>
                  <th className="r">心率</th>
                </tr>
              </thead>
              <tbody>
                <tr><td className="km">1–5</td><td className="barcell"><div className="minib" style={{ width: '70%' }}></div></td><td className="r">4'52"</td><td className="r">148</td></tr>
                <tr><td className="km">6–10</td><td className="barcell"><div className="minib" style={{ width: '78%' }}></div></td><td className="r">4'45"</td><td className="r">154</td></tr>
                <tr><td className="km">11–15</td><td className="barcell"><div className="minib" style={{ width: '86%' }}></div></td><td className="r">4'38"</td><td className="r">161</td></tr>
                <tr><td className="km">16–21</td><td className="barcell"><div className="minib" style={{ width: '96%' }}></div></td><td className="r">4'29"</td><td className="r">168</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}

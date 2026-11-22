import type { RunningDynamics, RunningDynamicsKey, RunningDynamicsMetric } from '../../../types/activity';
import { drawDynamicsChart, dynamicsTime, dynamicsWindowAt, type DynamicsChart } from './chart';

const metrics = [
  { key: 'cadence', label: '步频', unit: '步/分', digits: 0 },
  { key: 'stride_length', label: '步幅', unit: '米/步', digits: 2 },
  { key: 'vertical_oscillation', label: '垂直振幅', unit: '厘米', digits: 1 },
  { key: 'ground_contact_time', label: '触地时间', unit: '毫秒', digits: 0 },
] satisfies Array<{ key: RunningDynamicsKey; label: string; unit: string; digits: number }>;

type Metric = (typeof metrics)[number] & { values: RunningDynamicsMetric };
type Contact = WechatMiniprogram.TouchCanvasDetail;
type Gesture = { start: Contact; direction: 'pending' | 'horizontal' | 'vertical' };
type ChartState = {
  summary: RunningDynamics;
  metrics: Metric[];
  charts: DynamicsChart[];
  selected: number | null;
  gesture: Gesture | null;
};

const components = new WeakMap<object, ChartState>();

function cardsFor(state: ChartState) {
  return state.metrics.map(({ key, label, unit, digits, values }) => {
    const range = state.selected === null ? values : values.windows.find(window => window.index === state.selected);
    return {
      key, label, unit,
      average: values.average.toFixed(digits),
      range: range ? `${range.min.toFixed(digits)}–${range.max.toFixed(digits)}` : '—',
    };
  });
}

Component({
  properties: {
    summary: { type: Object, value: null as RunningDynamics | null },
  },
  data: { cards: [] as ReturnType<typeof cardsFor>, timeLabel: '全程范围', showHelp: false },
  observers: {
    summary(summary: RunningDynamics | null) {
      if (components.has(this)) this.initialize(summary);
    },
  },
  lifetimes: {
    ready() {
      this.initialize(this.data.summary);
    },
    detached() {
      components.delete(this);
    },
  },
  methods: {
    initialize(summary: RunningDynamics | null) {
      if (!summary) return;
      const available = metrics.flatMap(metric => {
        const values = summary.metrics[metric.key];
        return values?.windows.length ? [{ ...metric, values }] : [];
      });
      const state: ChartState = { summary, metrics: available, charts: [], selected: null, gesture: null };
      components.set(this, state);
      this.setData({ cards: cardsFor(state), timeLabel: '全程范围', showHelp: false }, () => {
        this.createSelectorQuery().selectAll('.dynamics-chart').fields({ node: true, size: true }).exec(([nodes]) => {
          if (components.get(this) !== state || nodes?.length !== available.length) return;
          const dpr = wx.getWindowInfo().pixelRatio || 1;
          for (const { node, width, height } of nodes) {
            if (!node || !width || !height) return;
          }
          state.charts = nodes.map(({ node, width, height }: { node: WechatMiniprogram.Canvas; width: number; height: number }) => {
            node.width = Math.round(width * dpr);
            node.height = Math.round(height * dpr);
            const ctx = node.getContext('2d');
            ctx.scale(dpr, dpr);
            return { ctx, width, height };
          });
          this.redraw(state);
        });
      });
    },

    toggleHelp() {
      this.setData({ showHelp: !this.data.showHelp });
    },

    redraw(state: ChartState) {
      state.charts.forEach((chart, i) => {
        const metric = state.metrics[i];
        drawDynamicsChart(chart, state.summary, metric.values, metric.digits, state.selected);
      });
    },

    selectAt(state: ChartState, x: number, toggle: boolean) {
      const chart = state.charts[0];
      if (!chart || !Number.isFinite(x)) return;
      const index = dynamicsWindowAt(x, chart.width, state.summary);
      const selected = toggle && index === state.selected ? null : index;
      if (selected === state.selected) return;
      state.selected = selected;
      const { window_s: window, duration_s: duration } = state.summary;
      const timeLabel = selected === null ? '全程范围' :
        `${dynamicsTime(selected * window)}–${dynamicsTime(Math.min(duration, (selected + 1) * window))}`;
      this.setData({ cards: cardsFor(state), timeLabel });
      this.redraw(state);
    },

    onChartStart(event: WechatMiniprogram.TouchCanvas) {
      const state = components.get(this);
      const touch = event.touches[0];
      if (state && touch && event.touches.length === 1) state.gesture = { start: touch, direction: 'pending' };
      else if (state) state.gesture = null;
    },

    onChartMove(event: WechatMiniprogram.TouchCanvas) {
      const state = components.get(this);
      const gesture = state?.gesture;
      if (!state || !gesture || gesture.direction === 'vertical') return;
      const touch = event.touches.find(point => point.identifier === gesture.start.identifier);
      if (!touch) return;
      if (gesture.direction === 'pending') {
        const dx = Math.abs(touch.x - gesture.start.x);
        const dy = Math.abs(touch.y - gesture.start.y);
        if (Math.max(dx, dy) < 5) return;
        gesture.direction = dx >= dy ? 'horizontal' : 'vertical';
      }
      if (gesture.direction === 'horizontal') this.selectAt(state, touch.x, false);
    },

    onChartEnd(event: WechatMiniprogram.TouchCanvas) {
      const state = components.get(this);
      const gesture = state?.gesture;
      if (!state || !gesture) return;
      state.gesture = null;
      const touch = event.changedTouches.find(point => point.identifier === gesture.start.identifier);
      if (touch && gesture.direction !== 'vertical') this.selectAt(state, touch.x, gesture.direction === 'pending');
    },

    onChartCancel() {
      const state = components.get(this);
      if (state) state.gesture = null;
    },
  },
});

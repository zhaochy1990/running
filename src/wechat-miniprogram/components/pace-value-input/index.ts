type Kind = 'time' | 'pace' | 'distance';

const units = (count: number) => Array.from({ length: count }, (_, i) => i);
const seconds = units(60);
const columns: Record<Kind, number[][]> = {
  time: [units(100), seconds, seconds],
  pace: [units(100), seconds],
  distance: [units(101), units(100)],
};

function pickerIndices(kind: Kind, value: string): number[] {
  const fields = kind === 'distance'
    ? [Math.floor(Number(value)), Number(value.split('.')[1]?.padEnd(2, '0').slice(0, 2) || 0)]
    : value.split(':').map(Number);
  return columns[kind].map((column, i) => {
    const index = fields[i];
    return Number.isInteger(index) && index >= 0 && index < column.length ? index : 0;
  });
}

const pad = (value: number) => String(value).padStart(2, '0');

Component({
  properties: {
    kind: { type: String, value: 'time' },
    value: { type: String, value: '' },
    placeholder: { type: String, value: '' },
  },

  data: {
    range: columns.time,
    indices: [0, 0, 0],
  },

  observers: {
    'kind, value'(kind: Kind, value: string) {
      this.setData({ range: columns[kind], indices: pickerIndices(kind, value) });
    },
  },

  methods: {
    onInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
      this.triggerEvent('valuechange', { value: e.detail.value });
    },

    onPick(e: WechatMiniprogram.CustomEvent<{ value: number[] }>) {
      const [first, second, third] = e.detail.value;
      const kind = this.properties.kind;
      let value = `${first}:${pad(second)}`;
      if (kind === 'time') value += `:${pad(third)}`;
      if (kind === 'distance') value = String(first + second / 100);
      this.triggerEvent('valuechange', { value });
    },
  },
});

import { shanghaiToday } from './date';
import type { PaceResult } from './paceCalculator';
import { ellipsize, type PosterCtx, type PosterImage } from './poster';
import { theme } from './theme';

interface Canvas2D {
  width: number;
  height: number;
  getContext(type: '2d'): PosterCtx & { scale(x: number, y: number): void };
  createImage(): PosterImage & { src: string; onload(): void; onerror(): void };
}

export async function renderPaceCard(result: PaceResult, title: string, message: string): Promise<string> {
  const node = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
    wx.createSelectorQuery().select('#pace-card-canvas').fields({ node: true }, (res) => {
      if (res?.node) resolve(res.node);
      else reject(new Error('Missing pace card canvas'));
    }).exec();
  });
  const canvas = node as unknown as Canvas2D;
  const rows = result.rows.length ? result.rows : result.checkpoints;
  const checkpoints = result.rows.length ? result.checkpoints : [];
  const messageLines = Array.from(message).join('').match(/.{1,25}/gu) ?? [];
  const width = 720;
  const height = 355 + rows.length * 42 + (checkpoints.length ? 52 + checkpoints.length * 34 : 0)
    + messageLines.length * 34 + (messageLines.length ? 32 : 0) + 162;
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const left = 42;
  const right = width - left;
  function line(text: string, x: number, y: number, font: string, color: string) {
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.fillText(text, x, y);
  }

  line('砺跑 StrideWise', left, 70, 'bold 29px sans-serif', theme.accentDeep);
  ctx.font = 'bold 46px sans-serif';
  line(ellipsize(title || '配速卡', right - left, (value) => ctx.measureText(value).width),
    left, 144, ctx.font, theme.textPrimary);

  ctx.fillStyle = theme.card;
  ctx.fillRect(left, 182, right - left, 112);
  const metrics = [['距离', result.distance], ['用时', result.time], ['平均配速', result.pace]];
  metrics.forEach(([label, value], i) => {
    const x = left + 20 + i * 205;
    line(label, x, 222, '23px sans-serif', theme.textSecondary);
    line(value, x, 269, 'bold 32px sans-serif', theme.textPrimary);
  });

  line(result.rows.length ? '分段' : '距离', left, 334, 'bold 23px sans-serif', theme.textSecondary);
  line('配速', 250, 334, 'bold 23px sans-serif', theme.textSecondary);
  line('本段用时', 396, 334, 'bold 23px sans-serif', theme.textSecondary);
  line('累计用时', 546, 334, 'bold 23px sans-serif', theme.textSecondary);
  let y = 374;
  for (const row of rows) {
    line(row.label, left, y, '24px sans-serif', theme.textPrimary);
    line(row.pace, 250, y, '24px sans-serif', theme.textPrimary);
    line(row.time, 396, y, '24px sans-serif', theme.textPrimary);
    line(row.cumulative, 546, y, '24px sans-serif', theme.textPrimary);
    y += 42;
  }
  if (checkpoints.length) {
    line('关键节点', left, y + 10, 'bold 24px sans-serif', theme.textSecondary);
    y += 48;
    for (const row of checkpoints) {
      line(row.label, left, y, '23px sans-serif', theme.textPrimary);
      line(row.cumulative, 546, y, '23px sans-serif', theme.textPrimary);
      y += 34;
    }
  }
  if (messageLines.length) {
    y += 18;
    ctx.fillStyle = theme.accentTint;
    ctx.fillRect(left, y - 27, right - left, 34 * messageLines.length + 16);
    for (const messageLine of messageLines) {
      line(messageLine, left + 16, y, '23px sans-serif', theme.textPrimary);
      y += 34;
    }
  }

  const qr = canvas.createImage();
  const loaded = await new Promise<boolean>((resolve) => {
    qr.onload = () => resolve(true);
    qr.onerror = () => resolve(false);
    qr.src = '/assets/stride-miniprogram-code.png';
  });
  if (loaded) {
    ctx.drawImage(qr, right - 100, height - 125, 100, 100);
    line('扫码打开砺跑，进入「我」查看配速计算器', left, height - 88, '22px sans-serif', theme.textSecondary);
  }
  line(shanghaiToday(), left, height - 48, '22px sans-serif', theme.textSecondary);

  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas: node,
      fileType: 'png',
      success: (res) => resolve(res.tempFilePath),
      fail: reject,
    });
  });
}

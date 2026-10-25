import { describe, expect, it } from 'vitest';
// chart-lite.js 是瀏覽器用的 classic script（無 export），import 時只會掛上 globalThis.ChartLite，
// 不會碰 DOM，所以可以在 node 環境直接測試入面的純函數。
import '../public/js/chart-lite.js';

interface ChartTick { t: number; label: string }
interface ChartPoint { x: number; y: number }
interface ChartLiteApi {
  toTime: (value: unknown) => number;
  fmtDay: (t: number, withYear?: boolean) => string;
  scaleX: (t: number, minT: number, maxT: number, x0: number, x1: number) => number;
  niceMax: (value: number, tickCount?: number) => number;
  dateTicks: (minT: number, maxT: number, count?: number) => ChartTick[];
  buildPath: (points: ChartPoint[]) => string;
}

const ChartLite = (globalThis as unknown as { ChartLite: ChartLiteApi }).ChartLite;
const DAY = 86400000;
const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe('chart-lite 純函數', () => {
  it('掛上 globalThis.ChartLite 並提供 renderLine', () => {
    expect(ChartLite).toBeTruthy();
    expect(typeof (ChartLite as unknown as { renderLine: unknown }).renderLine).toBe('function');
  });

  describe('toTime / fmtDay', () => {
    it('把 YYYY-MM-DD 解成 UTC 日期（不受時區影響）', () => {
      expect(ChartLite.toTime('2026-10-23')).toBe(d('2026-10-23'));
      expect(ChartLite.toTime('2026-10-23T15:30:00')).toBe(d('2026-10-23'));
    });

    it('無法解析時回 NaN，不會拋錯', () => {
      expect(Number.isNaN(ChartLite.toTime(''))).toBe(true);
      expect(Number.isNaN(ChartLite.toTime(null))).toBe(true);
      expect(Number.isNaN(ChartLite.toTime('23/10/2026'))).toBe(true);
    });

    it('fmtDay 支援有／無年份', () => {
      expect(ChartLite.fmtDay(d('2026-01-05'))).toBe('01-05');
      expect(ChartLite.fmtDay(d('2026-01-05'), true)).toBe('2026-01-05');
    });
  });

  describe('niceMax', () => {
    it('向上取到好睇的刻度上限（永遠 >= 輸入值）', () => {
      expect(ChartLite.niceMax(8.81, 4)).toBe(10);
      expect(ChartLite.niceMax(100, 4)).toBe(100);
      expect(ChartLite.niceMax(1, 4)).toBe(1); // 0 / 0.25 / 0.5 / 0.75 / 1
      // 候選步距要夠密：10.71 若取到 20，線會壓在圖表底部一半
      expect(ChartLite.niceMax(10.71, 4)).toBe(12);
      expect(ChartLite.niceMax(30.3, 4)).toBe(32);
      expect(ChartLite.niceMax(1234, 4)).toBeGreaterThanOrEqual(1234);
    });

    it('0 / 負數 / 非數字都有安全下限，不會回 0 或 NaN', () => {
      expect(ChartLite.niceMax(0)).toBe(1);
      expect(ChartLite.niceMax(-5)).toBe(1);
      expect(ChartLite.niceMax(Number.NaN)).toBe(1);
    });

    it('結果可以被 ticks 整除（刻度間距一致）', () => {
      [3, 7.5, 8.3895, 61, 999].forEach((v) => {
        const top = ChartLite.niceMax(v, 4);
        expect(top / 4).toBeCloseTo(Math.round((top / 4) * 1e6) / 1e6, 6);
        expect(top).toBeGreaterThanOrEqual(v);
      });
    });
  });

  describe('scaleX', () => {
    it('線性映射到像素（真實日期距離）', () => {
      const min = d('2026-01-01');
      const max = d('2026-01-11'); // 10 日跨度
      expect(ChartLite.scaleX(min, min, max, 0, 100)).toBe(0);
      expect(ChartLite.scaleX(max, min, max, 0, 100)).toBe(100);
      // 一個月結點（5 日前）應在中間，而不是被平均分配到 4 等份
      expect(ChartLite.scaleX(d('2026-01-06'), min, max, 0, 100)).toBeCloseTo(50, 6);
      expect(ChartLite.scaleX(min + DAY, min, max, 0, 100)).toBeCloseTo(10, 6);
    });

    it('domain 退化或非法時回 x0，不產生 NaN', () => {
      const min = d('2026-01-01');
      expect(ChartLite.scaleX(min, min, min, 20, 200)).toBe(20);
      expect(ChartLite.scaleX(Number.NaN, min, min + DAY, 20, 200)).toBe(20);
      expect(ChartLite.scaleX(min, Number.NaN, Number.NaN, 20, 200)).toBe(20);
    });
  });

  describe('dateTicks', () => {
    it('在真實日期範圍內等距取樣，首尾貼住 domain', () => {
      const min = d('2026-10-01');
      const max = d('2026-11-01'); // 31 日
      const ticks = ChartLite.dateTicks(min, max, 4);
      expect(ticks).toHaveLength(4);
      expect(ticks[0].t).toBe(min);
      expect(ticks[3].t).toBe(max);
      // 中間兩個是真實日期，且距離相等（線性時間軸）
      expect(ticks[1].t - ticks[0].t).toBeCloseTo((max - min) / 3, -20);
      expect(ticks[2].t - ticks[1].t).toBeCloseTo((max - min) / 3, -20);
    });

    it('label 是 MM-DD，且嚴格遞增', () => {
      const ticks = ChartLite.dateTicks(d('2026-10-01'), d('2026-12-25'), 6);
      ticks.forEach((tick) => expect(tick.label).toMatch(/^\d{2}-\d{2}$/));
      for (let i = 1; i < ticks.length; i += 1) expect(ticks[i].t).toBeGreaterThan(ticks[i - 1].t);
    });

    it('只有一個日期時回單一 tick（呼叫端不應畫線，但也不會爆）', () => {
      const only = d('2026-10-25');
      expect(ChartLite.dateTicks(only, only, 4)).toEqual([{ t: only, label: '10-25' }]);
    });

    it('非法 domain 回空陣列', () => {
      expect(ChartLite.dateTicks(Number.NaN, Number.NaN, 4)).toEqual([]);
    });

    it('tick 數被夾在 2 至 8 之間', () => {
      const min = d('2026-01-01');
      const max = d('2026-02-01');
      expect(ChartLite.dateTicks(min, max, 1)).toHaveLength(2);
      expect(ChartLite.dateTicks(min, max, 99)).toHaveLength(8);
      expect(ChartLite.dateTicks(min, max, undefined)).toHaveLength(4);
    });
  });

  describe('buildPath（缺值必須斷線，不可畫 0）', () => {
    it('連續點用 M 起、L 連', () => {
      expect(ChartLite.buildPath([{ x: 0, y: 10 }, { x: 10, y: 20 }])).toBe('M0 10 L10 20');
    });

    it('缺值（NaN / null / undefined）後重新起筆', () => {
      const d1 = ChartLite.buildPath([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
        { x: 20, y: Number.NaN },
        { x: 30, y: 40 },
      ]);
      expect(d1).toBe('M0 10 L10 20 M30 40');
      const d2 = ChartLite.buildPath([
        { x: 0, y: Number.NaN },
        { x: 10, y: 20 },
        { x: 20, y: null as unknown as number },
        { x: 30, y: 40 },
      ]);
      expect(d2).toBe('M10 20 M30 40');
    });

    it('全部缺值或空陣列時回空字串（呼叫端不會畫出假線）', () => {
      expect(ChartLite.buildPath([])).toBe('');
      expect(ChartLite.buildPath([{ x: 0, y: Number.NaN }])).toBe('');
      expect(ChartLite.buildPath(undefined as unknown as ChartPoint[])).toBe('');
    });

    it('像素值四捨五入到小數兩位，避免超長 d 字串', () => {
      expect(ChartLite.buildPath([{ x: 1.234567, y: 9.876543 }])).toBe('M1.23 9.88');
    });
  });
});

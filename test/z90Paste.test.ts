import { describe, expect, it } from 'vitest';
// z90-paste.js 是瀏覽器用的 classic script（無 export），import 時只會掛上 globalThis.Z90Paste，
// 不會碰 DOM，所以可以在 node 環境直接測試。
import '../public/js/z90-paste.js';

interface Z90PasteApi {
  parse: (text: string) => {
    error?: string;
    reportDate?: string;
    shopCount?: number;
    stats?: { makeupSku: number; makeupQty: number; nonSku: number; nonQty: number };
    totals?: { sku: number; qty: number };
  };
  parseNumber: (text: unknown) => number | null;
}

const Z90Paste = (globalThis as unknown as { Z90Paste: Z90PasteApi }).Z90Paste;

/** 2026-11-17 的簡報數字（測試夾具，非真實報表） */
const VALID = '6,618\t253,204\t2,605\t100,669\t4,013\t152,535';

describe('90日0銷售 Excel 貼上解析', () => {
  it('6 欄 Tab 分隔：拆出 MAKE UP／Non-MAKE UP 並回算總數', () => {
    const result = Z90Paste.parse(VALID);
    expect(result.error).toBeUndefined();
    expect(result.stats).toEqual({ makeupSku: 2605, makeupQty: 100669, nonSku: 4013, nonQty: 152535 });
    expect(result.totals).toEqual({ sku: 6618, qty: 253204 });
    expect(result.reportDate).toBeUndefined();
    expect(result.shopCount).toBeUndefined();
  });

  it('連表頭一齊貼：非數字行自動跳過', () => {
    const header = 'P90D 0 Sales SKU 總數\tShop Stock Qty (CM) 總數\tMAKE UP SKU 數\tMAKE UP Shop Stock Qty (CM) 總數\tNon-MAKE UP SKU 數\tNon-MAKE UP Shop Stock Qty (CM) 總數';
    const result = Z90Paste.parse(`${header}\n${VALID}\n`);
    expect(result.error).toBeUndefined();
    expect(result.stats?.makeupSku).toBe(2605);
  });

  it('連續空格分隔都可以（由網頁／PDF 複製）', () => {
    const result = Z90Paste.parse('6618   253204   2605   100669   4013   152535');
    expect(result.error).toBeUndefined();
    expect(result.totals).toEqual({ sku: 6618, qty: 253204 });
  });

  it('8 欄（日期 + 店數 + 6 個數字）會一併填入日期與店數', () => {
    const result = Z90Paste.parse('2026-11-24\t88\t6,690\t235,000\t2,600\t104,000\t4,090\t131,000');
    expect(result.error).toBeUndefined();
    expect(result.reportDate).toBe('2026-11-24');
    expect(result.shopCount).toBe(88);
    expect(result.totals).toEqual({ sku: 6690, qty: 235000 });
  });

  it('小數存貨量照樣解析', () => {
    const result = Z90Paste.parse('300\t3,000.75\t100\t1,000.5\t200\t2,000.25');
    expect(result.error).toBeUndefined();
    expect(result.stats?.makeupQty).toBe(1000.5);
    expect(result.totals?.qty).toBeCloseTo(3000.75, 3);
  });

  it('SKU 總數對唔上：拒絕填入並講明差幾多', () => {
    const result = Z90Paste.parse('6,618\t253,204\t2,605\t100,669\t4,000\t152,535');
    expect(result.stats).toBeUndefined();
    expect(result.error).toContain('SKU 總數對唔上');
    expect(result.error).toContain('6,618');
    expect(result.error).toContain('6,605');
  });

  it('存貨量總數差超過 1 件：拒絕填入', () => {
    const result = Z90Paste.parse('6,618\t253,204\t2,605\t100,669\t4,013\t152,533');
    expect(result.error).toContain('存貨量總數對唔上');
  });

  it('存貨量差 1 件以內當捨入容許', () => {
    const result = Z90Paste.parse('6,618\t253,205\t2,605\t100,669\t4,013\t152,535');
    expect(result.error).toBeUndefined();
    expect(result.totals?.qty).toBe(253204);
  });

  it('一次貼多過一行：提示只可以貼一期', () => {
    const result = Z90Paste.parse(`${VALID}\n6,577\t244,191\t2,598\t100,931\t3,979\t143,260`);
    expect(result.error).toContain('一次只可以貼一期');
  });

  it('SKU 有小數：視為貼錯欄', () => {
    const result = Z90Paste.parse('6,618\t253,204\t2,605.5\t100,669\t4,012.5\t152,535');
    expect(result.error).toContain('SKU 數必須是整數');
  });

  it('冇數字／負數：回錯誤，不會變成 0', () => {
    expect(Z90Paste.parse('').error).toBeTruthy();
    expect(Z90Paste.parse('MAKE UP\nNon-MAKE UP').error).toBeTruthy();
    expect(Z90Paste.parse('-1\t2\t3\t4\t5\t6').error).toBeTruthy();
  });

  it('parseNumber：千分位／小數／文字', () => {
    expect(Z90Paste.parseNumber('1,234.5')).toBe(1234.5);
    expect(Z90Paste.parseNumber('  88 ')).toBe(88);
    expect(Z90Paste.parseNumber('')).toBeNull();
    expect(Z90Paste.parseNumber('abc')).toBeNull();
    expect(Z90Paste.parseNumber(null)).toBeNull();
  });
});

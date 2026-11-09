import { query } from '../db/pool.js';
import { URGENT_LIMIT_TIERS, URGENT_LIMIT_MAX_MULTIPLIER, URGENT_QTY_MAX } from '../lib/fields.js';
import { toHKDateString, toHKString } from '../lib/time.js';

/** 旺季限額所處階段；前台只會在 active 時使用調高後的 Limit Qty。 */
export type UrgentLimitPhase = 'none' | 'scheduled' | 'active' | 'ended';

export interface UrgentLimitTierView {
  label: string;
  baseLimit: number;
  /** 旺季期間會顯示的 Limit Qty（未封頂）。 */
  peakLimit: number;
}

export interface UrgentLimitSettingsView {
  multiplier: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string;
  updatedBy: string;
  updatedAt: string | null;
  /** 今日（香港日期，YYYY-MM-DD），方便前台／後台顯示及判斷。 */
  today: string;
  phase: UrgentLimitPhase;
  /** 目前生效的每筆 QTY 上限；非旺季 = 1000，旺季 = 最高一級 peakLimit。 */
  qtyMax: number;
  /** 旺季期間（不論是否已生效）最高的 Limit Qty，供後台預覽。 */
  peakQtyMax: number;
  tiers: UrgentLimitTierView[];
}

export interface SaveUrgentLimitInput {
  multiplier: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string;
}

type SettingsRow = {
  peak_multiplier: string | number;
  effective_from: string | Date | null;
  effective_to: string | Date | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string | Date | null;
};

function toDateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return toHKDateString(value);
}

function normalizeMultiplier(value: string | number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(URGENT_LIMIT_MAX_MULTIPLIER, Math.round(n * 100) / 100);
}

function resolvePhase(
  multiplier: number,
  from: string | null,
  to: string | null,
  today: string,
): UrgentLimitPhase {
  if (!from || !to || multiplier <= 1) return 'none';
  if (today < from) return 'scheduled';
  if (today > to) return 'ended';
  return 'active';
}

/**
 * 建立五級對照表。旺季倍數以 `floor` 計，避免出現小數件數；
 * 每筆上限由最高一級 peakLimit 決定，不再固定封頂 1000。
 */
export function buildUrgentLimitTiers(multiplier: number): UrgentLimitTierView[] {
  const m = normalizeMultiplier(multiplier);
  return URGENT_LIMIT_TIERS.map((tier) => ({
    label: tier.label,
    baseLimit: tier.baseLimit,
    peakLimit: Math.floor(tier.baseLimit * m),
  }));
}

/** 後台／前台共用的設定讀取；DB 未初始化時回基本值。 */
export async function getUrgentLimitSettings(now: Date = new Date()): Promise<UrgentLimitSettingsView> {
  const result = await query<SettingsRow>(
    `SELECT peak_multiplier::text AS peak_multiplier,
            effective_from::text AS effective_from,
            effective_to::text AS effective_to,
            note, updated_by, updated_at
       FROM urgent_limit_settings
      WHERE id = 1`,
  );
  const row = result.rows[0];
  const multiplier = normalizeMultiplier(row?.peak_multiplier ?? 1);
  const effectiveFrom = toDateOnly(row?.effective_from);
  const effectiveTo = toDateOnly(row?.effective_to);
  const today = toHKDateString(now);
  const phase = resolvePhase(multiplier, effectiveFrom, effectiveTo, today);
  const tiers = buildUrgentLimitTiers(multiplier);
  const peakQtyMax = Math.max(...tiers.map((tier) => tier.peakLimit));

  return {
    multiplier,
    effectiveFrom,
    effectiveTo,
    note: row?.note ?? '',
    updatedBy: row?.updated_by ?? '',
    updatedAt: row?.updated_at ? toHKString(row.updated_at) : null,
    today,
    phase,
    qtyMax: phase === 'active' ? Math.max(URGENT_QTY_MAX, peakQtyMax) : URGENT_QTY_MAX,
    peakQtyMax,
    tiers,
  };
}

/** 目前生效的每筆 Urgent Order 上限（旺季會按最高一級 Limit Qty 提高）。 */
export async function getUrgentQtyMax(now: Date = new Date()): Promise<number> {
  return (await getUrgentLimitSettings(now)).qtyMax;
}

/** 寫入單列設定；呼叫端負責日期及倍數的業務驗證。 */
export async function saveUrgentLimitSettings(
  input: SaveUrgentLimitInput,
  actor: string,
): Promise<UrgentLimitSettingsView> {
  await query(
    `INSERT INTO urgent_limit_settings
       (id, peak_multiplier, effective_from, effective_to, note, updated_by, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       peak_multiplier = EXCLUDED.peak_multiplier,
       effective_from = EXCLUDED.effective_from,
       effective_to = EXCLUDED.effective_to,
       note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      Math.round(input.multiplier * 100) / 100,
      input.effectiveFrom,
      input.effectiveTo,
      input.note,
      actor,
    ],
  );
  return getUrgentLimitSettings();
}

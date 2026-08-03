export const SAP_COLUMNS = [
  'Application Date',
  'Requested by',
  'Shop Code',
  'Brand',
  'SKU',
  'RP Type',
  'Safety stock',
  'ND Code',
  'Remark',
] as const;

export type SapColumn = (typeof SAP_COLUMNS)[number];

/** Columns shown in the downloadable import template. */
export const TEMPLATE_COLUMNS = ['Shop Code', 'SKU', 'RP Type', 'Safety stock', 'ND Code', 'Remark'] as const;

/** Business fields a user/admin can set, keyed by internal column name. */
export interface SubmissionBusinessFields {
  brand: string;
  sku: string;
  rp_type: string;
  safety_stock: string;
  nd_code: string;
  remark: string;
}

export const BUSINESS_FIELD_LABELS: Record<keyof SubmissionBusinessFields, string> = {
  brand: 'Brand',
  sku: 'SKU',
  rp_type: 'RP Type',
  safety_stock: 'Safety stock',
  nd_code: 'ND Code',
  remark: 'Remark',
};

/** Map internal field -> SAP column index (0-based into SAP_COLUMNS). */
export const FIELD_TO_SAP_INDEX: Record<keyof SubmissionBusinessFields, number> = {
  brand: 3,
  sku: 4,
  rp_type: 5,
  safety_stock: 6,
  nd_code: 7,
  remark: 8,
};

/** Map SAP column name -> internal field. */
export const SAP_INDEX_TO_FIELD: Record<number, keyof SubmissionBusinessFields> = {
  3: 'brand',
  4: 'sku',
  5: 'rp_type',
  6: 'safety_stock',
  7: 'nd_code',
  8: 'remark',
};

/** Map template column index (0-based into TEMPLATE_COLUMNS) -> internal field. Shop Code is handled separately. */
export const TEMPLATE_INDEX_TO_FIELD: Record<number, keyof SubmissionBusinessFields> = {
  1: 'sku',
  2: 'rp_type',
  3: 'safety_stock',
  4: 'nd_code',
  5: 'remark',
};

export const RP_TYPE_OPTIONS = ['ND', 'RF'];
export const REQUESTED_BY_OPTIONS = [
  'Cora Lai ',
  'Ice Lin',
  'Bridget Wong ',
  'Ricky Yue',
  'Ting Chan',
  'Laurent Wong',
  'Winnie Lin',
];

export const ND_CODE_OPTIONS = [
  'ND20-SO-Not displayed in small stores',
  'ND21-SO-Seasonal item(Winter)',
  'ND22-SO-Seasonal item(Summer)',
  'ND23-SO-Due to OM/SUP reason',
  'ND29-SO-Optimized SKU(Specific store)',
];

export const REQUESTED_BY_HEADER = 'Requested by';
export const SHOP_CODE_HEADER = 'Shop Code';
export const APPLICATION_DATE_HEADER = 'Application Date';
export const RP_TEAM_SHEET = 'RP Team';

export const URGENT_COLUMNS = ['Site Code', 'SKU', 'QTY', 'Urgent Reason', 'Other Reason'] as const;
export type UrgentColumn = (typeof URGENT_COLUMNS)[number];

export const URGENT_SHEET = 'Urgent Order';

export const URGENT_QTY_MIN = 1;
export const URGENT_QTY_MAX = 1000;

/** Approved Urgent Order reasons in display order. Codes are stable DB values. */
export const URGENT_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '1', label: '1. 客人訂購 (RP Team定期隨機抽查核實)' },
  { code: '2', label: '2. ROADSHOW' },
  { code: '3', label: '3. 追數 (OM指定)' },
  { code: '4', label: '4. Promotion' },
  { code: '5', label: '5. 新舖落貨(只限開舖第一週)' },
  { code: '6', label: '6. 新產品SAP無法落貨' },
  { code: '7', label: '7. 大堆頭擺放' },
  { code: '8', label: '8. 管理層要求(只限Portal落貨)(缺貨)' },
  { code: '9', label: '9. 其他' },
] as const;

export const URGENT_REASON_OPTIONS: ReadonlyArray<string> = URGENT_REASONS.map((r) => r.code);
export const URGENT_REASON_OTHER_CODE = '9';
export const URGENT_REASON_OTHER_MAX = 2000;

export function urgentReasonLabel(code: string | null | undefined): string {
  const found = URGENT_REASONS.find((r) => r.code === normalizeText(code));
  return found ? found.label : '';
}

/**
 * Resolves a user-provided Urgent Reason value to its stable code. Accepts the
 * code itself ("1".."9") or the full display label (as picked from the Excel
 * dropdown). Returns '' when the value matches neither.
 */
export function resolveUrgentReasonCode(value: string | null | undefined): string {
  const trimmed = normalizeText(value);
  if (URGENT_REASON_OPTIONS.includes(trimmed)) return trimmed;
  const found = URGENT_REASONS.find((r) => r.label === trimmed);
  return found ? found.code : '';
}

/** Business data of an Urgent Order submission (snapshot + API payload). */
export interface UrgentFields {
  site_code: string;
  sku: string;
  qty: number;
  urgent_reason: string | null;
  urgent_reason_other: string | null;
}

export function isValidUrgentQty(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= URGENT_QTY_MIN && value <= URGENT_QTY_MAX;
}

export function normalizeText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s;
}

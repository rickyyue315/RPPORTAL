import {
  ND_CODE_OPTIONS,
  normalizeText,
  RETURN_QTY_MAX,
  RETURN_QTY_MIN,
  resolveReturnReasonCode,
  resolveUrgentReasonCode,
  URGENT_REASON_OTHER_CODE,
  URGENT_REASON_OTHER_MAX,
  RP_TYPE_OPTIONS,
  type SubmissionBusinessFields,
} from './fields.js';

/** SKU 只容許 7 位或 12 位數字（一個 SKU）。 */
export const SKU_PATTERN = /^(?:\d{7}|\d{12})$/;
export const SKU_ERROR = 'SKU 只容許 7 位或 12 位數字，每個申請只能輸入一個 SKU';

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidSku(value: string | null | undefined): boolean {
  return SKU_PATTERN.test(normalizeText(value));
}

/** 轉 RF 時必須填寫 Remark 的店舖。 */
export const RF_REMARK_REQUIRED_SITES: ReadonlySet<string> = new Set([
  'HA19',
  'HA21',
  'HA33',
  'HA37',
  'HB77',
  'HB86',
  'HB87',
  'HB91',
  'HBA5',
  'HBA7',
  'HC13',
  'HC44',
  'HC68',
  'HC70',
]);

export interface BusinessValidationError {
  field: string;
  message: string;
}

export interface UrgentReasonValidationError {
  field: string;
  message: string;
}

export interface ReturnValidationError {
  field: string;
  message: string;
}

export interface ReturnBusinessFields {
  sku: string;
  qty: number;
  reason: string;
  confirmerName: string;
  confirmerPhone: string;
}

export function validateReturnFields(fields: ReturnBusinessFields): ReturnValidationError[] {
  const errors: ReturnValidationError[] = [];
  const sku = normalizeText(fields.sku);
  const reason = normalizeText(fields.reason);
  const name = normalizeText(fields.confirmerName);
  const phone = normalizeText(fields.confirmerPhone);

  if (!sku) errors.push({ field: 'sku', message: 'SKU 為必填' });
  else if (!isValidSku(sku)) errors.push({ field: 'sku', message: SKU_ERROR });

  if (!Number.isInteger(fields.qty) || fields.qty < RETURN_QTY_MIN || fields.qty > RETURN_QTY_MAX) {
    errors.push({ field: 'qty', message: `QTY 必須為 ${RETURN_QTY_MIN} 至 ${RETURN_QTY_MAX} 的整數` });
  }
  if (!reason) errors.push({ field: 'reason', message: 'REASON 為必填' });
  else if (!resolveReturnReasonCode(reason)) errors.push({ field: 'reason', message: 'REASON 選項無效' });
  if (!name) errors.push({ field: 'confirmer_name', message: '確認人姓名為必填' });
  if (!phone) errors.push({ field: 'confirmer_phone', message: '確認人電話為必填' });
  return errors;
}

function isPositiveNumber(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Business validation shared by web submit, web modify, admin edit and Excel import.
 * Returns an array of field-level errors (empty means valid).
 */
export function validateBusinessFields(
  fields: SubmissionBusinessFields,
  siteCode: string,
): BusinessValidationError[] {
  const errors: BusinessValidationError[] = [];
  const rpType = normalizeText(fields.rp_type);
  const safetyStock = normalizeText(fields.safety_stock);
  const ndCode = normalizeText(fields.nd_code);
  const remark = normalizeText(fields.remark);

  if (!rpType) {
    errors.push({ field: 'rp_type', message: 'RP Type 為必填' });
    return errors;
  }

  if (!RP_TYPE_OPTIONS.includes(rpType as (typeof RP_TYPE_OPTIONS)[number])) {
    errors.push({ field: 'rp_type', message: 'RP Type 必須為 ND 或 RF' });
    return errors;
  }

  if (rpType === 'RF') {
    if (!safetyStock) {
      errors.push({ field: 'safety_stock', message: 'RP Type 為 RF 時必須填寫 Safety stock' });
    } else if (!isPositiveNumber(safetyStock)) {
      errors.push({ field: 'safety_stock', message: 'Safety stock 必須為大於 0 的數字' });
    }
    if (ndCode) {
      errors.push({ field: 'nd_code', message: 'RP Type 為 RF 時不可填寫 ND Code' });
    }
    if (RF_REMARK_REQUIRED_SITES.has(normalizeText(siteCode).toUpperCase()) && !remark) {
      errors.push({ field: 'remark', message: '此店舖轉 RF 時必須填寫 Remark' });
    }
  } else if (rpType === 'ND') {
    if (safetyStock) {
      errors.push({ field: 'safety_stock', message: 'RP Type 為 ND 時不可填寫 Safety stock' });
    }
    if (!ndCode) {
      errors.push({ field: 'nd_code', message: 'RP Type 為 ND 時必須填寫 ND Code' });
    } else if (!ND_CODE_OPTIONS.includes(ndCode)) {
      errors.push({ field: 'nd_code', message: 'ND Code 必須為系統提供的選項' });
    }
  }

  return errors;
}

/**
 * Validates the Urgent Order reason. Accepts either the stable code or the
 * full display label; option 9 requires a non-blank supplement, while other
 * options must not carry a supplement. Returns field-level errors (empty
 * means valid).
 */
export function validateUrgentReason(
  reason: string | null | undefined,
  reasonOther: string | null | undefined,
): UrgentReasonValidationError[] {
  const errors: UrgentReasonValidationError[] = [];
  const other = normalizeText(reasonOther);

  if (!normalizeText(reason)) {
    errors.push({ field: 'urgent_reason', message: 'Urgent Reason 為必填' });
    return errors;
  }
  const code = resolveUrgentReasonCode(reason);
  if (!code) {
    errors.push({ field: 'urgent_reason', message: 'Urgent Reason 選項無效' });
    return errors;
  }

  if (code === URGENT_REASON_OTHER_CODE) {
    if (!other) {
      errors.push({ field: 'urgent_reason_other', message: '選擇「9. 其他」時必須填寫 Other Reason' });
    } else if (other.length > URGENT_REASON_OTHER_MAX) {
      errors.push({ field: 'urgent_reason_other', message: `Other Reason 最多 ${URGENT_REASON_OTHER_MAX} 字元` });
    }
  } else if (other) {
    errors.push({ field: 'urgent_reason_other', message: '僅選擇「9. 其他」時才可填寫 Other Reason' });
  }

  return errors;
}

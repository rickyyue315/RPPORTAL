export const SAP_COLUMNS = [
  'Application Date',
  'Requested by',
  'Shop Code',
  'Brand',
  'SKU',
  'RP Type',
  'Supply source',
  'Safety stock',
  'ND Code',
  'RP Parameters Change Request',
  'RP Type 回覆完成日期',
  'Remark',
] as const;

export type SapColumn = (typeof SAP_COLUMNS)[number];

/** Business fields a user/admin can set, keyed by internal column name. */
export interface SubmissionBusinessFields {
  brand: string;
  sku: string;
  rp_type: string;
  supply_source: string;
  safety_stock: string;
  nd_code: string;
  rp_parameters_change_request: string;
  rp_type_completed_at: string;
  remark: string;
}

export const BUSINESS_FIELD_LABELS: Record<keyof SubmissionBusinessFields, string> = {
  brand: 'Brand',
  sku: 'SKU',
  rp_type: 'RP Type',
  supply_source: 'Supply source',
  safety_stock: 'Safety stock',
  nd_code: 'ND Code',
  rp_parameters_change_request: 'RP Parameters Change Request',
  rp_type_completed_at: 'RP Type 回覆完成日期',
  remark: 'Remark',
};

/** Map internal field -> SAP column index (0-based into SAP_COLUMNS). */
export const FIELD_TO_SAP_INDEX: Record<keyof SubmissionBusinessFields, number> = {
  brand: 3,
  sku: 4,
  rp_type: 5,
  supply_source: 6,
  safety_stock: 7,
  nd_code: 8,
  rp_parameters_change_request: 9,
  rp_type_completed_at: 10,
  remark: 11,
};

/** Map SAP column name -> internal field. */
export const SAP_INDEX_TO_FIELD: Record<number, keyof SubmissionBusinessFields> = {
  3: 'brand',
  4: 'sku',
  5: 'rp_type',
  6: 'supply_source',
  7: 'safety_stock',
  8: 'nd_code',
  9: 'rp_parameters_change_request',
  10: 'rp_type_completed_at',
  11: 'remark',
};

export const RP_TYPE_OPTIONS = ['ND', 'RF'];
export const SUPPLY_SOURCE_OPTIONS = [
  '1 - Vendor (由供應商送貨到舖)',
  '2 - Warehouse (由貨倉送貨到舖)',
  '4 - Flow Thru (供應商送貨經貨倉統一派送到舖)',
];
export const RP_PARAMETER_OPTIONS = [
  'New SKU Maintenance',
  'RP Type',
  'Supply Source ',
  'Safety stock',
  'Display Stock',
];
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
  'ND00-Default SKU ND status when created',
  'ND01-Under ND Classification',
  'ND10-CMPD-Not assigned to specific store',
  'ND11-CMPD-Seasona item(Winter)',
  'ND12-CMPD-Seasona item(Summer)',
  'ND13-CMPD-Non Active SKU',
  'ND14-CMPD-One-time purchase',
  'ND20-SO-Not displayed in small stores',
  'ND21-SO-Seasonal item(Winter)',
  'ND22-SO-Seasonal item(Summer)',
  'ND23-SO-Due to OM/SUP reason',
  'ND29-SO-Optimized SKU(Specific store)',
  'ND30-Legal & Regulatory Restrictions',
  'ND31-Hazardous Goods',
  'ND32-Health Products-Macau',
  'ND33-Outlets',
  'ND34-Health Products-HK',
  'ND35-SSDC Exclusive',
  'ND40-Product Issue-Quality',
  'ND41-Product Issue-Label',
  'ND50-Vendor Return',
];

export const REQUESTED_BY_HEADER = 'Requested by';
export const SHOP_CODE_HEADER = 'Shop Code';
export const APPLICATION_DATE_HEADER = 'Application Date';
export const RP_TEAM_SHEET = 'RP Team';

export function normalizeText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s;
}

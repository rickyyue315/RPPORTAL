import { query } from '../db/pool.js';

/** 通告語氣：影響前台圖示與左側色條。 */
export type NoticeTone = 'info' | 'warning' | 'success';

export interface NoticeRow {
  id: string;
  title: string;
  body: string;
  link_url: string | null;
  link_text: string | null;
  tone: NoticeTone;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface NoticeInput {
  title: string;
  body?: string;
  linkUrl?: string | null;
  linkText?: string | null;
  tone?: NoticeTone;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

/** 一頁最多顯示幾條通告；太多會蓋住真正要做的表格。 */
export const MAX_ACTIVE_NOTICES = 3;

const COLUMNS = `id, title, body, link_url, link_text, tone, is_active, starts_at, ends_at,
                 revision, created_by, updated_by, created_at, updated_at`;

/**
 * 前台用：只回「生效中」的通告，新到舊，最多 3 條。
 *
 * 生效條件寫在 SQL，而不是前端再判斷一次——過期通告不應該下載到店舖電腦，
 * 亦避免店舖時鐘不準時看到已完結的公告。
 */
export async function listActiveNotices(limit = MAX_ACTIVE_NOTICES): Promise<NoticeRow[]> {
  const result = await query<NoticeRow>(
    `SELECT ${COLUMNS}
       FROM portal_notices
      WHERE is_active
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at   IS NULL OR ends_at   >  now())
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/** 後台用：全部通告（含停用與過期），新到舊。 */
export async function listNotices(): Promise<NoticeRow[]> {
  const result = await query<NoticeRow>(
    `SELECT ${COLUMNS}
       FROM portal_notices
      ORDER BY is_active DESC, created_at DESC
      LIMIT 200`,
  );
  return result.rows;
}

export async function createNotice(input: NoticeInput, actor: string): Promise<NoticeRow> {
  const result = await query<NoticeRow>(
    `INSERT INTO portal_notices
       (title, body, link_url, link_text, tone, is_active, starts_at, ends_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING ${COLUMNS}`,
    [
      input.title,
      input.body ?? '',
      input.linkUrl ?? null,
      input.linkText ?? null,
      input.tone ?? 'info',
      input.isActive ?? true,
      input.startsAt ?? null,
      input.endsAt ?? null,
      actor,
    ],
  );
  return result.rows[0]!;
}

export async function updateNotice(
  id: string,
  input: NoticeInput,
  actor: string,
): Promise<NoticeRow | null> {
  const result = await query<NoticeRow>(
    `UPDATE portal_notices
        SET title = $2,
            body = $3,
            link_url = $4,
            link_text = $5,
            tone = $6,
            is_active = $7,
            starts_at = $8,
            ends_at = $9,
            updated_by = $10,
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      id,
      input.title,
      input.body ?? '',
      input.linkUrl ?? null,
      input.linkText ?? null,
      input.tone ?? 'info',
      input.isActive ?? true,
      input.startsAt ?? null,
      input.endsAt ?? null,
      actor,
    ],
  );
  return result.rows[0] ?? null;
}

export async function deleteNotice(id: string): Promise<boolean> {
  // 用 RETURNING 的行數而不是 rowCount：PGlite（測試用）唔會填 rowCount。
  const result = await query<{ id: string }>(
    `DELETE FROM portal_notices WHERE id = $1 RETURNING id`,
    [id],
  );
  return result.rows.length === 1;
}

/**
 * 重新推送：revision + 1。
 *
 * 店舖的 localStorage 記號是 `notice:<id>:r<revision>`，所以 +1 之後所有店舖
 * （包括之前按過 X 的）都會再見到一次。用遞增而不是重置，才不會與舊記號碰撞。
 */
export async function republishNotice(id: string, actor: string): Promise<NoticeRow | null> {
  const result = await query<NoticeRow>(
    `UPDATE portal_notices
        SET revision = revision + 1,
            is_active = true,
            updated_by = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, actor],
  );
  return result.rows[0] ?? null;
}

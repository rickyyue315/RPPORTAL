import type { Request } from 'express';

export function getUploadedFile(req: Request): Express.Multer.File | undefined {
  return (req as Request & { file?: Express.Multer.File }).file;
}

export function validateUploadedXlsx(
  file: Express.Multer.File | undefined,
  maxBytes: number,
  extensionError: string,
): { status: number; message: string } | null {
  if (!file) return { status: 400, message: '請上載 Excel 檔案' };
  if (!/\.xlsx$/i.test(file.originalname)) return { status: 400, message: extensionError };
  if (file.size > maxBytes) return { status: 400, message: `檔案超過 ${maxBytes / 1024 / 1024}MB 限制` };
  return null;
}

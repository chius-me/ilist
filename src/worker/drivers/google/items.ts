import type { StorageItem } from '../types';
import type { GoogleFile } from './client';

export const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_SLIDE_MIME_TYPE = 'application/vnd.google-apps.presentation';
const GOOGLE_NATIVE_MIME_PREFIX = 'application/vnd.google-apps.';

const PDF = { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' };

export function googleExportOptions(mimeType: string) {
  if (mimeType === GOOGLE_DOC_MIME_TYPE) {
    return [PDF, {
      format: 'docx', label: 'DOCX', extension: 'docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }];
  }
  if (mimeType === GOOGLE_SHEET_MIME_TYPE) {
    return [PDF, {
      format: 'xlsx', label: 'XLSX', extension: 'xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }];
  }
  if (mimeType === GOOGLE_SLIDE_MIME_TYPE) {
    return [PDF, {
      format: 'pptx', label: 'PPTX', extension: 'pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }];
  }
  return undefined;
}

export function isGoogleNativeFile(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX) && mimeType !== GOOGLE_FOLDER_MIME_TYPE;
}

function fileSize(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

export function mapGoogleFile(file: GoogleFile, fallbackParentId: string | null): StorageItem {
  const folder = file.mimeType === GOOGLE_FOLDER_MIME_TYPE;
  const exportOptions = googleExportOptions(file.mimeType);
  return {
    id: file.id,
    parentId: file.parents?.[0] ?? fallbackParentId,
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? null : fileSize(file.size),
    contentType: folder ? null : file.mimeType,
    modifiedAt: file.modifiedTime ?? null,
    etag: file.md5Checksum ?? null,
    ...(exportOptions ? { exportOptions: exportOptions.map((option) => ({ ...option })) } : {}),
  };
}

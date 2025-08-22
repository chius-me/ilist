export interface LegacyObjectRow {
  key: string;
  name: string;
  size: number;
  content_type: string | null;
  etag: string | null;
  updated_at: string;
  is_public: number;
  sort_order: number;
  description: string;
}

export interface LegacyEntry {
  id: string;
  parent_id: string;
  parent_path: string;
  name: string;
  kind: 'file' | 'folder';
  storage_key: string | null;
  size: number;
  content_type: string | null;
  etag: string | null;
  status: 'ready';
  is_public: number;
  sort_order: number;
  description: string;
  created_at: string;
  updated_at: string;
}

export function buildLegacyEntries(rows: LegacyObjectRow[]): LegacyEntry[];
export function entriesToSql(entries: LegacyEntry[]): string;

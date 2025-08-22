import { createHash } from 'node:crypto';

function idFor(kind, value) {
  return `legacy-${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function assertName(name, topLevel, sourceKey) {
  const invalid =
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    Buffer.byteLength(name, 'utf8') > 255;
  if (invalid || (topLevel && ['api', 'file', 'admin'].includes(name))) {
    throw new Error(`Legacy object ${sourceKey} contains an invalid virtual name: ${name}`);
  }
}

export function buildLegacyEntries(rows) {
  const folders = new Map();
  const files = [];
  for (const row of rows) {
    const parts = row.key.split('/').filter(Boolean);
    const fileSegment = parts.pop();
    if (!fileSegment) continue;
    let parentId = 'root';
    let parentPath = '';
    const rowFolderPaths = [];
    for (const [index, segment] of parts.entries()) {
      assertName(segment, index === 0, row.key);
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      rowFolderPaths.push(path);
      if (!folders.has(path)) {
        folders.set(path, {
          id: idFor('folder', path),
          parent_id: parentId,
          parent_path: parentPath,
          name: segment,
          kind: 'folder',
          storage_key: null,
          size: 0,
          content_type: null,
          etag: null,
          status: 'ready',
          is_public: 0,
          sort_order: 0,
          description: '',
          created_at: row.updated_at,
          updated_at: row.updated_at,
        });
      }
      parentId = folders.get(path).id;
      parentPath = path;
    }
    if (row.is_public === 1) {
      for (const path of rowFolderPaths) folders.get(path).is_public = 1;
    }
    const virtualName = row.name || fileSegment;
    assertName(virtualName, parts.length === 0, row.key);
    files.push({
      id: idFor('file', row.key),
      parent_id: parentId,
      parent_path: parentPath,
      name: virtualName,
      kind: 'file',
      storage_key: row.key,
      size: row.size,
      content_type: row.content_type,
      etag: row.etag,
      status: 'ready',
      is_public: row.is_public,
      sort_order: row.sort_order,
      description: row.description,
      created_at: row.updated_at,
      updated_at: row.updated_at,
    });
  }
  const entries = [...folders.values(), ...files];
  const siblingNames = new Set();
  for (const entry of entries) {
    const key = `${entry.parent_id}\u0000${entry.name}`;
    if (siblingNames.has(key)) {
      throw new Error(`Legacy objects contain duplicate virtual name under ${entry.parent_path || '/'}: ${entry.name}`);
    }
    siblingNames.add(key);
  }
  return entries;
}

function sqlValue(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function entriesToSql(entries) {
  return entries
    .map(
      (entry) => `INSERT OR IGNORE INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag,
    status, is_public, sort_order, description, created_at, updated_at
  ) VALUES (${[
    entry.id,
    entry.parent_id,
    entry.name,
    entry.kind,
    entry.storage_key,
    entry.size,
    entry.content_type,
    entry.etag,
    entry.status,
    entry.is_public,
    entry.sort_order,
    entry.description,
    entry.created_at,
    entry.updated_at,
  ]
    .map(sqlValue)
    .join(', ')});`,
    )
    .join('\n');
}

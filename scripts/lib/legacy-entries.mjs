import { createHash } from 'node:crypto';

const MAX_SQL_STATEMENT_BYTES = 90_000;

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
    if (!fileSegment) {
      throw new Error(`Legacy object contains an invalid key: ${row.key}`);
    }
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

function markerKey(entry, migrationToken) {
  return `legacy_object_migration_inserted_${migrationToken}_${entry.id}`;
}

function insertStatement(entry) {
  const values = [
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
    '',
    entry.created_at,
    entry.updated_at,
  ].map(sqlValue);
  return `INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag,
    status, is_public, sort_order, description, created_at, updated_at
  ) SELECT ${values.join(', ')}
  WHERE NOT EXISTS (SELECT 1 FROM entries WHERE id = ${sqlValue(entry.id)});`;
}

function descriptionStatement(entry, marker, chunk) {
  return `UPDATE entries SET description = description || ${sqlValue(chunk)}
  WHERE id = ${sqlValue(entry.id)}
    AND EXISTS (SELECT 1 FROM settings WHERE key = ${sqlValue(marker)});`;
}

function descriptionStatements(entry, marker) {
  if (!entry.description) return [];

  const statements = [];
  let chunk = '';
  let statementBytes = Buffer.byteLength(descriptionStatement(entry, marker, chunk), 'utf8');
  for (const character of entry.description) {
    const characterBytes = Buffer.byteLength(character, 'utf8') + (character === "'" ? 1 : 0);
    if (statementBytes + characterBytes > MAX_SQL_STATEMENT_BYTES) {
      if (!chunk) throw new Error(`Legacy object ${entry.storage_key} has a description that cannot be represented safely`);
      statements.push(descriptionStatement(entry, marker, chunk));
      chunk = character;
      statementBytes = Buffer.byteLength(descriptionStatement(entry, marker, chunk), 'utf8');
    } else {
      chunk += character;
      statementBytes += characterBytes;
    }
  }
  if (chunk) statements.push(descriptionStatement(entry, marker, chunk));
  return statements;
}

export function assertExistingEntries(entries, existingEntries) {
  const expectedById = new Map(entries.map((entry) => [entry.id, entry]));
  const expectedBySibling = new Map(entries.map((entry) => [`${entry.parent_id}\u0000${entry.name}`, entry]));
  const expectedByStorageKey = new Map(entries.filter((entry) => entry.storage_key !== null).map((entry) => [entry.storage_key, entry]));

  for (const existing of existingEntries) {
    const expectedByIdEntry = expectedById.get(existing.id);
    if (expectedByIdEntry) {
      if (existing.storage_key !== expectedByIdEntry.storage_key) {
        throw new Error(`Existing deterministic entry ${existing.id} has an unexpected storage key`);
      }
      continue;
    }

    const sibling = expectedBySibling.get(`${existing.parent_id}\u0000${existing.name}`);
    const storage = existing.storage_key === null ? undefined : expectedByStorageKey.get(existing.storage_key);
    if (sibling || storage) {
      throw new Error(`Existing entries collision prevents migration for ${sibling?.id || storage?.id}`);
    }
  }
}

export function entriesToSql(entries, migrationToken = 'legacy-object-migration') {
  const statements = [];
  const markers = [];
  for (const entry of entries) {
    const marker = markerKey(entry, migrationToken);
    markers.push(marker);
    statements.push(insertStatement(entry));
    statements.push(`INSERT INTO settings (key, value) SELECT ${sqlValue(marker)}, '1' WHERE changes() = 1;`);
  }
  for (const entry of entries) {
    statements.push(...descriptionStatements(entry, markerKey(entry, migrationToken)));
  }
  for (const marker of markers) {
    statements.push(`DELETE FROM settings WHERE key = ${sqlValue(marker)};`);
  }
  return statements.join('\n');
}

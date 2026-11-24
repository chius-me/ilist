import type { Entry } from '../types/entries';

export interface RelativeUploadFile {
  file: File;
  relativePath: string;
}

export interface FolderUploadAdapter {
  createFolder: (parentId: string, name: string) => Promise<Entry>;
  enqueueFiles: (parentId: string, files: File[]) => void;
  existingEntries?: Entry[];
}

function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const collected: FileSystemEntry[] = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        step();
      }, reject);
    };
    step();
  });
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function collectFileSystemEntry(entry: FileSystemEntry, prefix: string, out: RelativeUploadFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    out.push({ file, relativePath });
    return;
  }
  if (entry.isDirectory) {
    const dir = entry as FileSystemDirectoryEntry;
    const nextPrefix = prefix ? `${prefix}/${dir.name}` : dir.name;
    const children = await readAllDirectoryEntries(dir.createReader());
    for (const child of children) {
      await collectFileSystemEntry(child, nextPrefix, out);
    }
  }
}

export function extractRelativeFilesFromFileList(files: FileList | File[]): RelativeUploadFile[] {
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return {
      file,
      relativePath: rel && rel.trim() ? rel : file.name,
    };
  });
}

export async function extractDroppedFiles(dataTransfer: DataTransfer): Promise<{ files: RelativeUploadFile[]; hasDirectory: boolean }> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    return {
      files: extractRelativeFilesFromFileList(dataTransfer.files),
      hasDirectory: false,
    };
  }

  const hasDirectory = entries.some((entry) => entry.isDirectory);
  const collected: RelativeUploadFile[] = [];
  for (const entry of entries) {
    await collectFileSystemEntry(entry, '', collected);
  }
  return { files: collected, hasDirectory };
}

function normalizePathSegments(relativePath: string): string[] {
  return relativePath
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export async function enqueueFolderUpload(
  items: RelativeUploadFile[],
  rootParentId: string,
  adapter: FolderUploadAdapter,
): Promise<{ foldersCreated: number; filesQueued: number }> {
  const folderIds = new Map<string, string>();
  if (adapter.existingEntries) {
    for (const entry of adapter.existingEntries) {
      if (entry.kind === 'folder') {
        folderIds.set(entry.name, entry.id);
      }
    }
  }

  const directoryPaths = new Set<string>();
  const normalizedItems: Array<{ dirPath: string; file: File }> = [];

  for (const item of items) {
    const segments = normalizePathSegments(item.relativePath || item.file.name);
    if (segments.length === 0) continue;
    const dirs = segments.slice(0, -1);
    let prefix = '';
    for (const segment of dirs) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      directoryPaths.add(prefix);
    }
    normalizedItems.push({ dirPath: dirs.join('/'), file: item.file });
  }

  const sortedDirs = Array.from(directoryPaths).sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  let foldersCreated = 0;
  for (const dirPath of sortedDirs) {
    if (folderIds.has(dirPath)) continue;
    const slash = dirPath.lastIndexOf('/');
    const parentPath = slash >= 0 ? dirPath.slice(0, slash) : '';
    const name = slash >= 0 ? dirPath.slice(slash + 1) : dirPath;
    const parentId = parentPath ? folderIds.get(parentPath) ?? rootParentId : rootParentId;
    const created = await adapter.createFolder(parentId, name);
    folderIds.set(dirPath, created.id);
    foldersCreated += 1;
  }

  const grouped = new Map<string, File[]>();
  let filesQueued = 0;
  for (const item of normalizedItems) {
    const targetParentId = item.dirPath ? folderIds.get(item.dirPath) ?? rootParentId : rootParentId;
    const batch = grouped.get(targetParentId);
    if (batch) batch.push(item.file);
    else grouped.set(targetParentId, [item.file]);
    filesQueued += 1;
  }

  for (const [parentId, batch] of grouped) {
    adapter.enqueueFiles(parentId, batch);
  }

  return { foldersCreated, filesQueued };
}

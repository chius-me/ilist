export function uploadFileWithProgress(input: {
  id: string;
  parentId: string;
  file: File;
  signal: AbortSignal;
  onProgress(uploadedBytes: number, totalBytes: number): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ parentId: input.parentId, name: input.file.name });
    xhr.open('PUT', `/api/admin/files/${encodeURIComponent(input.id)}?${query}`);
    xhr.setRequestHeader('content-type', input.file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => input.onProgress(event.loaded, event.total || input.file.size);
    xhr.onerror = () => reject(new Error('Network upload failed'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: { message?: string } };
        reject(new Error(payload.error?.message || `Upload failed with ${xhr.status}`));
      } catch {
        reject(new Error(`Upload failed with ${xhr.status}`));
      }
    };
    input.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(input.file);
  });
}

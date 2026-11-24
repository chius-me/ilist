/** Must stay aligned with `TEXT_PREVIEW_MAX_BYTES` in the Worker file-response security module. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface TextPreviewResult {
  text: string;
  encoding: TextEncoding;
  truncated: boolean;
  totalBytes: number | null;
}

export class PreviewResponseError extends Error {
  constructor(readonly status: number) {
    super(`Preview response ${status}`);
  }
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf('/');
  if (slash < 0) return null;
  const totalPart = header.slice(slash + 1).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(totalPart)) return null;
  const total = Number(totalPart);
  return Number.isSafeInteger(total) ? total : null;
}

function trimTrailingIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  if (end === 0) return bytes;

  // Walk backwards across up to 3 trailing continuation bytes (10xxxxxx) to locate a split sequence.
  let lookback = 0;
  while (lookback < 4 && end - 1 - lookback >= 0) {
    const byte = bytes[end - 1 - lookback]!;
    if ((byte & 0b1000_0000) === 0) {
      return bytes;
    }
    if ((byte & 0b1100_0000) !== 0b1000_0000) {
      const expectedLength =
        (byte & 0b1110_0000) === 0b1100_0000
          ? 2
          : (byte & 0b1111_0000) === 0b1110_0000
            ? 3
            : (byte & 0b1111_1000) === 0b1111_0000
              ? 4
              : 1;
      const actualLength = lookback + 1;
      if (actualLength < expectedLength) {
        end -= actualLength;
      }
      break;
    }
    lookback += 1;
  }
  return end === bytes.byteLength ? bytes : bytes.slice(0, end);
}

export function decodePreviewBytes(bytes: Uint8Array, truncated: boolean): { text: string; encoding: TextEncoding } {
  if (bytes.byteLength >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
  }

  const utf8Candidate = truncated ? trimTrailingIncompleteUtf8(bytes) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(utf8Candidate), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('gb18030', { fatal: false }).decode(bytes), encoding: 'gb18030' };
  }
}

export async function loadTextPreview(url: string, signal?: AbortSignal, entrySize?: number): Promise<TextPreviewResult> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` }, signal });
  if (!response.ok) throw new PreviewResponseError(response.status);

  const rangeTotal = parseContentRangeTotal(response.headers.get('content-range'));
  let bytes: Uint8Array;
  let reachedStreamCap = false;

  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let remaining = TEXT_PREVIEW_MAX_BYTES;
    try {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > remaining) {
          chunks.push(value.slice(0, remaining));
          remaining = 0;
          reachedStreamCap = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        remaining -= value.byteLength;
        if (remaining === 0) {
          await reader.cancel();
        }
      }
    } finally {
      reader.releaseLock();
    }
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const full = new Uint8Array(await response.arrayBuffer());
    if (full.byteLength > TEXT_PREVIEW_MAX_BYTES) {
      bytes = full.slice(0, TEXT_PREVIEW_MAX_BYTES);
      reachedStreamCap = true;
    } else {
      bytes = full;
    }
  }

  const totalBytes = rangeTotal ?? (typeof entrySize === 'number' && Number.isFinite(entrySize) && entrySize >= 0 ? entrySize : null);
  const truncated =
    reachedStreamCap ||
    (totalBytes !== null && totalBytes > bytes.byteLength) ||
    (response.status === 206 && bytes.byteLength >= TEXT_PREVIEW_MAX_BYTES);
  const { text, encoding } = decodePreviewBytes(bytes, truncated);
  return { text, encoding, truncated, totalBytes };
}

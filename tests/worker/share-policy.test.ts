import { describe, expect, it } from 'vitest';
import { canDownloadFromShare, isShareDownloadLimitReached } from '../../src/worker/share-policy';

describe('share policy helpers', () => {
  it('treats null max downloads as unlimited', () => {
    expect(isShareDownloadLimitReached({ maxDownloads: null, downloadCount: 999 })).toBe(false);
    expect(canDownloadFromShare({ allowDownload: true, maxDownloads: null, downloadCount: 999 })).toBe(true);
  });

  it('blocks downloads when the counter reaches the configured max', () => {
    expect(isShareDownloadLimitReached({ maxDownloads: 2, downloadCount: 2 })).toBe(true);
    expect(canDownloadFromShare({ allowDownload: true, maxDownloads: 2, downloadCount: 2 })).toBe(false);
    expect(canDownloadFromShare({ allowDownload: true, maxDownloads: 2, downloadCount: 1 })).toBe(true);
  });

  it('honors allowDownload independently of counters', () => {
    expect(canDownloadFromShare({ allowDownload: false, maxDownloads: null, downloadCount: 0 })).toBe(false);
  });
});

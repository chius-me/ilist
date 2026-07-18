import type { Share } from './types';

/** Whether a share has exhausted its optional download limit. */
export function isShareDownloadLimitReached(share: Pick<Share, 'maxDownloads' | 'downloadCount'>): boolean {
  return share.maxDownloads !== null && share.downloadCount >= share.maxDownloads;
}

/** Whether the next download is still allowed under the share policy. */
export function canDownloadFromShare(share: Pick<Share, 'allowDownload' | 'maxDownloads' | 'downloadCount'>): boolean {
  return share.allowDownload && !isShareDownloadLimitReached(share);
}

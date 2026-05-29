import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useModalFocus } from '../../hooks/useModalFocus';
import type { Mount, MountInput, S3MountConfig } from '../../types/mounts';

interface Props {
  mount: Mount | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: MountInput) => Promise<void> | void;
}

function stringConfig(mount: Mount | null, key: keyof S3MountConfig, fallback = ''): string {
  const value = mount?.config[key];
  return typeof value === 'string' ? value : fallback;
}

function r2Account(endpoint: string): string {
  try { return new URL(endpoint).hostname.split('.')[0] ?? ''; } catch { return ''; }
}

type StorageType = 's3' | 'onedrive' | 'google';

function initialStorageType(mount: Mount | null): StorageType {
  if (mount?.driverType === 'onedrive' || mount?.driverType === 'google') return mount.driverType;
  return 's3';
}

export function MountDialog({ mount, busy, error, onClose, onSubmit }: Props) {
  const { t } = useI18n();
  const nameInput = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: nameInput, onClose });
  const initialEndpoint = stringConfig(mount, 'endpoint');
  const [storageType, setStorageType] = useState<StorageType>(initialStorageType(mount));
  const [name, setName] = useState(mount?.name ?? '');
  const [mountPath, setMountPath] = useState(mount?.mountPath ?? '');
  const [provider, setProvider] = useState(mount?.provider ?? 'cloudflare-r2');
  const [accountId, setAccountId] = useState(r2Account(initialEndpoint));
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [region, setRegion] = useState(stringConfig(mount, 'region', 'auto'));
  const [bucket, setBucket] = useState(stringConfig(mount, 'bucket'));
  const [rootPrefix, setRootPrefix] = useState(stringConfig(mount, 'rootPrefix'));
  const [addressingMode, setAddressingMode] = useState<'path' | 'virtual-hosted'>(stringConfig(mount, 'addressingMode', 'path') === 'virtual-hosted' ? 'virtual-hosted' : 'path');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [rootItemId, setRootItemId] = useState(mount?.rootItemId ?? '');
  const [enabled, setEnabled] = useState(mount?.enabled ?? true);
  const [isPublic, setIsPublic] = useState(mount?.isPublic ?? true);
  const derivedEndpoint = useMemo(() => provider === 'cloudflare-r2' && accountId ? `https://${accountId}.r2.cloudflarestorage.com` : endpoint, [accountId, endpoint, provider]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (storageType === 'google') {
      void onSubmit({
        name, mountPath, driverType: 'google', provider: 'google',
        enabled, isPublic, sortOrder: mount?.sortOrder ?? 0,
        rootItemId: rootItemId.trim() || null,
        config: {},
      });
      return;
    }
    if (storageType === 'onedrive') {
      void onSubmit({
        name, mountPath, driverType: 'onedrive', provider: 'microsoft-onedrive-personal',
        enabled, isPublic, sortOrder: mount?.sortOrder ?? 0,
        config: {},
      });
      return;
    }
    const credentials = accessKeyId || secretAccessKey ? { ...(accessKeyId ? { accessKeyId } : {}), ...(secretAccessKey ? { secretAccessKey } : {}) } : undefined;
    void onSubmit({
      name, mountPath, driverType: 's3', provider, enabled, isPublic, sortOrder: mount?.sortOrder ?? 0,
      config: { endpoint: derivedEndpoint, region, bucket, ...(rootPrefix ? { rootPrefix } : {}), addressingMode },
      ...(credentials ? { credentials } : {}),
    });
  }

  return <div ref={backdrop} className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={onClose}>
    <section className="mountDialog overlaySurface" role="dialog" aria-modal="true" aria-labelledby="mount-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="overlayHeader"><div><h2 id="mount-dialog-title">{mount ? t('mount.editStorage') : t('admin.addStorage')}</h2><p>{storageType === 'onedrive' ? t('mount.oneDriveMount') : storageType === 'google' ? t('mount.googleDriveMount') : t('mount.s3Mount')}</p></div><button className="iconButton" type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X aria-hidden="true" size={18} /></button></header>
      <form onSubmit={submit}>
        <div className="mountFormGrid">
          <label>{t('mount.storageType')}<select value={storageType} disabled={Boolean(mount)} onChange={(event) => setStorageType(event.target.value as StorageType)}><option value="s3">{t('mount.s3Compatible')}</option><option value="onedrive">{t('mount.providerOneDrive')}</option><option value="google">{t('mount.providerGoogleDrive')}</option></select></label>
          <label>{t('mount.displayName')}<input ref={nameInput} value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>{t('mount.mountPath')}<input value={mountPath} onChange={(event) => setMountPath(event.target.value)} placeholder="/archive" required /></label>
          {storageType === 's3' ? <>
            <label>{t('mount.provider')}<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="cloudflare-r2">Cloudflare R2</option><option value="aws-s3">AWS S3</option><option value="backblaze-b2">Backblaze B2</option><option value="custom">{t('mount.customS3')}</option></select></label>
            {provider === 'cloudflare-r2' ? <label>{t('mount.accountId')}<input value={accountId} onChange={(event) => setAccountId(event.target.value)} required /></label> : <label>{t('mount.endpoint')}<input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required /></label>}
            <label>{t('mount.region')}<input value={region} onChange={(event) => setRegion(event.target.value)} required /></label>
            <label>{t('mount.bucket')}<input value={bucket} onChange={(event) => setBucket(event.target.value)} required /></label>
            <label>{t('mount.rootPrefix')}<input value={rootPrefix} onChange={(event) => setRootPrefix(event.target.value)} /></label>
            <label>{t('mount.addressing')}<select value={addressingMode} onChange={(event) => setAddressingMode(event.target.value as 'path' | 'virtual-hosted')}><option value="path">{t('mount.pathStyle')}</option><option value="virtual-hosted">{t('mount.virtualHosted')}</option></select></label>
            <label>{t('mount.accessKeyId')}<input autoComplete="off" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required={!mount} /></label>
            <label>{t('mount.secretAccessKey')}<input type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} required={!mount} placeholder={mount ? t('mount.keepExistingSecret') : ''} /></label>
          </> : <>
            {storageType === 'google' ? <label>{t('mount.rootFolderId')}<input value={rootItemId} onChange={(event) => setRootItemId(event.target.value)} /></label> : null}
            <div className="oneDriveConnectNote">{storageType === 'google' ? t('mount.googleDriveAuthorizationHint') : t('mount.oneDriveAuthorizationHint')}</div>
          </>}
        </div>
        <div className="mountSwitches"><label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t('common.enabled')}</label><label><input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />{t('mount.visibleToGuests')}</label></div>
        {error ? <div className="formError" role="alert">{error}</div> : null}
        <footer><button className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button primary" type="submit" disabled={busy}>{mount ? t('mount.saveChanges') : storageType !== 's3' ? t('mount.createAndConnect') : t('mount.createMount')}</button></footer>
      </form>
    </section>
  </div>;
}

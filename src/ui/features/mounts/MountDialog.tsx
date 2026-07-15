import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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

export function MountDialog({ mount, busy, error, onClose, onSubmit }: Props) {
  const nameInput = useRef<HTMLInputElement>(null);
  const initialEndpoint = stringConfig(mount, 'endpoint');
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
  const [enabled, setEnabled] = useState(mount?.enabled ?? true);
  const [isPublic, setIsPublic] = useState(mount?.isPublic ?? true);
  const derivedEndpoint = useMemo(() => provider === 'cloudflare-r2' && accountId ? `https://${accountId}.r2.cloudflarestorage.com` : endpoint, [accountId, endpoint, provider]);

  useEffect(() => {
    nameInput.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const credentials = accessKeyId || secretAccessKey ? { ...(accessKeyId ? { accessKeyId } : {}), ...(secretAccessKey ? { secretAccessKey } : {}) } : undefined;
    void onSubmit({
      name, mountPath, driverType: 's3', provider, enabled, isPublic, sortOrder: mount?.sortOrder ?? 0,
      config: { endpoint: derivedEndpoint, region, bucket, ...(rootPrefix ? { rootPrefix } : {}), addressingMode },
      ...(credentials ? { credentials } : {}),
    });
  }

  return <div className="dialogBackdrop" role="presentation" onMouseDown={onClose}>
    <section className="mountDialog" role="dialog" aria-modal="true" aria-labelledby="mount-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="mount-dialog-title">{mount ? 'Edit storage' : 'Add storage'}</h2><p>S3-compatible mount</p></div><button className="iconButton" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <form onSubmit={submit}>
        <div className="mountFormGrid">
          <label>Display name<input ref={nameInput} value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>Mount path<input value={mountPath} onChange={(event) => setMountPath(event.target.value)} placeholder="/archive" required /></label>
          <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="cloudflare-r2">Cloudflare R2</option><option value="aws-s3">AWS S3</option><option value="backblaze-b2">Backblaze B2</option><option value="custom">Custom S3</option></select></label>
          {provider === 'cloudflare-r2' ? <label>Account ID<input value={accountId} onChange={(event) => setAccountId(event.target.value)} required /></label> : <label>Endpoint<input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required /></label>}
          <label>Region<input value={region} onChange={(event) => setRegion(event.target.value)} required /></label>
          <label>Bucket<input value={bucket} onChange={(event) => setBucket(event.target.value)} required /></label>
          <label>Root prefix<input value={rootPrefix} onChange={(event) => setRootPrefix(event.target.value)} /></label>
          <label>Addressing<select value={addressingMode} onChange={(event) => setAddressingMode(event.target.value as 'path' | 'virtual-hosted')}><option value="path">Path style</option><option value="virtual-hosted">Virtual hosted</option></select></label>
          <label>Access Key ID<input autoComplete="off" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required={!mount} /></label>
          <label>Secret Access Key<input type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} required={!mount} placeholder={mount ? 'Leave blank to keep existing' : ''} /></label>
        </div>
        <div className="mountSwitches"><label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enabled</label><label><input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />Visible to guests</label></div>
        {error ? <div className="formError" role="alert">{error}</div> : null}
        <footer><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{mount ? 'Save changes' : 'Create mount'}</button></footer>
      </form>
    </section>
  </div>;
}

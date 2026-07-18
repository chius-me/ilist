import { LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

export function SharePasswordForm({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit(password: string): void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  function submit(event: FormEvent) { event.preventDefault(); onSubmit(password); }
  return <main className="shareStatePage" id="shared-content"><form className="sharePasswordForm overlaySurface" onSubmit={submit}><LockKeyhole aria-hidden="true" size={28} /><h1>{t('publicShare.protectedTitle')}</h1><p>{t('publicShare.protectedHint')}</p><label>{t('share.password')}<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <div className="formError" role="alert">{error}</div> : null}<button className="button primary" type="submit" disabled={busy}>{t('publicShare.open')}</button></form></main>;
}

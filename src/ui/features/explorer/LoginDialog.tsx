import { LogIn, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';

export function LoginDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (username: string, password: string) => void | Promise<void>;
}) {
  const { t } = useFeedbackI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setUsername('');
      setPassword('');
      return;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    usernameInput.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      previous?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit(username, password);
  }

  return (
    <div className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={onClose}>
      <section className="loginDialog overlaySurface" role="dialog" aria-modal="true" aria-labelledby="login-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialogHeader overlayHeader">
          <h2 id="login-title">{t('nav.signIn')}</h2>
          <button className="iconButton" type="button" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}><X aria-hidden="true" size={17} /></button>
        </header>
        <form className="overlayBody" onSubmit={submit}>
          <label>{t('login.username')}<input ref={usernameInput} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>{t('login.password')}<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {error ? <p className="formError" role="alert">{error}</p> : null}
          <footer className="dialogButtons overlayFooter"><button className="button primary" type="submit" disabled={busy}><LogIn aria-hidden="true" size={17} />{busy ? t('login.signingIn') : t('login.signIn')}</button></footer>
        </form>
      </section>
    </div>
  );
}

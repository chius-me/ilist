import { LogIn, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!open) {
      setUsername('');
      setPassword('');
    }
  }, [open]);

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit(username, password);
  }

  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="loginDialog" role="dialog" aria-modal="true" aria-labelledby="login-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialogHeader">
          <h2 id="login-title">Admin sign in</h2>
          <button className="iconButton" type="button" onClick={onClose} title="Close" aria-label="Close"><X aria-hidden="true" size={17} /></button>
        </div>
        <form onSubmit={submit}>
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {error ? <p className="formError" role="alert">{error}</p> : null}
          <button className="button primary" type="submit" disabled={busy}><LogIn aria-hidden="true" size={17} />{busy ? 'Signing in' : 'Sign in'}</button>
        </form>
      </section>
    </div>
  );
}

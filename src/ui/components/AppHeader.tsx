import { Folder, Languages, LogIn, LogOut, Moon, Settings, Sun } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { usePreferences } from '../preferences/PreferencesProvider';

interface AppHeaderProps {
  admin: boolean;
  username?: string;
  onHome(): void;
  onStorage(): void;
  onSignIn(): void;
  onSignOut(): void | Promise<void>;
}

export function AppHeader({ admin, username, onHome, onStorage, onSignIn, onSignOut }: AppHeaderProps) {
  const { preferences, updatePreferences } = usePreferences();
  const { locale, t } = useI18n();
  const dark = preferences.theme === 'dark';

  const changeLanguage = () => {
    updatePreferences({ locale: locale === 'en' ? 'zh-CN' : 'en' });
  };

  const changeTheme = () => {
    updatePreferences({ theme: dark ? 'light' : 'dark' });
  };

  const signOut = async () => {
    try {
      await onSignOut();
    } catch {
      // The session hook retains the error while the shell remains usable.
    }
  };

  return (
    <header className="siteHeader">
      <div className="headerInner">
        <button className="siteName" type="button" onClick={onHome} aria-label="Open ilist root" title="Open ilist root">
          <Folder aria-hidden="true" size={19} />
          <span>ilist</span>
        </button>
        <div className="headerControls">
          <button className="headerControl languageControl" type="button" onClick={changeLanguage} aria-label="Change language" title="Change language">
            <Languages aria-hidden="true" size={17} />
            <span>{preferences.locale === 'en' ? 'EN' : '中文'}</span>
          </button>
          <button className="headerControl" type="button" onClick={changeTheme} aria-label="Change theme" title="Change theme">
            {dark ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
          </button>
          {admin ? (
            <>
              <button className="headerControl" type="button" onClick={onStorage} aria-label={t('nav.storage')} title={t('nav.storage')}>
                <Settings aria-hidden="true" size={17} />
              </button>
              <span className="sessionIndicator">{username || 'Admin'}</span>
              <button className="headerControl" type="button" onClick={() => void signOut()} aria-label={t('nav.signOut')} title={t('nav.signOut')}>
                <LogOut aria-hidden="true" size={17} />
              </button>
            </>
          ) : (
            <button className="headerControl" type="button" onClick={onSignIn} aria-label={t('nav.signIn')} title={t('nav.signIn')}>
              <LogIn aria-hidden="true" size={17} />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

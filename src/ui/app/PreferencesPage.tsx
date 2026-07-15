import { RotateCcw } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { defaultPreferences, type ExplorerViewPreference, type Locale, type ThemePreference } from '../preferences/preferences';
import { usePreferences } from '../preferences/PreferencesProvider';

export function PreferencesPage() {
  const { t } = useI18n();
  const { preferences, updatePreferences } = usePreferences();

  function reset() {
    const defaults = defaultPreferences();
    updatePreferences({ locale: defaults.locale, theme: defaults.theme, defaultView: defaults.defaultView });
  }

  return (
    <main className="preferencesPage" id="appearance-preferences">
      <header className="adminPageHeader">
        <div><h1>{t('admin.appearanceTitle')}</h1><p>{t('admin.appearanceDescription')}</p></div>
        <button className="button" type="button" onClick={reset}><RotateCcw aria-hidden="true" size={16} />{t('preference.reset')}</button>
      </header>
      <form className="preferencesForm">
        <label>
          <span><strong>{t('preference.language')}</strong><small>{t('preference.languageHint')}</small></span>
          <select aria-label={t('preference.language')} value={preferences.locale} onChange={(event) => updatePreferences({ locale: event.target.value as Locale })}>
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        <label>
          <span><strong>{t('preference.theme')}</strong><small>{t('preference.themeHint')}</small></span>
          <select aria-label={t('preference.theme')} value={preferences.theme} onChange={(event) => updatePreferences({ theme: event.target.value as ThemePreference })}>
            <option value="system">{t('preference.system')}</option>
            <option value="light">{t('preference.light')}</option>
            <option value="dark">{t('preference.dark')}</option>
          </select>
        </label>
        <label>
          <span><strong>{t('preference.defaultView')}</strong><small>{t('preference.defaultViewHint')}</small></span>
          <select aria-label={t('preference.defaultView')} value={preferences.defaultView} onChange={(event) => updatePreferences({ defaultView: event.target.value as ExplorerViewPreference })}>
            <option value="list">{t('preference.list')}</option>
            <option value="grid">{t('preference.grid')}</option>
          </select>
        </label>
      </form>
    </main>
  );
}

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { useI18n } from '../../src/ui/i18n/I18nProvider';
import { en, zhCN } from '../../src/ui/i18n/messages';
import { usePreferences } from '../../src/ui/preferences/PreferencesProvider';
import { readPreferences, writePreferences } from '../../src/ui/preferences/preferences';

function Probe() {
  const { preferences, updatePreferences } = usePreferences();
  const { t } = useI18n();

  return (
    <>
      <span>{t('nav.files')}</span>
      <span data-testid="theme">{preferences.theme}</span>
      <button onClick={() => updatePreferences({ locale: 'zh-CN', theme: 'dark' })}>change</button>
    </>
  );
}

describe('preferences and localization', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('data-theme');
  });

  it('keeps dictionaries identical and persists valid changes', async () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    render(<AppProviders><Probe /></AppProviders>);

    await userEvent.click(screen.getByRole('button', { name: 'change' }));

    expect(screen.getByText('文件')).toBeVisible();
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(JSON.parse(window.localStorage.getItem('ilist.ui.preferences')!)).toMatchObject({
      version: 1,
      locale: 'zh-CN',
      theme: 'dark',
    });
  });

  it('falls back when saved preferences are invalid', () => {
    window.localStorage.setItem('ilist.ui.preferences', '{"version":99,"locale":"bad"}');

    render(<AppProviders><Probe /></AppProviders>);

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });

  it('falls back safely when storage operations fail', () => {
    const failingStorage: Storage = {
      length: 0,
      clear: () => { throw new Error('unavailable'); },
      getItem: () => { throw new Error('unavailable'); },
      key: () => null,
      removeItem: () => { throw new Error('unavailable'); },
      setItem: () => { throw new Error('unavailable'); },
    };

    const preferences = readPreferences(failingStorage);

    expect(preferences).toMatchObject({ version: 1, theme: 'system', defaultView: 'list' });
    expect(() => writePreferences(preferences, failingStorage)).not.toThrow();
  });
});

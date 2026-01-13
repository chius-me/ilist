import type { PropsWithChildren } from 'react';
import { I18nProvider } from '../i18n/I18nProvider';
import { PreferencesProvider } from '../preferences/PreferencesProvider';

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <PreferencesProvider>
      <I18nProvider>{children}</I18nProvider>
    </PreferencesProvider>
  );
}

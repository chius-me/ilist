import { createContext, type PropsWithChildren, useContext, useEffect, useState } from 'react';
import {
  readPreferences,
  type UiPreferences,
  writePreferences,
} from './preferences';

interface PreferencesContextValue {
  preferences: UiPreferences;
  resolvedTheme: 'light' | 'dark';
  updatePreferences: (patch: Partial<Omit<UiPreferences, 'version'>>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolvedTheme = preferences.theme === 'system'
    ? (systemDark ? 'dark' : 'light')
    : preferences.theme;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.lang = preferences.locale;
    document.documentElement.dataset.theme = resolvedTheme;
    writePreferences(preferences);
  }, [preferences, resolvedTheme]);

  const updatePreferences = (patch: Partial<Omit<UiPreferences, 'version'>>) => {
    setPreferences((current) => ({ ...current, ...patch, version: 1 }));
  };

  return (
    <PreferencesContext.Provider value={{ preferences, resolvedTheme, updatePreferences }}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences must be used within PreferencesProvider');
  return value;
}

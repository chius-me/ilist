export const PREFERENCES_KEY = 'ilist.ui.preferences';

export type Locale = 'en' | 'zh-CN';
export type ThemePreference = 'system' | 'light' | 'dark';
export type ExplorerViewPreference = 'list' | 'grid';

export interface UiPreferences {
  version: 1;
  locale: Locale;
  theme: ThemePreference;
  defaultView: ExplorerViewPreference;
}

export function defaultPreferences(): UiPreferences {
  return {
    version: 1,
    locale: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
    theme: 'system',
    defaultView: 'list',
  };
}

export function readPreferences(storage: Storage = window.localStorage): UiPreferences {
  try {
    const value = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? 'null') as Partial<UiPreferences> | null;
    if (
      value?.version !== 1
      || !['en', 'zh-CN'].includes(value.locale ?? '')
      || !['system', 'light', 'dark'].includes(value.theme ?? '')
      || !['list', 'grid'].includes(value.defaultView ?? '')
    ) {
      return defaultPreferences();
    }
    return value as UiPreferences;
  } catch {
    return defaultPreferences();
  }
}

export function writePreferences(value: UiPreferences, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    // Browser storage can be unavailable.
  }
}

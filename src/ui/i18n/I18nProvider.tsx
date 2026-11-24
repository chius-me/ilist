import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react';
import { usePreferences } from '../preferences/PreferencesProvider';
import type { Locale } from '../preferences/preferences';
import { en, type MessageKey } from './messages/en';

type MessageValues = Record<string, string | number>;
type MessageDictionary = Record<MessageKey, string>;

interface I18nContextValue {
  locale: Locale;
  t: (key: MessageKey, values?: MessageValues) => string;
  formatBytes: (bytes: number) => string;
  formatDate: (value: Date | number | string) => string;
  formatNumber: (value: number) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);
let cachedZhMessages: MessageDictionary | null = null;

export function useOptionalI18n(): I18nContextValue | null {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: PropsWithChildren) {
  const { preferences } = usePreferences();
  const { locale } = preferences;
  const [zhMessages, setZhMessages] = useState<MessageDictionary | null>(() => cachedZhMessages);

  useEffect(() => {
    if (locale !== 'zh-CN' || cachedZhMessages) return;
    let active = true;
    void import('./messages/zh-CN').then((module) => {
      cachedZhMessages = module.zhCN;
      if (active) setZhMessages(module.zhCN);
    });
    return () => { active = false; };
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const messages: MessageDictionary = locale === 'zh-CN' ? (zhMessages ?? en) : en;
    const numberFormatter = new Intl.NumberFormat(locale);
    const dateFormatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    const formatNumber = (number: number) => numberFormatter.format(number);

    return {
      locale,
      t: (key, values = {}) => messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
        const replacement = values[name];
        if (replacement === undefined) return placeholder;
        return typeof replacement === 'number' ? formatNumber(replacement) : replacement;
      }),
      formatBytes: (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${locale === 'zh-CN' ? '字节' : 'bytes'}`;
        const units = locale === 'zh-CN'
          ? ['字节', 'KB', 'MB', 'GB', 'TB']
          : ['bytes', 'KB', 'MB', 'GB', 'TB'];
        const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const amount = bytes / (1024 ** unitIndex);
        const formatted = new Intl.NumberFormat(locale, {
          maximumFractionDigits: unitIndex === 0 ? 0 : 1,
        }).format(amount);
        return `${formatted} ${units[unitIndex]}`;
      },
      formatDate: (date) => dateFormatter.format(new Date(date)),
      formatNumber,
    };
  }, [locale, zhMessages]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}

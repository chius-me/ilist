import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { en, type MessageKey } from '../i18n/messages';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  message: string;
}

type MessageValues = Record<string, string | number>;

export function useFeedbackI18n(): ReturnType<typeof useI18n> {
  try {
    return useI18n();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'useI18n must be used within I18nProvider') throw error;
    const t = (key: MessageKey, values: MessageValues = {}) => en[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const replacement = values[name];
      return replacement === undefined ? placeholder : String(replacement);
    });
    return {
      locale: 'en',
      t,
      formatBytes: (bytes) => `${bytes} bytes`,
      formatDate: (value) => new Intl.DateTimeFormat('en').format(new Date(value)),
      formatNumber: (value) => new Intl.NumberFormat('en').format(value),
    };
  }
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss(id: string): void }) {
  const { t } = useFeedbackI18n();
  useEffect(() => {
    if (toast.tone === 'error') return;
    const timer = window.setTimeout(() => onDismiss(toast.id), 5000);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.tone]);
  const Icon = toast.tone === 'success' ? CircleCheck : toast.tone === 'error' ? CircleAlert : Info;
  return (
    <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" size={18} />
      <span>{toast.message}</span>
      <button type="button" onClick={() => onDismiss(toast.id)} aria-label={t('feedback.dismiss')} title={t('feedback.dismiss')}><X aria-hidden="true" size={16} /></button>
    </div>
  );
}

export function ToastRegion({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss(id: string): void }) {
  const { t } = useFeedbackI18n();
  return (
    <section className="toastRegion" role="region" aria-label={t('feedback.notifications')} aria-live="polite" aria-relevant="additions removals">
      {toasts.slice(-4).map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />)}
    </section>
  );
}

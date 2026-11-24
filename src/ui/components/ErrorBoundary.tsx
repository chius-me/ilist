import { CircleAlert, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react';
import { useFeedbackI18n } from './ToastRegion';

interface ErrorBoundaryProps extends PropsWithChildren {
  title?: string;
  hint?: string;
  reloadLabel?: string;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const title = this.props.title ?? 'Something went wrong';
    const hint = this.props.hint ?? 'Reload the page to recover.';
    const reloadLabel = this.props.reloadLabel ?? 'Reload';
    return (
      <main className="errorState" role="alert">
        <CircleAlert aria-hidden="true" size={32} />
        <strong>{title}</strong>
        <span>{hint}</span>
        <button className="button" type="button" onClick={() => window.location.reload()}>
          <RefreshCw aria-hidden="true" size={16} />
          {reloadLabel}
        </button>
      </main>
    );
  }
}

export function LocalizedErrorBoundary({ children }: PropsWithChildren) {
  const { t } = useFeedbackI18n();
  return (
    <ErrorBoundary
      title={t('error.boundaryTitle')}
      hint={t('error.boundaryHint')}
      reloadLabel={t('action.reload')}
    >
      {children}
    </ErrorBoundary>
  );
}

import { FolderOpen, SearchX } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';

export function EmptyState({ query, admin }: { query: string; admin: boolean }) {
  const { t } = useI18n();
  const searching = Boolean(query.trim());
  return (
    <div className="emptyState" role="status">
      {searching ? <SearchX aria-hidden="true" size={32} /> : <FolderOpen aria-hidden="true" size={32} />}
      <strong>{searching ? t('state.noResults') : t('state.empty')}</strong>
      <span>{searching ? 'Try a different name or clear the search.' : admin ? 'Upload files or create a folder to get started.' : 'Files shared here will appear in this folder.'}</span>
    </div>
  );
}

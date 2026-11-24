import { ChevronRight, Home } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import type { Breadcrumb } from '../../types/entries';

export function Breadcrumbs({ items, onOpen }: { items: Breadcrumb[]; onOpen: (path: string) => void }) {
  const { t } = useI18n();
  return (
    <nav className="breadcrumbs pathBar" aria-label={t('explorer.path')}>
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;
        return (
          <span className="breadcrumbItem" key={item.id}>
            {index > 0 ? <ChevronRight aria-hidden="true" size={15} /> : null}
            {index === 0 ? (
              <a
                href={item.path}
                aria-label={t('explorer.pathHome')}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  onOpen(item.path);
                }}
              >
                <Home aria-hidden="true" size={15} />
              </a>
            ) : (
              <a
                href={item.path}
                title={item.path}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  onOpen(item.path);
                }}
              >
                <span>{item.name}</span>
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

import { ChevronRight, Home } from 'lucide-react';
import type { Breadcrumb } from '../../types/entries';

export function Breadcrumbs({ items, onOpen }: { items: Breadcrumb[]; onOpen: (path: string) => void }) {
  return (
    <nav className="breadcrumbs pathBar" aria-label="Path">
      {items.map((item, index) => (
        <span className="breadcrumbItem" key={item.id}>
          {index > 0 ? <ChevronRight aria-hidden="true" size={15} /> : null}
          <button type="button" onClick={() => onOpen(item.path)} title={item.path}>
            {index === 0 ? <Home aria-hidden="true" size={15} /> : null}
            <span>{item.name || 'ilist'}</span>
          </button>
        </span>
      ))}
    </nav>
  );
}

import { Eye, EyeOff, FolderInput, Trash2, X } from 'lucide-react';

export function SelectionToolbar({ count, pending, onMove, onPublish, onHide, onDelete, onClear }: {
  count: number;
  pending: boolean;
  onMove: () => void;
  onPublish: () => void;
  onHide: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return <section className="selectionToolbar" aria-label="Selected file actions">
    <strong>{count} selected</strong>
    <div className="selectionActions">
      <button className="button" type="button" onClick={onMove} disabled={pending}><FolderInput aria-hidden="true" size={16} />Move</button>
      <button className="button" type="button" onClick={onPublish} disabled={pending}><Eye aria-hidden="true" size={16} />Publish selected</button>
      <button className="button" type="button" onClick={onHide} disabled={pending}><EyeOff aria-hidden="true" size={16} />Hide selected</button>
      <button className="button danger" type="button" onClick={onDelete} disabled={pending}><Trash2 aria-hidden="true" size={16} />Delete</button>
      <button className="iconButton" type="button" onClick={onClear} disabled={pending} aria-label="Clear selection" title="Clear selection"><X aria-hidden="true" size={17} /></button>
    </div>
  </section>;
}

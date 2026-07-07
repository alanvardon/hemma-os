import { type ReactNode, type RefObject } from 'react'

// Shared drop-zone shell for the CSV/statement imports (Bolånekoll, Månadsavslut):
// the drag-over/leave/drop wiring, click-to-browse, the hidden <input> and the
// upload icon. Callers supply the lead/hint copy as children and decide what to
// do with the picked files via onFiles (drop and browse both route through it).
// Styling stays per-tool: the element renders inside each route's scoped root,
// so `.dropzone`/`.is-drag`/`.dropzone-icon` resolve there unchanged.
export default function FileDropzone({ isDragging, onDragChange, inputRef, onFiles, accept, multiple, children }: {
  isDragging: boolean
  onDragChange: (v: boolean) => void
  inputRef: RefObject<HTMLInputElement | null>
  onFiles: (files: FileList) => void
  accept: string
  multiple?: boolean
  children: ReactNode
}) {
  return (
    <div className={'dropzone' + (isDragging ? ' is-drag' : '')}
      onDragOver={e => { e.preventDefault(); onDragChange(true) }}
      onDragLeave={() => onDragChange(false)}
      onDrop={e => { e.preventDefault(); onDragChange(false); onFiles(e.dataTransfer.files) }}
      onClick={() => inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept={accept} hidden multiple={multiple} onChange={e => e.target.files && onFiles(e.target.files)} />
      <div className="dropzone-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></svg>
      </div>
      {children}
    </div>
  )
}

import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { File as FileIcon, GripVertical, ImagePlus, Paperclip, Plus, Type, X } from 'lucide-react';
import { MAX_ATTACHMENT_BYTES } from '../lib/api';

// Compose-time block. `attachmentId` is set once a photo/file is uploaded (or
// was already an existing attachment when editing); `file` (plus, for photos,
// a local blob: `previewUrl`) carries a not-yet-uploaded one. Never both unset.
export type ComposeBlock =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; attachmentId: string | null; file: File | null; previewUrl: string }
  | { id: string; kind: 'file'; attachmentId: string | null; file: File | null; filename: string; mimeType: string; sizeBytes: number };

export function newTextBlock(text = ''): ComposeBlock {
  return { id: crypto.randomUUID(), kind: 'text', text };
}

interface ContentEditorProps {
  blocks: ComposeBlock[];
  onChange: (blocks: ComposeBlock[]) => void;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Consecutive blocks of the same kind form one drag/reorder unit. Photos
// render as a horizontal, wrapping strip (a run of photos reads as a
// gallery); files render as a vertical list (filenames need room to read).
type Group =
  | { kind: 'text'; block: Extract<ComposeBlock, { kind: 'text' }> }
  | { kind: 'images'; blocks: Extract<ComposeBlock, { kind: 'image' }>[] }
  | { kind: 'files'; blocks: Extract<ComposeBlock, { kind: 'file' }>[] };

function groupBlocks(blocks: ComposeBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      groups.push({ kind: 'text', block });
    } else if (block.kind === 'image') {
      const last = groups[groups.length - 1];
      if (last?.kind === 'images') last.blocks.push(block);
      else groups.push({ kind: 'images', blocks: [block] });
    } else {
      const last = groups[groups.length - 1];
      if (last?.kind === 'files') last.blocks.push(block);
      else groups.push({ kind: 'files', blocks: [block] });
    }
  }
  return groups;
}

function sizeFiltered(files: File[]): { ok: File[]; error: string | null } {
  const tooBig = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
  const ok = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
  return { ok, error: tooBig.length > 0 ? `${tooBig.map((f) => f.name).join(', ')} exceeds the 20MB limit.` : null };
}

function toImageBlock(f: File): ComposeBlock {
  return { id: crypto.randomUUID(), kind: 'image', attachmentId: null, file: f, previewUrl: URL.createObjectURL(f) };
}
function toFileBlock(f: File): ComposeBlock {
  return { id: crypto.randomUUID(), kind: 'file', attachmentId: null, file: f, filename: f.name, mimeType: f.type || 'application/octet-stream', sizeBytes: f.size };
}

// Explicit "Photo" insert: only accepts images (mismatched picks are dropped
// with an error) -- deliberately chosen to render inline, not as a file row.
function buildImageBlocks(files: File[]): { blocks: ComposeBlock[]; error: string | null } {
  const images = files.filter((f) => f.type.startsWith('image/'));
  const { ok, error } = sizeFiltered(images);
  return { blocks: ok.map(toImageBlock), error: images.length < files.length ? 'Only image files can be added here.' : error };
}
// Explicit "File" insert: always a file row, even for an image -- if they
// wanted it inline they'd have used Photo.
function buildFileBlocks(files: File[]): { blocks: ComposeBlock[]; error: string | null } {
  const { ok, error } = sizeFiltered(files);
  return { blocks: ok.map(toFileBlock), error };
}
// Paste/drag (no explicit type choice): auto-detect per file.
function buildAutoBlocks(files: File[]): { blocks: ComposeBlock[]; error: string | null } {
  const { ok, error } = sizeFiltered(files);
  return { blocks: ok.map((f) => (f.type.startsWith('image/') ? toImageBlock(f) : toFileBlock(f))), error };
}

// Notion-lite canvas: an ordered sequence of text blocks, inline photos, and
// generic file attachments -- nothing else (no headings/lists/tables). A "+"
// sits at every gap (including before the first block and after the last) so
// any block can be inserted at that exact spot, not just appended. Each
// block/row-group has a drag handle to reorder.
export function ContentEditor({ blocks, onChange }: ContentEditorProps) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingInsert = useRef<{ index: number; mode: 'image' | 'file' }>({ index: 0, mode: 'file' });

  function updateText(id: string, text: string) {
    onChange(blocks.map((b) => (b.id === id ? { ...b, text } : b)));
  }

  function removeBlock(id: string) {
    const block = blocks.find((b) => b.id === id);
    if (block?.kind === 'image' && block.previewUrl.startsWith('blob:')) URL.revokeObjectURL(block.previewUrl);
    onChange(blocks.filter((b) => b.id !== id));
  }

  function spliceIn(index: number, newBlocks: ComposeBlock[]) {
    onChange([...blocks.slice(0, index), ...newBlocks, ...blocks.slice(index)]);
  }

  function insertTextAt(index: number) {
    spliceIn(index, [newTextBlock()]);
  }

  function insertBuiltAt(index: number, files: File[], builder: (files: File[]) => { blocks: ComposeBlock[]; error: string | null }) {
    const { blocks: built, error } = builder(files);
    setFileError(error);
    if (built.length > 0) spliceIn(index, built);
  }

  function requestImagesAt(index: number) {
    pendingInsert.current = { index, mode: 'image' };
    if (fileInputRef.current) fileInputRef.current.accept = 'image/*';
    fileInputRef.current?.click();
  }

  function requestFilesAt(index: number) {
    pendingInsert.current = { index, mode: 'file' };
    if (fileInputRef.current) fileInputRef.current.accept = '';
    fileInputRef.current?.click();
  }

  function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    const { index, mode } = pendingInsert.current;
    insertBuiltAt(index, Array.from(e.target.files ?? []), mode === 'image' ? buildImageBlocks : buildFileBlocks);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    // .files (not .items): a single pasted screenshot often shows up as
    // multiple .items entries (e.g. macOS offers both a PNG and a TIFF
    // representation of the same image), which double-inserted it. .files is
    // the browser's already-deduplicated file list for the paste.
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) insertBuiltAt(blocks.length, files, buildAutoBlocks);
  }

  function handleDrop(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (dragFrom !== null) return; // this is a block-reorder drop, handled by the group's own onDrop
    insertBuiltAt(blocks.length, Array.from(e.dataTransfer.files ?? []), buildAutoBlocks);
  }

  function moveGroup(from: number, to: number) {
    if (from === to) return;
    const groups = groupBlocks(blocks);
    const reordered = [...groups];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    onChange(reordered.flatMap((g): ComposeBlock[] => (g.kind === 'text' ? [g.block] : g.blocks)));
  }

  const groups = groupBlocks(blocks);
  let cursor = 0;
  const gapIndexes: number[] = [0];
  for (const group of groups) {
    cursor += group.kind === 'text' ? 1 : group.blocks.length;
    gapIndexes.push(cursor);
  }

  return (
    <div
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="flex flex-col rounded-md border border-slate-300 p-2"
    >
      <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={handleFileInput} />

      <InsertGap index={gapIndexes[0]} onInsertText={insertTextAt} onInsertImages={requestImagesAt} onInsertFiles={requestFilesAt} />

      {groups.length === 0 ? <p className="py-4 text-center text-xs text-slate-400">Click + to write, add a photo, or attach a file.</p> : null}

      {groups.map((group, gi) => (
        <div key={group.kind === 'text' ? group.block.id : group.blocks[0].id}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(gi);
            }}
            onDragLeave={() => setDragOver((d) => (d === gi ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation(); // this is a reorder drop, not a file drop -- don't let the container's onDrop also fire
              setDragOver(null);
              if (dragFrom !== null) moveGroup(dragFrom, gi);
              setDragFrom(null);
            }}
            className={`group flex items-start gap-1 rounded ${dragOver === gi && dragFrom !== null && dragFrom !== gi ? 'bg-blue-50 ring-1 ring-blue-300' : ''}`}
          >
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(gi));
                setDragFrom(gi);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              aria-label="Drag to reorder"
              title="Drag to reorder"
              className="mt-1 shrink-0 cursor-grab rounded p-0.5 text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-500 active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              {group.kind === 'text' ? (
                <div className="relative">
                  <textarea
                    value={group.block.text}
                    onChange={(e) => updateText(group.block.id, e.target.value)}
                    placeholder="Write something…"
                    rows={3}
                    className="w-full resize-y rounded-md border-none px-1 py-1 text-sm text-slate-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => removeBlock(group.block.id)}
                    aria-label="Remove text block"
                    className="absolute right-1 top-1 rounded p-0.5 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-red-700 group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ) : group.kind === 'images' ? (
                <div className="flex flex-wrap gap-2 py-1">
                  {group.blocks.map((block) => (
                    <div key={block.id} className="relative">
                      <img src={block.previewUrl} alt="" className="h-28 w-28 rounded-md object-cover" />
                      <button
                        type="button"
                        onClick={() => removeBlock(block.id)}
                        aria-label="Remove photo"
                        className="absolute right-1 top-1 rounded-full bg-slate-900/60 p-1 text-white hover:bg-slate-900/80"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-1 py-1">
                  {group.blocks.map((block) => (
                    <div key={block.id} className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm">
                      <FileIcon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-slate-700">{block.filename}</span>
                      <span className="shrink-0 text-xs text-slate-400">{formatSize(block.sizeBytes)}</span>
                      <button
                        type="button"
                        onClick={() => removeBlock(block.id)}
                        aria-label="Remove file"
                        className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <InsertGap index={gapIndexes[gi + 1]} onInsertText={insertTextAt} onInsertImages={requestImagesAt} onInsertFiles={requestFilesAt} />
        </div>
      ))}

      {fileError ? (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {fileError}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-slate-400">Paste or drag a photo/file in anywhere, or use + to place one exactly.</p>
    </div>
  );
}

interface InsertGapProps {
  index: number;
  onInsertText: (index: number) => void;
  onInsertImages: (index: number) => void;
  onInsertFiles: (index: number) => void;
}

// The "+" between every pair of blocks (and before the first / after the
// last): click inserts a text block immediately; hover past ~100ms instead
// expands into an explicit Text/Photo/File choice, so a quick click stays fast.
function InsertGap({ index, onInsertText, onInsertImages, onInsertFiles }: InsertGapProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  function clearTimer() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  return (
    <div
      className="flex h-4 items-center justify-center"
      onMouseEnter={() => {
        timer.current = window.setTimeout(() => setOpen(true), 100);
      }}
      onMouseLeave={() => {
        clearTimer();
        setOpen(false);
      }}
    >
      {open ? (
        <div className="flex items-center gap-0.5 rounded-full border border-slate-300 bg-white px-1 py-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onInsertText(index);
            }}
            aria-label="Insert a text block here"
            title="Text"
            className="rounded-full p-1 text-slate-500 hover:bg-slate-100"
          >
            <Type className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onInsertImages(index);
            }}
            aria-label="Insert a photo here"
            title="Photo"
            className="rounded-full p-1 text-slate-500 hover:bg-slate-100"
          >
            <ImagePlus className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onInsertFiles(index);
            }}
            aria-label="Attach a file here"
            title="File"
            className="rounded-full p-1 text-slate-500 hover:bg-slate-100"
          >
            <Paperclip className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            clearTimer();
            onInsertText(index);
          }}
          aria-label="Insert a text block here"
          className="rounded-full p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

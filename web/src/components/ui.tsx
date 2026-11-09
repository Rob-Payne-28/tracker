import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Person, StoryType } from '../api';
import { cx } from '../util';

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const withMentions = text.replace(/(^|[^\w@`])@([a-z0-9_]+)/gi, '$1<span class="mention">@$2</span>');
    const withRefs = withMentions.replace(/(^|[\s(])#(\d+)\b/g, '$1<a class="story-ref" href="#story-$2">#$2</a>');
    return DOMPurify.sanitize(marked.parse(withRefs, { async: false }) as string, { ADD_ATTR: ['target'] });
  }, [text]);
  return <div className={cx('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Avatar({ person, size = 22, title }: { person?: Pick<Person, 'initials' | 'name'> | null; size?: number; title?: string }) {
  if (!person) return null;
  let h = 0;
  for (const c of person.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      className="avatar"
      title={title ?? person.name}
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${h} 45% 42%)` }}
    >
      {person.initials}
    </span>
  );
}

export function TypeIcon({ type, size = 14 }: { type: StoryType; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-label': type, role: 'img' } as const;
  switch (type) {
    case 'feature':
      return (
        <svg {...common} className="type-icon feature">
          <title>Feature</title>
          <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" fill="#e8b622" stroke="#b58a0c" strokeWidth=".6" />
        </svg>
      );
    case 'bug':
      return (
        <svg {...common} className="type-icon bug">
          <title>Bug</title>
          <ellipse cx="8" cy="9.5" rx="4" ry="5" fill="#d9534f" />
          <circle cx="8" cy="4" r="2.4" fill="#a83532" />
          <path d="M2 7h2.5M2 11h2.5M11.5 7H14M11.5 11H14M8 5.5v9" stroke="#7a2523" strokeWidth="1" />
        </svg>
      );
    case 'chore':
      return (
        <svg {...common} className="type-icon chore">
          <title>Chore</title>
          <path
            d="M8 5a3 3 0 100 6 3 3 0 000-6zm6 4V7l-1.7-.4a4.6 4.6 0 00-.5-1.2l.9-1.5-1.4-1.4-1.5.9c-.4-.2-.8-.4-1.2-.5L8.2 2H6.8l-.4 1.9c-.4.1-.8.3-1.2.5l-1.5-.9-1.4 1.4.9 1.5c-.2.4-.4.8-.5 1.2L1 7v2l1.7.4c.1.4.3.8.5 1.2l-.9 1.5 1.4 1.4 1.5-.9c.4.2.8.4 1.2.5l.4 1.9h1.4l.4-1.9c.4-.1.8-.3 1.2-.5l1.5.9 1.4-1.4-.9-1.5c.2-.4.4-.8.5-1.2z"
            fill="#7d8b99"
          />
        </svg>
      );
    case 'release':
      return (
        <svg {...common} className="type-icon release">
          <title>Release</title>
          <path d="M3 1.5v13" stroke="#2c5282" strokeWidth="1.5" />
          <path d="M3.5 2h9l-2 3 2 3h-9z" fill="#3182ce" />
        </svg>
      );
  }
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Click-outside dropdown. */
export function Dropdown({ trigger, children, align = 'left', className }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className={cx('dropdown', className)} ref={ref}>
      <span onClick={() => setOpen(!open)}>{trigger(open)}</span>
      {open && <div className={cx('dropdown-menu', align)}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="error-text">{msg}</div>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

/** Text that becomes editable on click and saves on blur / Enter. */
export function InlineEdit({
  value,
  onSave,
  multiline,
  placeholder,
  className,
  disabled,
}: {
  value: string;
  onSave: (v: string) => void | Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing || disabled) {
    return (
      <div className={cx('inline-edit', className, !value && 'placeholder', disabled && 'disabled')} onClick={() => !disabled && setEditing(true)}>
        {value || placeholder}
      </div>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) void onSave(draft.trim());
  };
  const props = {
    autoFocus: true,
    value: draft,
    className: cx('inline-edit-input', className),
    onChange: (e: any) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: any) => {
      if (e.key === 'Escape') {
        setDraft(value);
        setEditing(false);
      }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

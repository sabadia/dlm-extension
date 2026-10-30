import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from '../icons';

/** The components of every page. Their look is in `../theme.css`; they hold no business logic. */

const cx = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ');

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export function Button({
  variant = 'secondary',
  size,
  block,
  icon,
  children,
  class: className,
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'small';
  block?: boolean;
  icon?: IconName;
  children?: ComponentChildren;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size'>) {
  return (
    <button
      type="button"
      class={cx(
        'btn',
        variant !== 'secondary' && variant,
        size,
        block && 'block',
        className as string,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/** A button with only an icon: `label` is its name for screen readers and its tooltip. */
export function IconButton({
  icon,
  label,
  ...rest
}: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" class="icon-btn" aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  children,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ComponentChildren;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <label class="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span class="track" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  pressed,
  onClick,
  children,
  count,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ComponentChildren;
  count?: number;
}) {
  return (
    <button type="button" class="chip" aria-pressed={pressed} onClick={onClick}>
      {children}
      {count !== undefined ? <span class="count">{count}</span> : null}
    </button>
  );
}

export function Badge({
  tone = 'neutral',
  dot,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ComponentChildren;
}) {
  return (
    <span class={cx('badge', tone !== 'neutral' && tone)}>
      {dot ? <span class="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Card({
  title,
  description,
  children,
  id,
  actions,
}: {
  title?: string;
  description?: string;
  children: ComponentChildren;
  id?: string;
  actions?: ComponentChildren;
}) {
  const heading = useId();
  return (
    <section class="card" id={id} aria-labelledby={title ? heading : undefined}>
      {title ? (
        <header>
          <div class="row between">
            <h2 id={heading}>{title}</h2>
            {actions}
          </div>
          {description ? <p class="help">{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A labelled control with a hint and an error under it, wired for screen readers. */
export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  children: (props: {
    id: string;
    'aria-describedby': string;
    'aria-invalid': 'true' | 'false';
  }) => ComponentChildren;
}) {
  const id = useId();
  const describedBy = `${id}-help ${id}-error`;
  return (
    <div class="field">
      <label class="label" for={id}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? 'true' : 'false' })}
      <span class="help" id={`${id}-help`}>
        {help}
      </span>
      <span class="error" id={`${id}-error`} role="alert">
        {error}
      </span>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return <span class="spinner" role="status" aria-label={label} />;
}

export function Skeleton({ width = '100%', height = '1rem' }: { width?: string; height?: string }) {
  return <div class="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ComponentChildren;
  action?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <span class="art">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      {children ? <p class="small">{children}</p> : null}
      {action}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** A line is drawn above this item. */
  separated?: boolean;
}

/**
 * A button that opens a list of actions. Arrow keys move, Enter and Space choose, Escape and a click outside close it,
 * and focus goes back to the button.
 */
export function Menu({
  label,
  icon = 'more',
  items,
  up,
}: {
  label: string;
  icon?: IconName;
  items: readonly MenuItem[];
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const buttons = () =>
      [...(list.current?.querySelectorAll('button:not(:disabled)') ?? [])] as HTMLButtonElement[];
    buttons()[0]?.focus();
    const away = (event: Event) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const key = (event: KeyboardEvent) => {
    const buttons = [
      ...(list.current?.querySelectorAll('button:not(:disabled)') ?? []),
    ] as HTMLButtonElement[];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      setOpen(false);
      (wrap.current?.querySelector('.icon-btn') as HTMLElement | null)?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(at + 1) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div class="menu-wrap" ref={wrap} onKeyDown={open ? key : undefined}>
      <IconButton
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div class={cx('menu', up && 'up')} role="menu" ref={list}>
          {items.map((item) => (
            <>
              {item.separated ? <hr /> : null}
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon ? <Icon name={item.icon} /> : null}
                {item.label}
              </button>
            </>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A modal question. Escape cancels; the first action gets focus. */
export function Dialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ComponentChildren;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const heading = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <div
      class="scrim"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby={heading}>
        <h2 id={heading}>{title}</h2>
        <div class="stack" style={{ marginTop: 'var(--space-3)' }}>
          {children}
        </div>
        <div class="actions">
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <button type="button" class="btn primary" ref={confirm} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

/** A short message that goes by itself. `show` is stable; `host` is rendered once at the end of the page. */
export function useToasts(ms = 4000) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const next = useRef(0);
  const show = (text: string, tone: 'info' | 'error' = 'info') => {
    next.current += 1;
    const id = next.current;
    setToasts((list) => [...list, { id, text, tone }]);
    setTimeout(
      () => setToasts((list) => list.filter((item) => item.id !== id)),
      tone === 'error' ? ms * 2 : ms,
    );
  };
  const host = (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={cx('toast', toast.tone === 'error' && 'error')}>
          {toast.text}
        </div>
      ))}
    </div>
  );
  return { show, host };
}

/** A list of short values (sites, extensions) typed one at a time. Each is checked when it is added. */
export function ChipInput({
  values,
  onChange,
  normalize,
  label,
  placeholder,
  error,
  describedBy,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  /** The cleaned value, or undefined when it is not valid (it stays in the box and is reported through `onInvalid`). */
  normalize: (input: string) => string | undefined;
  label: string;
  placeholder?: string;
  error?: string;
  describedBy?: string;
}) {
  const [text, setText] = useState('');
  const [rejected, setRejected] = useState('');

  const add = (raw: string) => {
    const pieces = raw
      .split(/[\s,;]+/)
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '');
    if (pieces.length === 0) return;
    const next = [...values];
    const bad: string[] = [];
    for (const piece of pieces) {
      const value = normalize(piece);
      if (value === undefined) bad.push(piece);
      else if (!next.includes(value)) next.push(value);
    }
    if (next.length !== values.length) onChange(next);
    setText(bad.join(' '));
    setRejected(bad.join(', '));
  };

  return (
    <div>
      <div class="chip-input">
        {values.map((value) => (
          <span class="tag" key={value}>
            {value}
            <button
              type="button"
              aria-label={`${label}: ${value}`}
              onClick={() => onChange(values.filter((item) => item !== value))}
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
        <input
          value={text}
          aria-label={label}
          aria-describedby={describedBy}
          aria-invalid={rejected || error ? 'true' : 'false'}
          placeholder={values.length === 0 ? placeholder : undefined}
          onInput={(event) => {
            const value = event.currentTarget.value;
            if (/[\s,;]$/.test(value)) add(value);
            else setText(value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(text);
            } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => add(text)}
        />
      </div>
      <span class="error" role="alert">
        {rejected ? `${rejected}` : (error ?? '')}
      </span>
    </div>
  );
}

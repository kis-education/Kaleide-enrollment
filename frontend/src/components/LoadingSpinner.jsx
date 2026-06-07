import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Spinner with a reassuring message that ROTATES through a list of i18n keys
 * every `intervalMs` (default 3.5s). Some wizard loads (fetchQuestions,
 * resumeSession) take several seconds; a static label makes the user think the
 * page hung. Rotating copy ("Cargando…", "Esto puede tardar unos segundos…",
 * "Gracias por tu paciencia…") reassures them.
 *
 * WIZARD-UX (Diego 2026-06-07). Pure visual feedback — does NOT touch any
 * loading/promise logic.
 *
 * @param {Object}   props
 * @param {string[]} [props.messages]      i18n keys to rotate (default loading.rotating.*)
 * @param {number}   [props.intervalMs=3500]
 * @param {'overlay'|'inline'} [props.variant='overlay']
 *        'overlay' → big spinner-border (3rem, teal) + label, used in full-page overlays.
 *        'inline'  → the theme.css `.spinner` + label, used inside a content area.
 * @param {string}   [props.className]
 */
const DEFAULT_MESSAGES = [
  'loading.rotating.1',
  'loading.rotating.2',
  'loading.rotating.3',
  'loading.rotating.4',
];

export default function LoadingSpinner({
  messages = DEFAULT_MESSAGES,
  intervalMs = 3500,
  variant = 'overlay',
  className,
}) {
  const { t } = useTranslation();
  const list = (messages && messages.length) ? messages : DEFAULT_MESSAGES;
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (list.length <= 1) return undefined;
    const id = setInterval(() => {
      setIdx(prev => (prev + 1) % list.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [list.length, intervalMs]);

  const label = t(list[idx % list.length]);

  if (variant === 'inline') {
    return (
      <div
        className={className}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '32px 0' }}
      >
        <div className="spinner" />
        <p aria-live="polite" style={{ margin: 0, color: 'var(--muted)', fontSize: '0.9rem' }}>
          {label}
        </p>
      </div>
    );
  }

  // overlay (default)
  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
    >
      <div className="spinner-border" role="status" style={{ color: 'var(--teal)', width: '3rem', height: '3rem' }} />
      <p aria-live="polite" style={{ marginTop: 16, color: 'var(--teal-dk)', fontWeight: 600, fontSize: '1rem' }}>
        {label}
      </p>
    </div>
  );
}

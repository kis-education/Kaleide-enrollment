/**
 * DevLogger — floating debug panel (enrollment wizard).
 * Full-featured port from KMS DevLogger:
 *   - Per-entry copy button with full data payload
 *   - Copy-all with data
 *   - Level filter (all / debug / info / success / warn / error)
 *   - Text search filter
 *   - Errors auto-expanded by default
 *   - Visible "✓ copied" toast
 *   - Floating bottom-right toggle button
 *
 * Subscribes to logger.js pub/sub store.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { subscribe, entries as initialEntries, clear } from '../logger';
import pkg from '../../package.json';

const LEVEL_COLOR = {
  debug:   '#ae3ec9',
  info:    '#fab005',
  success: '#51cf66',
  warn:    '#fd7e14',
  error:   '#ff6b6b',
};

const LEVEL_LABEL = {
  debug: 'DEBUG', info: 'INFO', success: 'SUCCESS', warn: 'WARN', error: 'ERROR',
};

const LEVEL_ORDER = ['all', 'debug', 'info', 'success', 'warn', 'error'];

/**
 * Clipboard write with iframe-safe fallback.
 */
function copyText(text) {
  if (!text) return Promise.resolve(false);
  if (navigator?.clipboard?.writeText) {
    try {
      return navigator.clipboard.writeText(text).then(() => true, () => fallback(text));
    } catch (_) {
      return Promise.resolve(fallback(text));
    }
  }
  return Promise.resolve(fallback(text));
}

function fallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function entryAsText(e) {
  const head = `[${e.ts}] [${LEVEL_LABEL[e.level] || e.level}] ${e.message}`;
  return e.data ? `${head}\n${e.data}` : head;
}

export default function DevLogger() {
  const [entries,  setEntries]  = useState([...initialEntries]);
  const [open,     setOpen]     = useState(false);
  const [expanded, setExpanded] = useState({});
  const [filter,   setFilter]   = useState('all');
  const [search,   setSearch]   = useState('');
  const [toast,    setToast]    = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => subscribe(setEntries), []);

  // Auto-expand new error entries
  useEffect(() => {
    setExpanded(prev => {
      const next = { ...prev };
      entries.forEach(e => {
        if (e.level === 'error' && e.data && next[e.id] === undefined) next[e.id] = true;
      });
      return next;
    });
  }, [entries]);

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, open]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(e => {
      if (filter !== 'all' && e.level !== filter) return false;
      if (!q) return true;
      return (
        (e.message || '').toLowerCase().includes(q) ||
        (e.data    || '').toLowerCase().includes(q)
      );
    });
  }, [entries, filter, search]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  }

  async function copyAll() {
    const text = visible.map(entryAsText).join('\n\n');
    const ok = await copyText(text);
    showToast(ok ? `Copied ${visible.length} entries` : 'Copy failed');
  }

  async function copyEntry(e) {
    const ok = await copyText(entryAsText(e));
    showToast(ok ? 'Copied' : 'Copy failed');
  }

  async function copyData(e) {
    const ok = await copyText(e.data || '');
    showToast(ok ? 'Data copied' : 'Copy failed');
  }

  // Download the FULL log store (every entry, ignoring the level/search
  // filters) as a .txt file. Entries are already PII-redacted at push time
  // (logger.js, KAL-11), so the file is as safe as "Copy all" — but a file
  // survives long debug sessions that don't fit the clipboard / chat paste.
  function downloadLog() {
    if (!entries.length) { showToast('No entries'); return; }
    const header =
      `ENR DEBUG LOG  v${pkg.version}\n` +
      `Generated: ${new Date().toISOString()}\n` +
      `Entries: ${entries.length}\n` +
      `${'─'.repeat(60)}\n\n`;
    const text = header + entries.map(entryAsText).join('\n\n') + '\n';
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `enr-debug-v${pkg.version}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`Downloaded ${entries.length} entries`);
    } catch (_) {
      showToast('Download failed');
    }
  }

  const hasErrors = entries.some(e => e.level === 'error');

  return (
    <div style={{ position: 'fixed', bottom: 12, right: 12, zIndex: 99999, fontFamily: 'Courier New, monospace', fontSize: 11 }}>

      {/* Floating panel */}
      {open && (
        <div style={{
          position: 'absolute', bottom: 52, right: 0,
          width: 'min(760px, 96vw)', height: 'min(560px, 80vh)',
          background: '#111', border: '1px solid #333',
          borderRadius: 12, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,.5)',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', background: '#1a1a1a', borderBottom: '1px solid #333', flexShrink: 0,
          }}>
            <span style={{ color: '#51cf66', fontWeight: 700, letterSpacing: '.5px', fontSize: 11 }}>
              ▶ ENR DEBUG LOG
              <span style={{ color: '#555', fontWeight: 400, marginLeft: 8 }}>
                v{pkg.version} ({visible.length}/{entries.length})
              </span>
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={copyAll}     style={btnStyle} title="Copy all visible entries with data">Copy all</button>
              <button onClick={downloadLog} style={btnStyle} title="Download the full log as a .txt file">⬇ Download</button>
              <button onClick={clear}       style={btnStyle}>Clear</button>
              <button onClick={() => setOpen(false)} style={btnStyle}>✕</button>
            </div>
          </div>

          {/* Toolbar */}
          <div style={{
            display: 'flex', gap: 6, padding: '6px 10px',
            borderBottom: '1px solid #2a2a2a', flexShrink: 0, alignItems: 'center',
          }}>
            {LEVEL_ORDER.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  ...btnStyle,
                  background: filter === f ? '#2f9e44' : '#222',
                  color:      filter === f ? '#fff'    : (LEVEL_COLOR[f] || '#aaa'),
                  fontWeight: filter === f ? 700 : 400,
                }}
              >
                {f}
              </button>
            ))}
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="search…"
              style={{
                marginLeft: 'auto', background: '#222', border: '1px solid #333',
                color: '#ddd', padding: '2px 8px', borderRadius: 4, fontSize: 10,
                fontFamily: 'inherit', width: 180,
              }}
            />
          </div>

          {/* Entries */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
            {visible.length === 0 && (
              <div style={{ color: '#555', padding: '8px 12px' }}>No entries match.</div>
            )}
            {visible.map(e => {
              const color = LEVEL_COLOR[e.level] || '#fab005';
              const label = LEVEL_LABEL[e.level]  || e.level.toUpperCase();
              const isExp = expanded[e.id];
              return (
                <div
                  key={e.id}
                  style={{ borderBottom: '1px solid #2a2a2a', padding: '3px 10px', wordBreak: 'break-all' }}
                >
                  <div
                    onClick={() => e.data && setExpanded(ex => ({ ...ex, [e.id]: !ex[e.id] }))}
                    style={{ cursor: e.data ? 'pointer' : 'default', display: 'flex', alignItems: 'flex-start', gap: 4 }}
                  >
                    <span style={{ color: '#555', flexShrink: 0 }}>[{e.ts}]</span>
                    <span style={{ color, fontWeight: 700, flexShrink: 0 }}>[{label}]</span>
                    <span style={{ color: '#ddd', flex: 1 }}>{e.message}</span>
                    {e.data && <span style={{ color: '#555' }}>{isExp ? '▲' : '▶'}</span>}
                    <button
                      onClick={ev => { ev.stopPropagation(); copyEntry(e); }}
                      title="Copy entry (with data)"
                      style={{ ...btnStyle, padding: '0 5px', fontSize: 9 }}
                    >
                      📋
                    </button>
                  </div>
                  {isExp && e.data && (
                    <div style={{ position: 'relative', marginTop: 4 }}>
                      <pre style={{
                        color: '#8b949e', margin: 0, fontSize: '0.7rem',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        background: '#0a0a0a', padding: '6px 8px',
                        borderRadius: 4, border: '1px solid #1f1f1f',
                        maxHeight: 380, overflowY: 'auto',
                      }}>
                        {e.data}
                      </pre>
                      <button
                        onClick={() => copyData(e)}
                        title="Copy data payload"
                        style={{ ...btnStyle, position: 'absolute', top: 4, right: 4, padding: '1px 6px', fontSize: 9 }}
                      >
                        Copy data
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Toast */}
          {toast && (
            <div style={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              background: '#2f9e44', color: '#fff', padding: '4px 12px',
              borderRadius: 4, fontSize: 11, fontWeight: 700,
              boxShadow: '0 4px 12px rgba(0,0,0,.4)',
            }}>
              ✓ {toast}
            </div>
          )}
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Toggle debug log"
        style={{
          width: 40, height: 40, borderRadius: '50%',
          background: open ? '#2f9e44' : hasErrors ? '#c92a2a' : '#1a1a1a',
          border: '1px solid #444', color: '#fff',
          fontSize: 16, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 12px rgba(0,0,0,.4)',
          transition: 'background .2s',
        }}
      >
        🔍
      </button>
    </div>
  );
}

const btnStyle = {
  background: '#333', border: 'none', color: '#aaa',
  padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 10,
  fontFamily: 'inherit',
};

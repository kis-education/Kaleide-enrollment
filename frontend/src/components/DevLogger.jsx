import { useState, useEffect, useRef } from 'react';
import { subscribe, entries as initialEntries, clear } from '../logger';

const LEVEL_STYLE = {
  info:    { bg: '#e8f4fd', color: '#0c5464', dot: '#1a9abf' },
  success: { bg: '#ebf7ee', color: '#1a5e2a', dot: '#2f9e44' },
  warn:    { bg: '#fff8e1', color: '#7a5200', dot: '#f59f00' },
  error:   { bg: '#ffeaea', color: '#7d1a1a', dot: '#e03131' },
};

export default function DevLogger() {
  const [entries,    setEntries]    = useState([...initialEntries]);
  const [open,       setOpen]       = useState(true);
  const [expanded,   setExpanded]   = useState({});
  const [filter,     setFilter]     = useState('all');
  const bottomRef = useRef(null);

  useEffect(() => subscribe(setEntries), []);

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, open]);

  const visible = filter === 'all' ? entries : entries.filter(e => e.level === filter);

  return (
    <div style={{
      position:   'fixed',
      bottom:     0,
      left:       0,
      width:      open ? 440 : 'auto',
      zIndex:     99999,
      fontFamily: 'monospace',
      fontSize:   '0.75rem',
    }}>
      {/* Toggle bar */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          background:    '#18222e',
          color:         '#a8d8ea',
          padding:       '5px 12px',
          cursor:        'pointer',
          display:       'flex',
          alignItems:    'center',
          justifyContent:'space-between',
          gap:           8,
          userSelect:    'none',
          borderTopRightRadius: open ? 0 : 8,
        }}
      >
        <span>
          <span style={{ color: '#2f9e44', marginRight: 6 }}>●</span>
          DEV LOG
          <span style={{ marginLeft: 8, color: '#6b7c93', fontSize: '0.7rem' }}>
            ({entries.length})
          </span>
        </span>
        <span>{open ? '▼' : '▲'}</span>
      </div>

      {open && (
        <div style={{ background: '#1a1f2e', border: '1px solid #2a3040' }}>
          {/* Toolbar */}
          <div style={{
            display:        'flex',
            gap:            6,
            padding:        '5px 8px',
            borderBottom:   '1px solid #2a3040',
            alignItems:     'center',
          }}>
            {['all', 'info', 'success', 'warn', 'error'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  background:   filter === f ? '#2a3040' : 'transparent',
                  border:       '1px solid ' + (filter === f ? '#4a5568' : 'transparent'),
                  color:        filter === f ? '#fff' : '#6b7c93',
                  borderRadius: 4,
                  padding:      '2px 7px',
                  cursor:       'pointer',
                  fontSize:     '0.7rem',
                }}
              >
                {f}
              </button>
            ))}
            <button
              onClick={clear}
              style={{
                marginLeft:   'auto',
                background:   'transparent',
                border:       '1px solid #4a5568',
                color:        '#e03131',
                borderRadius: 4,
                padding:      '2px 7px',
                cursor:       'pointer',
                fontSize:     '0.7rem',
              }}
            >
              clear
            </button>
          </div>

          {/* Log entries */}
          <div style={{ maxHeight: 260, overflowY: 'auto', padding: '4px 0' }}>
            {visible.length === 0 && (
              <div style={{ color: '#4a5568', padding: '8px 12px' }}>No entries.</div>
            )}
            {visible.map(e => {
              const style = LEVEL_STYLE[e.level] || LEVEL_STYLE.info;
              const isExp = expanded[e.id];
              return (
                <div
                  key={e.id}
                  onClick={() => e.data && setExpanded(ex => ({ ...ex, [e.id]: !ex[e.id] }))}
                  style={{
                    padding:    '3px 10px',
                    borderLeft: `3px solid ${style.dot}`,
                    marginBottom: 1,
                    cursor:     e.data ? 'pointer' : 'default',
                    background: isExp ? '#1e2538' : 'transparent',
                  }}
                >
                  <span style={{ color: '#4a5568', marginRight: 6 }}>{e.ts}</span>
                  <span style={{
                    color:        style.dot,
                    fontWeight:   700,
                    marginRight:  6,
                    fontSize:     '0.65rem',
                    textTransform:'uppercase',
                  }}>
                    {e.level}
                  </span>
                  <span style={{ color: '#c9d1d9' }}>{e.message}</span>
                  {e.data && (
                    <span style={{ color: '#4a5568', marginLeft: 4 }}>
                      {isExp ? '▲' : '▶'}
                    </span>
                  )}
                  {isExp && e.data && (
                    <pre style={{
                      color:      '#8b949e',
                      margin:     '4px 0 2px',
                      fontSize:   '0.7rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak:  'break-all',
                    }}>
                      {e.data}
                    </pre>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

import { useTranslation } from 'react-i18next';

// ─── Editor de UN reparto (1 / 2 / N pagadores) ───────────────────────────────
// REBUILD-8-11 (Diego 2026-06-11): componente PORTADO VERBATIM desde el antiguo
// pages/signing/* (monolito del antiguo host /sign) (eliminado) — estaba sano y probado; ahora es un
// componente compartido más, usado por Step8Billing.
// Slider+presets (2 pagadores) o inputs con rebalanceo proporcional (>2) → la suma es
// 100 POR CONSTRUCCIÓN. Reutilizado por el caso group-level (default colapsado) y por
// cada hijo en modo per-participante (CLI 10). `payers`=[{ key, payer_person_id, name,
// split }]. Controlado: recibe `payers` + `onChange(nextPayers)`.
export default function SplitEditor({ payers, onChange }) {
  const { t } = useTranslation();
  const two = payers.length === 2;
  const sliderA = two ? (Number(payers[0].split) || 0) : 0;
  const totalSplit = payers.reduce((s, p) => s + (Number(p.split) || 0), 0);

  // 2 pagadores: un slider reparte entre ambos (p0=a, p1=100-a → suma 100 exacta).
  const setSliderValue = (v) => {
    const a = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    onChange(payers.length === 2
      ? [{ ...payers[0], split: a }, { ...payers[1], split: 100 - a }]
      : payers);
  };

  // >2 pagadores: input por pagador con REBALANCEO proporcional del resto → la suma se
  // mantiene exactamente 100 (el drift de redondeo se corrige en el último "otro").
  const setSplitRebalanced = (key) => (e) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
    const others = payers.filter(p => p.key !== key);
    const otherSum = others.reduce((s, p) => s + (Number(p.split) || 0), 0);
    const remain = 100 - v;
    let acc = 0;
    const next = payers.map(p => {
      if (p.key === key) return { ...p, split: v };
      const share = others.length === 0 ? 0
        : (otherSum > 0 ? Math.round((Number(p.split) || 0) / otherSum * remain)
                        : Math.round(remain / others.length));
      acc += share;
      return { ...p, split: share };
    });
    const drift = 100 - (v + acc);
    if (drift !== 0) {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].key !== key) { next[i] = { ...next[i], split: Math.max(0, next[i].split + drift) }; break; }
      }
    }
    onChange(next);
  };

  const presetBtn = (label, a) => (
    <button type="button" className="btn btn-outline-secondary btn-sm" style={{ fontWeight: 600 }}
      onClick={() => setSliderValue(a)}>{label}</button>
  );

  // 1 pagador: no hay reparto que ajustar (100%).
  if (payers.length === 1) {
    return (
      <div style={{ padding: '12px 14px', background: 'var(--bg)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
        <span>{payers[0].name}</span><span>100%</span>
      </div>
    );
  }
  // 2 pagadores: slider + presets, auto-balanceado a 100%.
  if (two) {
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {presetBtn('100 / 0', 100)}
          {presetBtn('50 / 50', 50)}
          {presetBtn('0 / 100', 0)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '0.9rem', marginBottom: 6 }}>
          <span>{payers[0].name}: {sliderA}%</span>
          <span>{payers[1].name}: {100 - sliderA}%</span>
        </div>
        <input type="range" min="0" max="100" step="1" value={sliderA}
          onChange={e => setSliderValue(e.target.value)} style={{ width: '100%' }}
          aria-label={t('signing.billing.split.title')} />
      </div>
    );
  }
  // >2 pagadores: inputs con rebalanceo (suma 100 por construcción).
  return (
    <div>
      {payers.map(p => (
        <div key={p.key} style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, fontWeight: 600, fontSize: '0.88rem' }}>{p.name}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 110 }}>
              <input type="number" min="0" max="100" className="form-control"
                style={{ width: 72, textAlign: 'right' }} value={p.split}
                onChange={setSplitRebalanced(p.key)} />
              <span style={{ fontWeight: 600, color: 'var(--muted)' }}>%</span>
            </div>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', fontWeight: 700, color: '#1b5e20' }}>
        <span>{t('signing.billing.split.total')}</span>
        <span>{totalSplit}%</span>
      </div>
    </div>
  );
}

import { useTranslation } from 'react-i18next';

// ─── Editor de UN reparto (1 / 2 / N pagadores) ───────────────────────────────
// REBUILD-8-11 (Diego 2026-06-11): componente PORTADO VERBATIM desde el antiguo
// pages/signing/* (monolito del antiguo host /sign) (eliminado) — estaba sano y probado; ahora es un
// componente compartido más, usado por Step8Billing.
// Slider+presets (2 pagadores) o inputs con rebalanceo proporcional (>2) → la suma es
// 100 POR CONSTRUCCIÓN. Reutilizado por el caso group-level (default colapsado) y por
// cada hijo en modo per-participante (CLI 10). `payers`=[{ key, payer_person_id, name,
// split }]. Controlado: recibe `payers` + `onChange(nextPayers)`.
export default function SplitEditor({ payers, onChange, importes, money }) {
  const { t } = useTranslation();

  // ⭐ EL PASO 8 AL DÍA (2026-08-27) — EL IMPORTE AL LADO DEL PORCENTAJE.
  // Diego veía «60 % / 40 %» y nunca cuánto era eso en euros.
  //
  // ⛔ EL IMPORTE LO PROYECTA EL KMS y aquí NO se multiplica nada (DL-080-A): el reparto que
  // llega ya lo hizo el MISMO repartidor del cobro real, vencimiento a vencimiento.
  //
  // ⛔ Y SOLO SE ENSEÑA SI SIGUE SIENDO VERDAD: el importe es el del reparto GUARDADO, así
  // que en cuanto la familia mueve el deslizador deja de corresponder. Enseñar entonces el
  // número viejo al lado del porcentaje nuevo sería mentir en un paso que se FIRMA — y
  // recalcularlo aquí está prohibido. Se dice que se actualizará al guardar.
  const importeDe = (p) => {
    if (!importes || !money || !p || !p.payer_person_id) return null;
    const x = importes[String(p.payer_person_id)];
    if (!x || x.amount_cents == null) return null;
    if (x.split_percentage != null && Number(x.split_percentage) !== Number(p.split || 0)) {
      return { pendiente: true };
    }
    return { texto: money(x.amount_cents, x.currency_code) };
  };
  const lineaDeImporte = (p, alinear) => {
    const i = importeDe(p);
    if (!i) return null;
    return (
      <div data-testid="reparto-importe" data-payer={p.payer_person_id}
           style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--muted)', textAlign: alinear || 'left' }}>
        {i.pendiente ? t('signing.billing.split.amount_pending') : i.texto}
      </div>
    );
  };
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

  // 1 pagador: no hay reparto que ajustar.
  //
  // ⭐ D121 (2026-08-27) — AQUÍ SE PINTABA «100 %» A PELO, Y ERA MENTIRA. Si el reparto
  // guardado le daba a esta persona el 60 %, la pantalla decía 100 y la puerta de avance
  // —que exige que la suma sea 100— la dejaba ATASCADA sin explicar nada, en una pantalla que
  // se firma. Ahora se enseña **su valor real**, y si no llega a 100 **se dice qué falta**.
  //
  // ⛔ La puerta NO se afloja: sigue exigiendo suma 100 y un pagador principal. Lo que cambia
  // es que la familia SEPA por qué no puede pasar, no que se le deje pasar.
  if (payers.length === 1) {
    const suyo = Number(payers[0].split) || 0;
    const falta = Math.round((100 - suyo) * 100) / 100;
    return (
      <div style={{ padding: '12px 14px', background: 'var(--bg)', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
          <span>{payers[0].name}</span>
          <span data-testid="reparto-porcentaje" style={{ textAlign: 'right' }}>
            {suyo}%{lineaDeImporte(payers[0], 'right')}
          </span>
        </div>
        {Math.abs(falta) > 0.5 && (
          <div data-testid="reparto-incompleto"
               style={{ fontSize: '0.78rem', color: 'var(--danger, #b42318)', marginTop: 6 }}>
            {t('signing.billing.split.incomplete', { falta: falta })}
          </div>
        )}
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
          <span>{payers[0].name}: {sliderA}%{lineaDeImporte(payers[0])}</span>
          <span style={{ textAlign: 'right' }}>{payers[1].name}: {100 - sliderA}%{lineaDeImporte(payers[1], 'right')}</span>
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
            <span style={{ flex: 1, fontWeight: 600, fontSize: '0.88rem' }}>
              {p.name}{lineaDeImporte(p)}
            </span>
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

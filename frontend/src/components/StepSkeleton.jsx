/**
 * StepSkeleton — placeholder shimmer para la zona de CONTENIDO de un paso del
 * wizard mientras carga (WIZARD-PERF-CACHE-SKELETON, Diego 2026-06-07).
 *
 * La cabecera del paso (título/subtítulo/stepper) la pinta el propio paso de
 * inmediato; este componente solo rellena el área de contenido con bloques grises
 * animados en vez de un spinner centrado o pantalla vacía — la página se percibe
 * "viva" desde el primer frame. Puramente visual, additive, cero lógica.
 *
 * @param {Object} props
 * @param {number} [props.rows=4]  número de bloques placeholder.
 */
export default function StepSkeleton({ rows = 4 }) {
  const lines = Array.from({ length: Math.max(1, rows) });
  return (
    <div className="kis-card" aria-busy="true" aria-live="polite" style={{ overflow: 'hidden' }}>
      <style>{`
        @keyframes kis-skeleton-shimmer {
          0%   { background-position: -480px 0; }
          100% { background-position:  480px 0; }
        }
        .kis-skel-block {
          height: 18px;
          border-radius: 6px;
          margin-bottom: 14px;
          background: linear-gradient(90deg, #eef1f4 25%, #e2e6ea 37%, #eef1f4 63%);
          background-size: 480px 100%;
          animation: kis-skeleton-shimmer 1.3s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .kis-skel-block { animation: none; }
        }
      `}</style>
      {lines.map((_, i) => (
        <div
          key={i}
          className="kis-skel-block"
          style={{ width: i === 0 ? '45%' : i === lines.length - 1 ? '70%' : '100%' }}
        />
      ))}
    </div>
  );
}

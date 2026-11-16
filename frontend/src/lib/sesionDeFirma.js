// ★ `2026-11-15-el-segundo-hermano-no-puede-firmar` (drenaje :08 v1017) — EL ESTADO DE LA FIRMA
// QUE ENSEÑA EL PASO 11 ES EL DEL HIJO ELEGIDO.
//
// El paso 11 guarda en memoria (`signingSession`, del CONTEXTO) lo último que leyó de la sesión
// de firma, para que volver a él pinte al instante. Ese memo sobrevive al remontaje del paso, y
// una sesión de firma es de UN hijo ⇒ al elegir al segundo hermano en el selector, el paso se
// sembraba con el estado del PRIMERO: si ése ya estaba firmado, al segundo le salía «firma
// completada» sin haber firmado nada. Es el mismo defecto que `CLI 468` cerró para la lista de
// documentos del paso 10 (`signingMembersDe`), y se cierra con el mismo molde: el memo RECUERDA
// DE QUÉ HIJO ES, y solo se siembra con él si es el del hijo en pantalla.
//
// ⛔ Sin hijo elegido (un solo hermano admitido, o servidor sin estado por hijo) los dos lados son
// `null` ⇒ byte a byte el comportamiento de hoy.
// ⛔ La MONOTONÍA de siempre («una sesión iniciada no vuelve a DRAFT») sigue en pie DENTRO de un
// mismo hijo; entre dos hijos distintos no hay nada que conservar — heredar el estado del otro
// hermano es justo el defecto.

function iniciada(state) {
  if (!state) return false;
  const u = String(state).toUpperCase();
  return u !== 'DRAFT' && u !== 'NOT_INITIATED';
}

/**
 * El memo, solo si es del hijo que se pregunta; si no, `null` (= «nunca leído» para ese hijo).
 * @param {Object|null} memo     lo guardado ({ state, signerUrls, ... })
 * @param {string|null} memoDe   enrollment_id dueño del memo (null = sin selección)
 * @param {string|null} hijo     enrollment_id elegido ahora (null = sin selección)
 * @returns {Object|null}
 */
export function sesionDelHijo(memo, memoDe, hijo) {
  if (!memo) return null;
  return (memoDe || null) === (hijo || null) ? memo : null;
}

/**
 * Funde una lectura nueva con el memo anterior. Devuelve `{ sesion, de }`.
 * @param {{sesion:Object|null, de:string|null}} prev
 * @param {Object|null} next      la respuesta de la lectura
 * @param {string|null} nextDe    el hijo del que es esa lectura
 */
export function fundirSesionDeFirma(prev, next, nextDe) {
  const p = prev || { sesion: null, de: null };
  if (!next) return p;                                   // no pisar con null/undefined
  const de = nextDe || null;
  if ((p.de || null) !== de) return { sesion: next, de }; // otro hijo: nada que heredar
  if (p.sesion && iniciada(p.sesion.state) && !iniciada(next.state)) {
    // refresco transitorio «menos iniciado» → conserva el estado ya iniciado
    // (la sesión no des-despacha) pero acepta lo demás nuevo.
    return { sesion: { ...next, state: p.sesion.state }, de };
  }
  return { sesion: next, de };
}

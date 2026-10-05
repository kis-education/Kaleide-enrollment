// `2026-09-16-la-salud-no-se-recupera` — el aviso del paso de Salud sale por una tabla de SALUD
// caída y no por otra. Ejecuta `frontend/src/lib/cargaDegradada.js` REAL (sin red ni navegador).
// Roturas demostradas: se rompe una copia del fuente y se exige que el control lo NOMBRE.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ruta = join(raiz, 'frontend/src/lib/cargaDegradada.js');
const fallos = [];
let total = 0;
const afirmar = (n, ok) => { total++; if (!ok) fallos.push(n); };

function bateria(m, etiqueta) {
  const S = 'person_subreads';
  afirmar(`${etiqueta}: sin degradación no avisa`, m.saludNoCargo([]) === false);
  afirmar(`${etiqueta}: no-array no avisa`, m.saludNoCargo(undefined) === false);
  afirmar(`${etiqueta}: sección sin nombres finos AVISA`, m.saludNoCargo([S]) === true);
  afirmar(`${etiqueta}: cae una de salud, avisa`, m.saludNoCargo([S, `${S}:enrPersonFoodAllergies`]) === true);
  afirmar(`${etiqueta}: cae solo nacionalidad, NO avisa`, m.saludNoCargo([S, `${S}:enrPersonNationalities`]) === false);
  afirmar(`${etiqueta}: nacionalidad + NEAE, avisa`, m.saludNoCargo([S, `${S}:enrPersonNationalities`, `${S}:enrPersonNeae`]) === true);
  afirmar(`${etiqueta}: otra sección no avisa`, m.saludNoCargo(['responses']) === false);
  afirmar(`${etiqueta}: tablasCaidas devuelve los nombres finos`,
    JSON.stringify(m.tablasCaidas([S, `${S}:a`, 'otra:b'])) === JSON.stringify(['a']));
}

async function cargar(src, nombre) {
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  return import(url + '#' + nombre);
}

try {
  const fuente = readFileSync(ruta, 'utf8');
  bateria(await import(pathToFileURL(ruta).href), 'real');

  // Roturas: cada una DEBE hacer saltar alguna afirmación.
  const roturas = {
    'avisa-siempre': fuente.replace('return finas.some(t => TABLAS_DE_SALUD.includes(t));', 'return true;'),
    'sin-fallback-grueso': fuente.replace('if (!finas.length) return true;', 'if (!finas.length) return false;'),
    'lista-vacia': fuente.replace("'enrPersonFoodAllergies',", ''),
  };
  for (const [nombre, src] of Object.entries(roturas)) {
    afirmar(`MEDICIÓN CIEGA: la rotura «${nombre}» no cambia el fuente`, src !== fuente);
    const antes = fallos.length;
    bateria(await cargar(src, nombre), `rotura ${nombre}`);
    const cazada = fallos.length > antes;
    fallos.length = antes;           // lo que fallaron las roturas es lo ESPERADO
    afirmar(`la rotura «${nombre}» la nombra alguna afirmación`, cazada);
  }
} catch (e) {
  fallos.push('el arnés reventó: ' + (e && e.message));
} finally {
  console.log(fallos.length ? `VEREDICTO: ROJO — ${fallos.join(' · ')}`
                            : `VEREDICTO: VERDE — ${total} afirmaciones`);
  process.exitCode = fallos.length ? 1 : 0;
}

/**
 * SetupDrainSecret.gs — helper manual de un solo uso (CLI DRAIN-SECRET).
 *
 * Genera y persiste el Script Property `DRAIN_SHARED_SECRET` del proyecto GAS
 * del wizard. Ese secreto es el que el gate de la action `drainJobQueue`
 * (rama wperf-2 → main tras integración) compara contra el campo `_secret`
 * del webhook que dispara el bot AppSheet.
 *
 * USO (una sola vez):
 *   1. Ejecutar `manual_setDrainSharedSecret` (clasp run, o GAS editor →
 *      Ejecutar → manual_setDrainSharedSecret).
 *   2. Leer el valor logueado (clasp run output, o GAS editor → Ver → Registros).
 *   3. Copiar ese valor al body del webhook del bot AppSheet:
 *        {"action":"drainJobQueue","_secret":"<valor>"}
 *
 * El valor NO vive en el repo: se genera server-side (CSPRNG vía
 * Utilities.getUuid) y solo se loguea una vez. Re-ejecutar ROTA el secreto
 * (habría que actualizar el bot AppSheet con el nuevo valor).
 *
 * NO registrar en el dispatcher público de doPost (regla CLAUDE.md
 * §"funciones de diagnóstico/debug fuera del dispatcher público"): es un
 * helper de owner, protegido por la auth del editor / executionApi MYSELF.
 *
 * @returns {string} el valor generado de DRAIN_SHARED_SECRET.
 */
function manual_setDrainSharedSecret() {
  var s = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('DRAIN_SHARED_SECRET', s);
  Logger.log('DRAIN_SHARED_SECRET set = ' + s);
  return s;
}

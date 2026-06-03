````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-5 — frontend logger redaction nombres/DOB/médicos (KAL-NEW-11)** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main`.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §4 (KAL-NEW-11) — _"Redacción logs frontend incompleta (no nombres/DOB/médicos)"_.
3. `/home/user/Kaleide-enrollment/frontend/src/logger.js` (estado actual: redacta emails + UUIDs + token preview, falta el resto).
4. `/home/user/Kaleide-enrollment/backend/Code.js` ~L155-162 (`redact_()` backend canónico — referencia de paridad).

# Misión
Cerrar **KAL-NEW-11** del audit 2026-05-30: el `redactDeep` del frontend solo enmascara emails + UUIDs + keys con sufijo `token`. Las llamadas reales del wizard pasan al logger payloads con nombres completos, fechas de nacimiento, alergias, condiciones médicas — todo PII de menores (Art. 9 RGPD datos especiales). Si el logger se ve por screen share o devtools, el daño es real aunque emails/UUIDs estén redactados.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches.
   ```

2. **Inventario de keys sensibles** que el wizard pasa al logger. Recorre:
   ```bash
   grep -rnE "log\.(debug|info|warn|error|success)\(" /home/user/Kaleide-enrollment/frontend/src/ | head -40
   ```
   Lee cada call y anota qué claves del payload puede recibir. Esperables (sin ser exhaustivo): `first_name`, `last_name`, `full_name`, `dob`, `birth_date`, `nationality`, `medical_*`, `allergies`, `dietary_*`, `passport_*`, `id_number`, `phone`, `address`, `national_id`.

3. **Extender `redactDeep` en `frontend/src/logger.js`** para colapsar por KEY name (no por shape — la PII médica/nombres no tiene un regex universal). Patrón:

   ```javascript
   // KAL-NEW-11: keys cuyo VALUE es PII (no detectable por regex de shape).
   // Lista canónica — mantener en sync con backend `redact_` cuando éste añada
   // soporte por-key (TODO Stage 2). Stage 1 frontend-only.
   const PII_KEY_PATTERNS = [
     /^first_name$/i,
     /^last_name$/i,
     /^full_name$/i,
     /^name$/i,         // generic
     /^dob$/i,
     /^birth_date$/i,
     /^date_of_birth$/i,
     /^nationality(?:_.*)?$/i,
     /^passport(?:_.*)?$/i,
     /^national_id(?:_.*)?$/i,
     /^id_number$/i,
     /^address(?:_.*)?$/i,
     /^street$/i,
     /^postal_code$/i,
     /^city$/i,
     /^phone(?:_.*)?$/i,
     /^medical/i,        // medical_condition, medical_notes, etc.
     /^allerg/i,         // allergies, allergy_*
     /^dietary/i,        // dietary_requirements, dietary_*
     /^health(?:_.*)?$/i,
     /^condition(?:_.*)?$/i,
     /^school_history(?:_.*)?$/i,
   ];

   function isPiiKey(k) {
     return PII_KEY_PATTERNS.some(re => re.test(k));
   }
   ```

   Modificar `redactDeep` para que cuando una key matchee `isPiiKey`, el valor se reemplace por `'[PII]'` (string corto, no preview — preview sería peor porque "Mar..." aún identifica):
   ```javascript
   function redactDeep(value) {
     if (value === null || value === undefined) return value;
     if (typeof value === 'string') return redact(value);
     if (typeof value === 'number' || typeof value === 'boolean') return value;
     if (Array.isArray(value)) return value.map(redactDeep);
     if (typeof value === 'object') {
       const out = {};
       for (const k of Object.keys(value)) {
         const v = value[k];
         // KAL-NEW-11: PII keys → constant marker (no preview).
         if (isPiiKey(k)) {
           out[k] = (v === null || v === undefined) ? v : '[PII]';
         }
         // KAL-11: token-shaped keys → preview only.
         else if (/token$/i.test(k) && typeof v === 'string' && v.length > 8) {
           out[k] = v.slice(0, 8) + '...';
         } else {
           out[k] = redactDeep(v);
         }
       }
       return out;
     }
     return value;
   }
   ```

4. **Test del redactor** (añadir test inline o componente de test):
   - Pasar `{first_name:'María', dob:'2018-05-12', medical_conditions:'asthma'}` por `redactDeep` → resultado debe ser `{first_name:'[PII]', dob:'[PII]', medical_conditions:'[PII]'}`.
   - Pasar `{first_name:null}` → resultado `{first_name:null}` (no convertir null en `[PII]`).
   - Pasar un objeto con array de objetos → recursión correcta.

   Patrón sugerido: añade un export `_redactDeepForTest = redactDeep` (con guion bajo para indicar internal) y un fichero `frontend/src/__tests__/logger.test.js` si el wizard tiene Vitest/Jest setup; si NO tiene setup de testing, añade un wrapper component `<LoggerTest />` debug que renderiza los 3 casos como JSON y desmounta. La verificación es leyendo el componente desmontado en dev.

5. **No tocar el backend** en este CLI — el backend `redact_()` tiene su propio plan de paridad (puede llegar como CLI separado más adelante). El comentario del header de `logger.js` ya menciona el "TODO Stage 2 backend parity".

6. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add frontend/src/logger.js
   # + cualquier test añadido
   git commit -m "security(wizard): redactDeep colapsa nombres/DOB/médicos via PII_KEY_PATTERNS (KAL-NEW-11)"
   git push origin main
   ```
   GitHub Pages workflow disparará el deploy del frontend.

# Pruebas orientadas al fallo
- Antes del fix: en dev, llamar `log.info('persons', {first_name:'María', dob:'2018-05-12'})` → DevLogger panel muestra valores en claro.
- Después del fix: misma llamada → DevLogger muestra `{first_name:'[PII]', dob:'[PII]'}`.
- Edge: `log.info('email check', {email:'a@b.com', first_name:'María'})` → ambos enmascarados (email por regex shape, first_name por key).

# Reporte
- **Primera línea literal**: `**CLI KAL-5 — frontend logger redaction nombres/DOB/médicos (KAL-NEW-11)** finalizado.`
- Diff completo de `frontend/src/logger.js`.
- Output del inventario de keys del paso 2 (lista de keys reales que el wizard mete al logger hoy).
- Output del test (si Vitest/Jest disponible) o evidencia del wrapper `<LoggerTest />` desmontado.
- Hash commit + push.
- URL del workflow GitHub Pages disparado.
````

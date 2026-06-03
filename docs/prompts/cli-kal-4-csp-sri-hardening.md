````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-4 — CSP + SRI hardening en index.html (KAL-NEW-8)** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main` + flow `clasp push --force` (no aplica aquí — es frontend-only) + deploy frontend via GitHub Pages.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §4 (KAL-NEW-8) — _"Token + PII en sessionStorage sin CSP/SRI"_.
3. `/home/user/Kaleide-enrollment/frontend/index.html` — head completo (verás que ya tiene `<meta name="referrer" content="no-referrer">` per KAL-7, pero no CSP).

# Misión
Cerrar **KAL-NEW-8** del audit 2026-05-30: el `index.html` del wizard carga fonts + bootstrap-icons desde CDNs externos (`fonts.googleapis.com`, `cdn.jsdelivr.net`) sin SRI hash ni CSP que restrinja la lista de hosts. Cualquier compromise del CDN inyecta JS arbitrario en la página del wizard, donde el `sessionStorage` lleva el `resume_token` (bearer secret) + PII (emails, nombres, etc.). El KMS ya tiene el equivalente KIS-11 abierto; aquí cerramos la mitad wizard.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches.
   ```

2. **Inventario de orígenes externos** que `frontend/index.html` ya consume:
   ```bash
   grep -nE "https?://" /home/user/Kaleide-enrollment/frontend/index.html
   grep -rnE "https?://[a-z0-9.-]+\.(com|org|net|io)" /home/user/Kaleide-enrollment/frontend/src/ | head -30
   ```
   - Hosts ya presentes: `fonts.googleapis.com`, `fonts.gstatic.com` (servido por fonts.googleapis.com como redirect), `cdn.jsdelivr.net` (bootstrap-icons), `raw.githubusercontent.com` (favicon).
   - Hosts API: el backend del wizard está en `script.google.com` (forms POST a `/macros/s/.../exec`) + `script.googleusercontent.com` (redirect).
   - Hosts de fonts intermedios: `fonts.gstatic.com` (Google Fonts sirve binarios desde ahí).
   - reCAPTCHA: `www.google.com/recaptcha/` + `www.gstatic.com/recaptcha/`.
   - Confirma la lista con el grep — añade cualquier host que aparezca.

3. **Añadir CSP `<meta>` en `<head>` de `frontend/index.html`** (estructura mínima viable Stage 1 — restrictive pero no rompe el wizard):
   ```html
   <meta http-equiv="Content-Security-Policy" content="
     default-src 'self';
     script-src 'self' 'unsafe-inline' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/;
     style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;
     font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net;
     img-src 'self' data: https://raw.githubusercontent.com https://www.gstatic.com;
     connect-src 'self' https://script.google.com https://script.googleusercontent.com https://www.google.com/recaptcha/;
     frame-src https://www.google.com/recaptcha/;
     base-uri 'self';
     form-action 'self';
     object-src 'none';
     frame-ancestors 'none';
   ">
   ```
   **Comentarios obligatorios** sobre cada directiva (justifica los `'unsafe-inline'`):
   - `script-src 'unsafe-inline'`: React via Babel Standalone si Babel se usa en runtime (verifica); en su defecto eliminar `'unsafe-inline'` o moverlo a nonce. Empieza con `'unsafe-inline'` para no romper, anota TODO Stage 2 con nonce.
   - `style-src 'unsafe-inline'`: Bootstrap-icons + estilos inline de React → necesario hoy.
   - **NO** uses `'unsafe-eval'` salvo que el build lo exija (probable que sí si Babel se interpreta runtime; verifica abriendo devtools post-fix con CSP report-only primero).
   - `connect-src` debe incluir el dominio del backend GAS web app deployment (verifica el deployment URL real). El base URL real de la API del wizard puede ser un subdominio de `script.google.com` o `script.googleusercontent.com` — incluir ambos.

4. **CSP report-only first** (recomendado): primero merge una versión `Content-Security-Policy-Report-Only` para ver violaciones reales sin romper el wizard. Una vez verificada → switch a `Content-Security-Policy`.
   ```html
   <meta http-equiv="Content-Security-Policy-Report-Only" content="..."> <!-- iter 1 -->
   ```
   Trabajo Stage 1: aplicar `Content-Security-Policy` directo (no report-only) pero con dump de violaciones en consola (`'report-uri'` o `'report-to'` no aplican en meta — solo en headers). Asume confianza en la lista de orígenes inventariada.

5. **SRI para los 2 CDN externos** (fonts + bootstrap-icons):
   - **Fonts CSS** (`fonts.googleapis.com`): el SRI hash de Google Fonts CSS NO es estable — Google sirve CSS distinto por request (basado en User-Agent). Por tanto NO se le puede aplicar `integrity=...`. Documenta esta excepción en un comentario del HTML:
     ```html
     <!-- Google Fonts CSS is User-Agent-specific; SRI not applicable.
          CSP `style-src https://fonts.googleapis.com` restricts the origin. -->
     ```
   - **Bootstrap-icons** (`cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css`): SÍ es estable.
     - Genera el SRI hash con:
       ```bash
       curl -sS https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css | openssl dgst -sha384 -binary | openssl base64 -A
       ```
     - Añade `integrity="sha384-<base64>"` y `crossorigin="anonymous"` al `<link>`:
       ```html
       <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css"
             rel="stylesheet"
             integrity="sha384-<computed-hash>"
             crossorigin="anonymous" />
       ```

6. **Validación local antes de commit** (importante):
   - Abre `frontend/index.html` en un navegador local (o `npm run dev` si Vite).
   - Recorre Steps 1-7 del wizard (puedes mockear las API calls). Mira la consola del navegador y registra CADA violación CSP que aparezca.
   - Si una violación rompe funcionalidad real (fuentes no cargan, reCAPTCHA falla, fetch al backend bloqueado) → ajustar la directiva (añadir host faltante o `'unsafe-eval'` si aplica) y volver a probar.
   - El criterio es: la CSP debe ser lo más restrictiva posible **sin romper el wizard**. Si hay que relajarla, documenta cada relajación en un comentario.

7. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add frontend/index.html
   git commit -m "security(wizard): CSP + SRI hardening en index.html (KAL-NEW-8)"
   git push origin main
   ```
   El push dispara GitHub Pages deploy.

# Pruebas orientadas al fallo
- Abrir `admissions.kaleide.org` post-deploy → wizard debe cargar igual (fuentes, iconos, llamadas API).
- Devtools → Network → la página NO debe poder cargar recursos fuera de la allowlist.
- Inyectar manualmente un `<script src="https://evil.example/x.js"></script>` en devtools — debe ser bloqueado por CSP.

# Reporte
- **Primera línea literal**: `**CLI KAL-4 — CSP + SRI hardening en index.html (KAL-NEW-8)** finalizado.`
- Diff completo de `frontend/index.html`.
- Lista de violaciones CSP detectadas durante el testing local + qué decisiones tomaste (host añadido / directiva relajada).
- Hash SRI calculado para bootstrap-icons (output literal del `openssl dgst`).
- Comentarios del HTML que justifican `'unsafe-inline'` y la excepción SRI de Google Fonts.
- Hash commit + push.
- Verificación visual: `admissions.kaleide.org` post-deploy carga el wizard sin errores en devtools (excepto las violaciones esperadas si dejaste alguna directiva fallida intencionalmente para iter 2).
````

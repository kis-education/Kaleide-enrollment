# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI — recuperacion-enlace-reusado** finalizado.

# Lectura obligatoria previa
1. `origin/main:frontend/src/components/StepUpGate.jsx` — el gate del código de un solo uso de la ENTRADA (el que muestra «Enviando código…»). Lee el handler de envío (`sendVerificationCode`, ~línea 184-220) y cómo `envioPrevio`/`onEnvioFallido` persisten el resultado entre remontajes.
2. `origin/main:frontend/src/api.js` — `gasCall` (~910), el carril de TRANSPORTE (`e.transporte`, `esEstadoDeTransporte_` ~867), `LECTURAS_REINTENTABLES_AL_VOLVER` (~897) y `TOPE_MS = 240000` (~969).
3. `origin/main:backend/Code.js` — las constantes del espejo: `COPIA_PUERTA_TTL_S_ = 1800` (~709, con su ⛔ «NO SE SUBE MÁS DE AQUÍ») y `ESPEJO_CADA_MIN_ = 30` (~12897). Y el disparador `espejoRefrescarCopias` (~13178) + `_asegurarDisparadorDelEspejo_` (~12914).
4. La sección `§0º.tricies.nonies` del `CLAUDE.md` de este repo (el peligro del SEGUNDO código: `cache.put(codeKey, code, 600)` PISA al primero) y `§Las CINCO puertas` (el envío es «dispara y navega»).

# Contexto — el problema, MEDIDO

Cuando una familia entra por un enlace mágico de hace días, a veces la pantalla del código se queda en **«Enviando código…»** durante minutos y luego dice que falló. Diego lo ha sufrido de forma sistemática. La causa NO es que el KMS sea lento por naturaleza: es el transporte de Google.

Ya está confirmado por medición (no hay que volver a medir esto):
- **La entrada (`hydrateSession`) YA se recupera** — `ResumePage` reintenta 2 veces el corte de transporte (`RESUME_REINTENTOS_MS`). Eso NO se toca.
- **El fallo que queda es el ENVÍO DEL CÓDIGO** (`sendVerificationCode`). Es una llamada al KMS que tarda 15-25 s (salto wizard→KMS, inherente, no se puede acelerar desde el cliente ni servir de una copia: tiene que acuñar un código y mandar un correo). Cuando el segundo salto de Google (el `echo`) **pierde la respuesta**, `gasCall` no la ve hasta que el tope de 240 s aborta ⇒ la familia mira «Enviando código…» hasta 4 minutos, y entonces `.catch` pinta un error que invita a **reenviar**.
- ⛔ **Y reenviar en ese punto es el daño real:** el código casi seguro SÍ se envió (Google solo perdió la RESPUESTA; por eso los correos de Diego llegaban). Un reenvío acuña un código NUEVO que **PISA al que ya está en el buzón de la familia** (`§0º.tricies.nonies`). ⇒ hoy, un corte de transporte en el envío del código empuja a la familia a matar su propio código bueno.

# Misión

Dos cosas independientes, en este repo (`Kaleide-enrollment`), las dos a `main`.

## (a) — LA DE FONDO: la familia NUNCA se queda atascada en «Enviando código…», y un corte de transporte NUNCA la empuja a reenviar

Cliente. `frontend/src/components/StepUpGate.jsx` (+ `WizardContext.jsx`/`api.js` solo si hace falta para el cableado de `envioPrevio`).

**El invariante que hay que cumplir:**
1. **Tope de espera VISIBLE corto.** La familia no puede mirar «Enviando código…» más de ~10-12 s. Pasado eso, el mensaje pasa a uno honesto —«Tu código puede tardar un poco en llegar. Revisa tu correo; si no lo recibes, pulsa Reenviar.»— **sin abortar la llamada de fondo** (puede resolverse aún) y **sin pedir código otra vez**. La casilla ya está habilitada (el envío es optimista, `codeSent=true`): la familia puede teclear el código que llegue.
2. **Distinguir el CORTE DE TRANSPORTE del rechazo del servidor**, usando el carril que ya existe (`e.transporte`). 
   - Con `e.transporte` (Google perdió/colgó la respuesta): **NO** es un fallo duro. Se muestra el mensaje «puede estar en camino», la casilla sigue usable, y **el botón de reenviar lo gobierna la cuenta atrás normal, NUNCA un reenvío inmediato** (eso es la trampa del segundo código). Y **NO se registra como ERROR** en `otpEnvioEntrada`/`envioPrevio` —hoy eso pinta un error alarmante al remontar—: se registra como «en camino» o no se registra nada.
   - Con un error que NO es de transporte (el servidor dijo que no, cupo agotado, etc.): se conserva el comportamiento de hoy (error real + poder reintentar).
3. **Cuando la promesa SÍ resuelve** (`.then`): confirmar «código enviado» como hoy. Cuando cae con transporte: mantener el mensaje suave. Cuando cae con otro error: el error real.

⛔ **PROHIBIDO reenviar el código automáticamente ante un corte de transporte**, y ⛔ **prohibido acortar `TOPE_MS` global en `api.js`** (lo usan todas las llamadas; el desacople vive en el gate). ⛔ **KAL-4, la marca de frescura y la gracia del enlace no se tocan.**

## (b) — REDUCIR LA EXPOSICIÓN: mantener la copia caliente sin hueco

Backend. `backend/Code.js`, **una sola constante**: `ESPEJO_CADA_MIN_` de `30` → **`15`**.

**Por qué, medido:** la copia de la PUERTA vive `COPIA_PUERTA_TTL_S_ = 1800` s (30 min) y el repaso corre cada `ESPEJO_CADA_MIN_ = 30` min ⇒ **el plazo es EXACTAMENTE igual al intervalo, margen CERO.** Un disparador de Apps Script retrasado o saltado (rutinario bajo `USER_DEPLOYING`), o una visita en los últimos segundos de la ventana, cae en FRÍO ⇒ la entrada se va al KMS (lento) ⇒ expuesta al corte de Google. Repasar cada 15 min re-calienta la copia **a mitad de su vida**, dejando 15 min de margen aunque una vuelta se salte, **sin tocar el plazo** (`COPIA_PUERTA_TTL_S_` es un techo de SEGURIDAD, con ⛔ — NO se sube).

- `15` es válido: `ScriptApp ... everyMinutes` solo admite 1/5/10/15/30.
- ⛔ **NO toques `COPIA_PUERTA_TTL_S_`, `ESPEJO_HYD_TTL_S_` ni ningún otro plazo.** Solo el intervalo del repaso.
- El coste es despreciable (hoy ~2 grupos reales por vuelta, 4 min de presupuesto; una vuelta cada 15 min en vez de 30 sigue siendo trivial y es UN solo disparador del wizard bajo su propia identidad, no por-tenant).

# Trabajo

1. **(a)** Implementa el desacople en `StepUpGate.jsx` siguiendo el invariante de arriba, reusando los patrones que YA existen (`e.transporte`, `envioPrevio`, `onEnvioFallido`/`onEnvioPedido`, la cuenta atrás de reenviar). Textos nuevos en los DOS idiomas (`frontend/public/locales/{es,en}/translation.json`) — p.ej. `stepup.codigo_en_camino`. No inventes claves que ya existan; reusa `stepup.code_sent`/`stepup.enviando` donde encajen.
2. **(b)** Cambia la constante en `backend/Code.js` y comprueba `node --check backend/Code.js`. Actualiza el comentario/tabla de tiempos si alguno cita «cada 30 min» junto a esta constante.
3. **RED — muro del asistente (obligatorio para (a), es el muro de ESTE repo).** Amplía `frontend/e2e/run-wizard.mjs`: en el camino del código de entrada (`codigo-al-entrar-por-enlace` / `codigo-sin-congelar`), añade una afirmación para el **corte de transporte durante el envío del código**: al matar el socket del `sendVerificationCode` (como en `enlace-no-ha-caducado` / `el-iphone-no-se-lleva-la-sesion`, que matan el socket — NO un `{ok:false}`), la familia **NO se queda atascada en «Enviando código…»**, **la casilla sigue usable**, y **NO se le ofrece reenviar de inmediato** (la trampa del segundo código). **Rómpela a propósito** antes de darla por buena: con el código de hoy, la afirmación debe salir ROJA nombrando el caso. `npm run e2e:wizard` debe terminar **`VEREDICTO: VERDE`** (lee la ÚLTIMA línea; a un fichero, no por `| tee`).
4. **(b) no tiene red de batería** (corre contra un backend simulado que nunca ejecuta `backend/Code.js`). Es un cambio de una constante: basta `node --check` + confirmar que `15` es un valor válido de `everyMinutes`. NO escribas un arnés para esto.
5. **DOC**: si algún párrafo del `CLAUDE.md` de este repo cita «cada 30 min» ligado al espejo o la tabla de tiempos de la puerta, actualízalo EN EL MISMO cambio. Registra (a) y (b) donde corresponda (una entrada breve; el histórico va a git).

# Publicación

- **(a) es solo `frontend/`** ⇒ sale por CI/Pages al empujar a `main`, **sin `clasp`**. Bumpea `frontend/package.json` (patch) si este repo lo usa como señal; si no, omítelo.
- **(b) toca `backend/Code.js`** ⇒ necesita `clasp push --force` + `clasp deploy` sobre el deploymentId de producción del asistente (`§Publicación` del `CLAUDE.md`: `AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w`). **El muro `npm run e2e:wizard` VERDE va ANTES de cualquier publicación.**
- Todo a `main`. NO crear ramas. NO abrir PR.

# Reporte

Primera línea literal exigida arriba. Luego, CORTO:
- (a): qué cambió en el gate, qué texto nuevo, y el resultado del muro (última línea de `e2e:wizard`) + que la afirmación nueva salió ROJA con el código de hoy.
- (b): la constante cambiada y confirmación de `node --check`.
- Qué se publicó (frontend por CI, backend por clasp deploy) y qué queda commiteado.
- ⚠️ **Pregunta abierta que NO cierras tú**: queda por confirmar que el disparador programado del espejo dispara SOLO cada 15 min entre visitas (no solo cuando se fuerza a mano). Déjalo anotado para el orquestador; NO instales ni toques disparadores por tu cuenta.

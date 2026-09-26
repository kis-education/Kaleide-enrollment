# `scripts/servidor/` — el molde de un arnés del servidor

**Esto es una INSTRUCCIÓN para quien escriba el siguiente, no un histórico.** Si vas a arreglar algo
de `backend/Code.js` y escribes un instrumento para comprobar que tu arreglo funciona, **ese
instrumento se guarda aquí y ya no se tira** (Diego, 2026-09-23: *«si arregla las cosas, adelante»*;
`../../CLAUDE.md` §"⛔⛔ Y ESE ARNÉS YA NO SE TIRA").

**Se ejecutan solos**: `node scripts/comprobar-el-servidor.mjs` descubre **todos** los `*.mjs` de esta
carpeta, los lanza y junta sus veredictos. Ese lanzador es el **noveno control de CI** y `build`
depende de él ⇒ **un arnés en ROJO impide publicar**. No hay que apuntar el tuyo en ninguna lista: con
dejarlo aquí, entra.

## Lo que el lanzador EXIGE — y qué pasa si no lo cumples

| Exigencia | Si no |
|---|---|
| La **ÚLTIMA línea con texto** es `VEREDICTO: VERDE — N afirmaciones` o `VEREDICTO: ROJO — <motivo>` | ROJO: «su última línea no es un veredicto» |
| El **código de salida** no contradice esa línea (VERDE ⇒ 0) | ROJO: «dice VERDE y termina con código N» |
| **Termina** (tope de 180 s; los de hoy tardan ~1 s) | ROJO: «no terminó y se cortó» |
| Escribe **algo** | ROJO: «no escribió ni una línea» |
| Un **VERDE** declara **cuántas afirmaciones corrió**, y son **≥ 1** | ROJO: «dice VERDE sin declarar cuántas afirmaciones corrió» / «con CERO» |

⛔ **El veredicto se imprime SIEMPRE**, también ante un error fatal del propio arnés — `try/finally`,
nunca un `process.exit` a mitad. Un arnés que revienta en silencio sale con código 0 y CI lo da por
bueno: ése es el verde falso que todo esto viene a impedir.

### ⛔ `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — EL VERDE CUENTA LO QUE MIDIÓ

**Un arnés que se quedó sin afirmaciones —una excepción tapada, un renombrado que un `catch` se
tragó, un refactor que vació el cuerpo— seguía diciendo VERDE.** Las otras cuatro exigencias de
arriba no lo cazan: terminó, escribió algo, su código de salida es 0 y su última línea empieza por
`VERDE`. Por eso el VERDE tiene que llevar **cuántas afirmaciones corrió de verdad, contadas EN
EJECUCIÓN** (nunca contando líneas del fuente: eso mediría lo que el arnés DICE que comprueba, no
lo que comprobó ESTA vez):

```
VEREDICTO: VERDE — 13 afirmaciones
VEREDICTO: VERDE — 13 afirmaciones: lo que sea que quieras contar además, tal cual hacías antes.
```

**Cómo se cuenta, según tu forma:**

- **Si ya usas un `afirmar(nombre, condicion, porque)` compartido** (mira
  `el-catalogo-de-preguntas.mjs`): un `let total = 0` fuera de la función y `total++` en su
  primera línea. Cada llamada —pase o falle— es una afirmación, y eso incluye las de las
  roturas demostradas: son afirmaciones también.
- **Si comprueba con `if (condición_de_fallo) fallos.push(mensaje)` a pelo** (mira
  `cada-tutor-con-su-enlace.mjs`): un `total++` justo antes de cada `if` de ésos, uno por
  cada check independiente — un `if`/`else if` que decide ENTRE mensajes de la MISMA
  comprobación cuenta como UNA, no como dos.

**El motivo del ROJO no necesita esto**: ya nombra qué falló, y eso ya prueba que algo se
ejecutó. Es el VERDE el que puede mentir en silencio, y es el único que se exige.

## Lo que un arnés ES aquí

1. **EJECUTA el código real, no lee sus líneas.** Los ocho controles anteriores son detectores por
   líneas; éstos cargan `backend/Code.js` (entero en un `vm`, o extrayendo las funciones del fuente) y
   **llaman a las funciones de verdad** con dobles en memoria. Si la función cambia, tu arnés mide la
   nueva — no una copia de su lógica.
2. **Sin red, sin navegador, sin `npm ci`, sin un solo dato real.** Todo sintético, y los correos en
   el dominio reservado `.invalid` (RFC 2606). No manda ni un aviso y no toca ninguna tabla.
3. **Dice en su cabecera QUÉ PROTEGE en una frase, y QUÉ NO AFIRMA.** Lo segundo importa igual: un
   arnés que no habla con el KMS no dice nada sobre si el KMS acepta la escritura, y callarlo hace que
   alguien dé por cubierto lo que no lo está.

## ⛔ Y LLEVA SUS ROTURAS DEMOSTRADAS DENTRO

**Una comprobación que nunca se ha visto fallar no es una red.** Cada arnés, al final, vuelve a
correr sus afirmaciones sobre una copia **MUTILADA** del fuente y exige que salgan rojas:

- **Si la mutilación no cambia el fuente, se canta**: el texto que buscaba ya no está y la rotura
  estaba pasando **en vacío**.
- **Un RENOMBRADO tiene que salir «MEDICIÓN CIEGA», nunca VERDE.** Si la función que mides deja de
  llamarse así, tu arnés no está midiendo: está mirando a un sitio donde ya no hay nada.
- Si una mutilación **no** pone roja su afirmación, el arnés lo dice de sí mismo y sale ROJO.

El lanzador tiene su propia versión de esto (`autocomprobación`): antes de juzgar a nadie, ejecuta un
arnés sintético de cada color y exige distinguirlos. Si su lectura del veredicto se afloja, **todos
los rojos se volverían verdes en silencio**.

## Lo que esto NO es

⛔ **No sustituye a la batería** (`npm run e2e:wizard`), que mide el NAVEGADOR contra un backend
simulado y nunca ejecuta `backend/Code.js`. ⛔ **Ni a la prueba manual de Diego**, que sigue siendo la
red del producto. ⛔ **Y no es una campaña**: no se reconstruyen los 54 arneses efímeros del
histórico — se conserva **el que se escriba a partir de ahora**.

⛔ **Un arnés que estorba se ARREGLA o se RETIRA diciéndolo.** Aflojarlo para que pase, o dejarlo
pasando en vacío, es apagar el control en silencio: el commit siguiente ya sale verde.

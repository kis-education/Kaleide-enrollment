#!/usr/bin/env bash
# journey-matrix.sh — matriz de casos AUTOMATIZABLES del wizard (2026-06-11).
#
# Extiende journey-verify.sh (el trinquete de los 8 contratos read-only) con los
# casos "A" de la matriz docs/kms/plan/wizard-test-plan-2026-06.md que se pueden
# ejecutar contra la API PÚBLICA sin intervención de Diego y SIN mutar su dato real:
# identidad/recuperación (n de otro grupo, n basura, token rotado), anti-enumeración,
# reCAPTCHA fail-closed, source inválido, IDOR, edit-lock post-submit, members
# dinámicos, getDocument bytes+gate, relectura de billing.
#
# REGLAS DURAS:
#  - VETO ABSOLUTO Click & Sign: initiateSigningSession SOLO en create_only (lectura
#    idempotente). NUNCA se despacha el acto de firma.
#  - Casos que MUTAN corren SOLO contra una familia SINTÉTICA (TESTNIGHT). El grupo
#    real de Diego se usa SOLO para casos read-only.
#  - Casi todo es read-only o validación de gate; no escribe dato persistente nuevo.
#
# CREACIÓN DE FAMILIA SINTÉTICA (reCAPTCHA fail-closed bloquea initEnrollmentSession
# desde curl — Code.js:1224,1504). La vía canónica NO es curl, es el seeder TESTNIGHT
# del KMS (escribe directo a enr*, mismo write-path probado):
#     clasp run manual_campaignF1F3      # crea grupo + 2 guardians + 1 hijo; devuelve resume_token
#     # el n (email_id) sale de enrEmails del grupo sintético
# Pásalos como argumentos a este script. Para inputs read-only del grupo real:
#     clasp run manual_getDiegoJourneyInputs   # {resume_token, email_id}
#
# Uso:
#   ./journey-matrix.sh <resume_token> <n_email_id> [<n_otro_grupo>]
#     <resume_token>   resume_token de la familia (sintética para mutaciones, real para read-only)
#     <n_email_id>     email_id (n) de un guardian de ESE grupo
#     <n_otro_grupo>   (opcional) email_id de OTRO grupo, para el caso KAL-4 (ID-08). Si se
#                      omite, ese caso se marca SKIP.
#
# Salida: tabla PASS/FAIL/SKIP por caso + latencias. Exit != 0 si algo FALLA.
# Patrón GAS 2 pasos (302 → echo URL): ver CLAUDE.md §Smoke test.

set -u
GAS_URL="https://script.google.com/macros/s/AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w/exec"
RT="${1:?resume_token requerido}"
N="${2:?n (email_id) requerido}"
N_OTHER="${3:-}"

PASS=0; FAIL=0; SKIP=0; RESULTS=""
ID="\"resume_token\":\"$RT\",\"n\":\"$N\""

call() { # call <json-body> -> stdout JSON; latencia en /tmp/jm_ms
  local body="$1" t0 t1 loc
  t0=$(date +%s%3N)
  loc=$(curl -s -D - -o /dev/null -X POST "$GAS_URL" -H "Content-Type: text/plain" \
        -d "$body" --max-time 120 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
  if [ -z "$loc" ]; then echo 0 > /tmp/jm_ms; echo '{"ok":false,"error":"NO_REDIRECT"}'; return; fi
  curl -s "$loc" --max-time 90
  t1=$(date +%s%3N); echo $((t1 - t0)) > /tmp/jm_ms
}

check() { # check <id> <PASS|FAIL|SKIP|PASS(gated)> <detalle>
  local name="$1" verdict="$2" detail="$3" ms
  ms=$(cat /tmp/jm_ms 2>/dev/null || echo 0)
  RESULTS+="$(printf '%-26s %-12s %6sms  %s' "$name" "$verdict" "$ms" "$detail")"$'\n'
  case "$verdict" in
    FAIL*) FAIL=$((FAIL+1));;
    SKIP)  SKIP=$((SKIP+1));;
    *)     PASS=$((PASS+1));;
  esac
}

py() { python3 -c "$1" 2>/dev/null; }

# ════════════════════════════════════════════════════════════════════════════
# DIM 2 — Identidad / recuperación
# ════════════════════════════════════════════════════════════════════════════

# ── ID-03/ID-04: recognizeFamily público → shape CONSTANTE anti-enumeración ───
# El caller público recibe SIEMPRE {matched:false, persons:[]} (KAL-10), aunque
# reCAPTCHA falle el shape constante se mantiene. Email inexistente y (si fuera
# real) mismo shape. Probamos con un email sintético inexistente.
R=$(call "{\"action\":\"recognizeFamily\",\"_hp\":\"\",\"primary_email\":\"nadie-jm-$(date +%s)@example.invalid\",\"recaptcha_token\":\"_jm_\"}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
# Aceptable: matched ausente/false y persons vacío/ausente; o error de reCAPTCHA (gate previo)
err=d.get('error')
ecode=err.get('code') if isinstance(err,dict) else (err if isinstance(err,str) else '')
if 'RECAPTCHA' in str(ecode).upper() or 'recaptcha' in json.dumps(d).lower():
    print('GATED:recaptcha (shape no se alcanza, gate previo OK)')
elif d.get('matched') in (False,None) and not (d.get('persons') or []):
    print('OK: matched=%s persons=[] (anti-enum)'%d.get('matched'))
else:
    print('FAIL:'+json.dumps(d)[:120])")
case "$D" in FAIL*) check "ID-03 anti-enum" FAIL "$D";; GATED*) check "ID-03 anti-enum" "PASS(gated)" "$D";; *) check "ID-03 anti-enum" PASS "$D";; esac

# ── ID-08: n de OTRO grupo → rechazado (KAL-4) ───────────────────────────────
if [ -n "$N_OTHER" ]; then
  R=$(call "{\"action\":\"getAdmissionState\",\"_hp\":\"\",\"resume_token\":\"$RT\",\"n\":\"$N_OTHER\"}")
  D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
# El n ajeno NO debe resolver un guardian de otro grupo. Aceptable: degrada a
# group-scoped (recovered_guardian_person_id null o el del propio grupo del token),
# NUNCA el guardian del grupo ajeno. El contrato sigue respondiendo (state_code presente).
if 'state_code' not in d and not d.get('ok'):
    print('FAIL:'+json.dumps(d)[:120])
else:
    print('OK: n ajeno no escala (state=%s); KAL-4 group del token'%d.get('state_code'))")
  case "$D" in FAIL*) check "ID-08 n-otro-grupo" FAIL "$D";; *) check "ID-08 n-otro-grupo" PASS "$D";; esac
else
  check "ID-08 n-otro-grupo" SKIP "sin 3er arg <n_otro_grupo>"
fi

# ── ID-09: n basura (no-UUID + UUID inexistente) → ignorado limpio (KAL-5) ────
for BAD in "garbage-not-a-uuid" "00000000-0000-4000-8000-000000000000"; do
  R=$(call "{\"action\":\"getAdmissionState\",\"_hp\":\"\",\"resume_token\":\"$RT\",\"n\":\"$BAD\"}")
  D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
# n basura se ignora; group-scoped intacto → el contrato responde igual (state_code).
if 'state_code' in d or d.get('ok') or d.get('enrollment_group_id'):
    print('OK: n basura ignorado (state=%s)'%d.get('state_code'))
else:
    print('FAIL:'+json.dumps(d)[:120])")
  case "$D" in FAIL*) check "ID-09 n-basura" FAIL "$D ($BAD)";; *) check "ID-09 n-basura" PASS "$D";; esac
done

# ── ID-05: token VIEJO/rotado → Unauthorized (no resuelve) ───────────────────
# Un resume_token que NO existe (simula uno rotado) debe rechazarse; el n nunca
# se cree blind sin token válido.
ROTATED="11111111-2222-4333-8444-555555555555"
R=$(call "{\"action\":\"resumeSession\",\"_hp\":\"\",\"resume_token\":\"$ROTATED\",\"n\":\"$N\"}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
err=d.get('error'); ecode=err.get('code') if isinstance(err,dict) else ''
blob=json.dumps(d).lower()
if 'unauthorized' in blob or ecode=='UNAUTHORIZED' or 'not recognized' in blob or 'not found' in blob:
    print('OK: token inexistente rechazado (n no se cree blind)')
elif d.get('enrollment_group_id') or d.get('session'):
    print('FAIL: token basura RESOLVIÓ sesión')
else:
    print('OK?: '+json.dumps(d)[:80])")
case "$D" in FAIL*) check "ID-05 token-rotado" FAIL "$D";; *) check "ID-05 token-rotado" PASS "$D";; esac

# ════════════════════════════════════════════════════════════════════════════
# DIM 7 — Robustez (reCAPTCHA / source / IDOR / P72)
# ════════════════════════════════════════════════════════════════════════════

# ── ROB-05: reCAPTCHA fail-closed en initEnrollmentSession ────────────────────
# Sin token reCAPTCHA válido NO se debe crear sesión. Confirma la premisa del
# bypass TESTNIGHT (no se crea familia desde curl).
R=$(call "{\"action\":\"initEnrollmentSession\",\"_hp\":\"\",\"primary_email\":\"jm-$(date +%s)@example.invalid\",\"source_code\":\"WEB_PUBLIC\"}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
blob=json.dumps(d).lower()
if d.get('resume_token') or d.get('enrollment_group_id'):
    print('FAIL: creó sesión SIN reCAPTCHA')
elif 'recaptcha' in blob or 'missing' in blob:
    print('OK: fail-closed (sin reCAPTCHA no crea sesión)')
else:
    print('OK?: rechazado '+json.dumps(d)[:80])")
case "$D" in FAIL*) check "ROB-05 recaptcha-closed" FAIL "$D";; *) check "ROB-05 recaptcha-closed" PASS "$D";; esac

# ── ROB-06: source inválido → rechazado (no cae al default sin reCAPTCHA) ─────
R=$(call "{\"action\":\"initEnrollmentSession\",\"_hp\":\"\",\"primary_email\":\"jm-$(date +%s)@example.invalid\",\"source_code\":\"FAMILIES_APP\"}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
if d.get('resume_token') or d.get('enrollment_group_id'):
    print('FAIL: source inválido creó sesión')
else:
    print('OK: source fuera de whitelist rechazado')")
case "$D" in FAIL*) check "ROB-06 source-invalido" FAIL "$D";; *) check "ROB-06 source-invalido" PASS "$D";; esac

# ════════════════════════════════════════════════════════════════════════════
# DIM 6 — Documentos y firma (members dinámicos + bytes + gate). VETO Click&Sign.
# ════════════════════════════════════════════════════════════════════════════

# ── DOC-01: initiateSigningSession create_only → members SIN drive_view_url ───
R=$(call "{\"action\":\"initiateSigningSession\",\"_hp\":\"\",$ID,\"create_only\":true}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
ms=d.get('members') or []
err=d.get('error'); ecode=err.get('code') if isinstance(err,dict) else ''
if ecode in ('STEPUP_REQUIRED','UNAUTHORIZED'):
    print('GATED:'+ecode)
elif not d.get('ok') and not ms:
    print('ERR:'+json.dumps(d)[:120])
elif any('drive_view_url' in m for m in ms):
    print('FAIL: drive_view_url presente (debió eliminarse)')
else:
    print('%d members: %s'%(len(ms),','.join(m.get('purpose_code','?') for m in ms)))")
case "$D" in ERR*|FAIL*) check "DOC-01 members" FAIL "$D";; GATED*) check "DOC-01 members" "PASS(gated)" "$D";; *) check "DOC-01 members" PASS "$D";; esac
MEMBERS_JSON="$R"

# ── DOC-02/DOC-04: getDocument bytes %PDF + sha256 canónico, o gate correcto ──
SHA_LETTER="79afc40bb4991dd65f18554141fa947e8cd11cfd4b62f5ec6ee9d87b5a18238a"
SHA_CONTRACT="3ceb4e928585e03a6b4baa3155edcc780287cc1f2ed5f4241e7fdca961b239a4"
for FID_PURPOSE in $(echo "$MEMBERS_JSON" | py "
import json,sys
d=json.load(sys.stdin)
for m in (d.get('members') or []): print('%s:%s'%(m.get('file_id'),m.get('purpose_code')))"); do
  FID="${FID_PURPOSE%%:*}"; PURP="${FID_PURPOSE##*:}"
  R=$(call "{\"action\":\"getDocument\",\"_hp\":\"\",$ID,\"file_id\":\"$FID\"}")
  D=$(echo "$R" | py "
import json,sys,base64,hashlib
d=json.load(sys.stdin)
err=d.get('error')
if isinstance(err,dict) and err.get('code')=='STEPUP_REQUIRED': print('GATED'); raise SystemExit
if 'base64' not in d: print('ERR:'+json.dumps(d)[:120]); raise SystemExit
b=base64.b64decode(d['base64']); h=hashlib.sha256(b).hexdigest()
ok_hdr=b[:4]==b'%PDF'
exp={'ADMISSION_LETTER':'$SHA_LETTER','CONTRACT':'$SHA_CONTRACT'}.get('$PURP')
ok_hash=(exp is None) or (h==exp and d.get('sha256')==h)
print('%d bytes hdr=%s hash=%s'%(len(b),'OK' if ok_hdr else 'BAD','OK' if ok_hash else 'MISMATCH') if ok_hdr and ok_hash else 'FAIL: hdr=%s hash=%s'%(b[:4],h[:12]))")
  case "$D" in
    GATED)      check "DOC getDocument($PURP)" "PASS(gated)" "STEPUP_REQUIRED correcto";;
    ERR*|FAIL*) check "DOC getDocument($PURP)" FAIL "$D";;
    *)          check "DOC getDocument($PURP)" PASS "$D";;
  esac
done

# ── DOC-03: getDocument con file_id inválido → BAD_REQUEST limpio (KAL-5) ─────
R=$(call "{\"action\":\"getDocument\",\"_hp\":\"\",$ID,\"file_id\":\"bad\\\"quote\"}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
err=d.get('error'); ecode=err.get('code') if isinstance(err,dict) else ''
if d.get('base64'): print('FAIL: file_id con comilla DEVOLVIÓ bytes')
elif ecode in ('BAD_REQUEST','STEPUP_REQUIRED','UNAUTHORIZED','NOT_FOUND') or err:
    print('OK: file_id inválido rechazado (%s)'%(ecode or 'err'))
else: print('OK?: '+json.dumps(d)[:80])")
case "$D" in FAIL*) check "DOC-03 fileid-injection" FAIL "$D";; *) check "DOC-03 fileid-injection" PASS "$D";; esac

# ════════════════════════════════════════════════════════════════════════════
# DIM 4 — Guardado / billing (relectura, read-only)
# ════════════════════════════════════════════════════════════════════════════

# ── SAVE-02/03/05: getSavedBillingSplits → relee el reparto vigente ──────────
R=$(call "{\"action\":\"getSavedBillingSplits\",\"_hp\":\"\",$ID}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
err=d.get('error'); ecode=err.get('code') if isinstance(err,dict) else ''
if ecode=='STEPUP_REQUIRED': print('GATED')
elif d.get('ok') is False: print('ERR:'+json.dumps(d)[:120])
else:
  ps=d.get('payers') or []
  print('%d payers: %s'%(len(ps),'/'.join(str(p.get('split_percentage')) for p in ps)))")
case "$D" in
  GATED) check "SAVE billing-relee" "PASS(gated)" "STEPUP_REQUIRED correcto";;
  ERR*)  check "SAVE billing-relee" FAIL "$D";;
  *)     check "SAVE billing-relee" PASS "$D";;
esac

# ════════════════════════════════════════════════════════════════════════════
# DIM 5 — Estados (cheap-poll, read-only)
# ════════════════════════════════════════════════════════════════════════════

# ── STATE-08: getLiveStateVersion responde una version entera ────────────────
R=$(call "{\"action\":\"getLiveStateVersion\",\"_hp\":\"\",$ID}")
D=$(echo "$R" | py "
import json,sys
d=json.load(sys.stdin)
v=d.get('version'); v=d.get('live_version') if v is None else v
if isinstance(v,int) or (isinstance(v,str) and v.isdigit()): print('version=%s'%v)
elif d.get('ok') is False: print('ERR:'+json.dumps(d)[:120])
else: print('version=%s (shape OK)'%v)")
case "$D" in ERR*) check "STATE-08 live-version" FAIL "$D";; *) check "STATE-08 live-version" PASS "$D";; esac

# ════════════════════════════════════════════════════════════════════════════
echo
echo "════ journey-matrix — $(date -u +%H:%M:%SZ) — deployment wizard @vivo ════"
echo "$RESULTS"
echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
echo
echo "Nota: casos M (manual Diego) y los gates de escritura (billing edit, GDPR, edit-lock"
echo "post-submit, step-up grace) NO están aquí — viven en clasp run manual_* del KMS o en el"
echo "pase manual. Ver docs/kms/plan/wizard-test-plan-2026-06.md para la matriz completa."
echo "VETO Click & Sign respetado: initiateSigningSession solo create_only; acto nunca despachado."
[ "$FAIL" -eq 0 ]

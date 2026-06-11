#!/usr/bin/env bash
# journey-verify.sh — trinquete anti-regresión del wizard (2026-06-11).
#
# Recorre el viaje del wizard contra la API PÚBLICA real (deployment @vivo) y
# verifica forma + invariantes de cada contrato que el frontend consume. Se
# ejecuta tras CADA deploy (backend @N o frontend vX.Y.Z): si algo que ayer
# funcionaba se rompe, este script lo dice ANTES de que lo pise una familia.
#
# Origen: orden de Diego 2026-06-11 — "estamos dando vueltas sin salida": el
# refactor de perf rompió el flujo 7→11 que funcionaba (precedente DL-C). El
# trinquete convierte "ayer funcionaba" en comprobación mecánica.
#
# Uso:   ./journey-verify.sh <resume_token> <n_email_id>
#        (inputs reales: KMS clasp run manual_getDiegoJourneyInputs)
# Salida: tabla PASS/FAIL por contrato + latencias. Exit != 0 si algo FALLA.
#
# Notas:
# - Endpoints PII-gated responden STEPUP_REQUIRED sin ventana OTP fresca: eso
#   se marca PASS(gated) — el gate respondiendo correctamente ES el contrato.
# - JAMÁS llama al acto de firma real (veto Click & Sign): initiateSigningSession
#   solo en modo lectura create_only (idempotente, verificado hoy).
# - Patrón GAS 2 pasos (302 → echo URL): ver CLAUDE.md §Smoke test.

set -u
GAS_URL="https://script.google.com/macros/s/AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w/exec"
RT="${1:?resume_token requerido}"
N="${2:?n (email_id) requerido}"

# sha256 canónicos de los PDF del paquete (DOC-BYTES 2026-06-11, triple verificación)
SHA_LETTER="79afc40bb4991dd65f18554141fa947e8cd11cfd4b62f5ec6ee9d87b5a18238a"
SHA_CONTRACT="3ceb4e928585e03a6b4baa3155edcc780287cc1f2ed5f4241e7fdca961b239a4"

PASS=0; FAIL=0; RESULTS=""

call() { # call <json-body> -> stdout JSON; latencia en /tmp/jv_ms (subshell-safe)
  local body="$1" t0 t1 loc
  t0=$(date +%s%3N)
  loc=$(curl -s -D - -o /dev/null -X POST "$GAS_URL" -H "Content-Type: text/plain" \
        -d "$body" --max-time 120 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
  if [ -z "$loc" ]; then echo 0 > /tmp/jv_ms; echo '{"ok":false,"error":"NO_REDIRECT"}'; return; fi
  curl -s "$loc" --max-time 90
  t1=$(date +%s%3N); echo $((t1 - t0)) > /tmp/jv_ms
}

check() { # check <nombre> <resultado PASS|FAIL|PASS(gated)> <detalle>
  local name="$1" verdict="$2" detail="$3" ms
  ms=$(cat /tmp/jv_ms 2>/dev/null || echo 0)
  RESULTS+="$(printf '%-34s %-12s %6sms  %s' "$name" "$verdict" "$ms" "$detail")"$'\n'
  case "$verdict" in FAIL*) FAIL=$((FAIL+1));; *) PASS=$((PASS+1));; esac
}

py() { python3 -c "$1" 2>/dev/null; }

ID="\"resume_token\":\"$RT\",\"n\":\"$N\""

# ── 1. resumeSession: el token resuelve sesión ────────────────────────────────
R=$(call "{\"action\":\"resumeSession\",\"_hp\":\"\",$ID}")
OK=$(echo "$R" | py "import json,sys; d=json.load(sys.stdin); print('y' if (d.get('ok') or d.get('enrollment_group_id') or d.get('session')) else json.dumps(d)[:120])")
[ "$OK" = "y" ] && check "resumeSession" PASS "sesión resuelta" || check "resumeSession" FAIL "$OK"

# ── 2. getAdmissionState: estado + semántica de firma (triple P245) ──────────
R=$(call "{\"action\":\"getAdmissionState\",\"_hp\":\"\",$ID}")
D=$(echo "$R" | py "
import json,sys; d=json.load(sys.stdin)
ks=('state_code','signing_status','signing_ready')
missing=[k for k in ks if k not in d]
print('MISSING:'+','.join(missing) if missing else 'state=%s status=%s ready=%s'%(d.get('state_code'),d.get('signing_status'),d.get('signing_ready')))")
case "$D" in MISSING*|"") check "getAdmissionState" FAIL "$D";; *) check "getAdmissionState" PASS "$D";; esac

# ── 3. fetchLookups: catálogos no-PII ────────────────────────────────────────
R=$(call "{\"action\":\"fetchLookups\",\"_hp\":\"\",$ID}")
NL=$(echo "$R" | py "import json,sys; d=json.load(sys.stdin); print(len(d.get('lookups') or d.get('data') or d) if (d.get('ok',True)) else 'ERR')")
[ "$NL" != "ERR" ] && [ -n "$NL" ] && check "fetchLookups" PASS "$NL grupos" || check "fetchLookups" FAIL "$(echo "$R" | head -c 100)"

# ── 4. initiateSigningSession (LECTURA create_only): members sin drive_view_url ─
R=$(call "{\"action\":\"initiateSigningSession\",\"_hp\":\"\",$ID,\"create_only\":true}")
D=$(echo "$R" | py "
import json,sys; d=json.load(sys.stdin)
ms=d.get('members') or []
if not d.get('ok') and not ms: print('ERR:'+json.dumps(d)[:120])
elif any('drive_view_url' in m for m in ms): print('FAIL:drive_view_url presente')
else: print('%d members: %s'%(len(ms),','.join(m.get('purpose_code','?') for m in ms)))")
case "$D" in ERR*|FAIL*) check "initiateSigningSession(read)" FAIL "$D";; *) check "initiateSigningSession(read)" PASS "$D";; esac
MEMBERS_JSON="$R"

# ── 5. getDocument por member: bytes %PDF + sha256 canónico (o gate correcto) ─
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
b=base64.b64decode(d['base64'])
h=hashlib.sha256(b).hexdigest()
ok_hdr=b[:4]==b'%PDF'
exp={'ADMISSION_LETTER':'$SHA_LETTER','CONTRACT':'$SHA_CONTRACT'}.get('$PURP')
ok_hash=(exp is None) or (h==exp and d.get('sha256')==h)
print('%d bytes hdr=%s hash=%s'%(len(b),'OK' if ok_hdr else 'BAD','OK' if ok_hash else 'MISMATCH') if ok_hdr and ok_hash else 'FAIL: hdr=%s hash=%s vs %s'%(b[:4],h[:12],(exp or '?')[:12]))")
  case "$D" in
    GATED)      check "getDocument($PURP)" "PASS(gated)" "STEPUP_REQUIRED correcto";;
    ERR*|FAIL*) check "getDocument($PURP)" FAIL "$D";;
    *)          check "getDocument($PURP)" PASS "$D";;
  esac
done

# ── 6. getSavedBillingSplits: relectura del reparto ──────────────────────────
R=$(call "{\"action\":\"getSavedBillingSplits\",\"_hp\":\"\",$ID}")
D=$(echo "$R" | py "
import json,sys; d=json.load(sys.stdin)
err=d.get('error')
if isinstance(err,dict) and err.get('code')=='STEPUP_REQUIRED': print('GATED')
elif d.get('ok') is False: print('ERR:'+json.dumps(d)[:120])
else:
  ps=d.get('payers') or []
  print('%d payers: %s'%(len(ps),'/'.join(str(p.get('split_percentage')) for p in ps)))")
case "$D" in
  GATED)  check "getSavedBillingSplits" "PASS(gated)" "STEPUP_REQUIRED correcto";;
  ERR*)   check "getSavedBillingSplits" FAIL "$D";;
  *)      check "getSavedBillingSplits" PASS "$D";;
esac

# ── 7. hydrateSession: el gate PII responde (gated o datos) ──────────────────
R=$(call "{\"action\":\"hydrateSession\",\"_hp\":\"\",$ID}")
D=$(echo "$R" | py "
import json,sys; d=json.load(sys.stdin)
if d.get('pii_gated'): print('pii_gated=true (gate OK)')
elif d.get('ok') or d.get('persons') or d.get('step_data'): print('hidratado con datos')
else: print('ERR:'+json.dumps(d)[:120])")
case "$D" in ERR*) check "hydrateSession" FAIL "$D";; *) check "hydrateSession" PASS "$D";; esac

echo
echo "════ journey-verify — $(date -u +%H:%M:%SZ) — deployment wizard @vivo ════"
echo "$RESULTS"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

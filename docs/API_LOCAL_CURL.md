# Guía de la API con curl (local)

Estos son los endpoints que el agente de HappyRobot llamará como tools, en el orden de una llamada real. Los ejemplos de respuesta son reales: los saqué de la API corriendo contra el TMS falso.

## 0. Preparación

Con Docker:
```bash
git pull
docker compose up --build        # API en :8080 + TMS falso
```

Sin Docker (solo Node 20 o superior):
```bash
git pull && npm install
# en .env, para usar el TMS falso local:
#   TMS_HOST=127.0.0.1
#   TMS_PORT=9100
#   TMS_TOKEN=dev-token
# (o los valores del TMS real, y te saltas la terminal 1)

npm run tms:fake     # terminal 1: TMS falso en :9100
npm run dev          # terminal 2: API en :8080, lee .env y se recarga al guardar
```
Sin Docker, el código OTP aparece directamente en la terminal 2 (`[DEV OTP] code=...`).

En otra terminal (en Windows usa Git Bash o WSL; los `export` no funcionan en PowerShell):

```bash
export BASE=http://localhost:8080
export KEY=$(grep '^API_KEY=' .env | cut -d= -f2)   # la misma API_KEY de tu .env
export CALL=demo-$(date +%s)                           # id de la llamada; en HappyRobot será el id de la call
```

Cada llamada tiene su propio `CALL`. El backend guarda el estado (MC verificado, OTP, loads ofrecidas, negociación) por ese id. **Para empezar otra llamada, genera otro `CALL`.**

Todas las rutas menos `/health` exigen la cabecera `x-api-key`. Las reglas de negocio responden siempre HTTP 200 con `ok: true/false` y un `agent_guidance` que le dice al agente qué decir. Los 4xx quedan para errores de autenticación o de formato.

---

## 1. Health

```bash
curl -s $BASE/health
```
```json
{"ok":true,"fmcsa":"mock","tms":"live"}
```
`tms: "live"` significa que habla TCP con un TMS: el falso de Docker o el real, según tu `.env`.

## 2. Verificar el carrier (FMCSA)

```bash
curl -s -X POST $BASE/v1/calls/$CALL/verify-carrier \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"mc_number":"MC-123456"}'
```
```json
{"ok":true,"eligible":true,"mc_number":"123456","carrier_name":"Blue Ridge Transport LLC","agent_guidance":"Confirm the company name with the carrier, then send the verification code."}
```
Acepta `"MC-123456"`, `"MC 123456"` o `123456`.

MC de prueba con `FMCSA_MODE=mock`:

| MC | Resultado |
|---|---|
| 123456 | elegible, con teléfono en FMCSA (el OTP va por SMS) |
| 234567 | elegible, con email en el directorio (el OTP va por email) |
| 345678 | `eligible:false`, sin autoridad activa |
| 456789 | `eligible:false`, no autorizado a operar |
| 999999 | FMCSA caído (`fmcsa_unavailable`) |
| cualquier otro | `mc_not_found` |

## 3. Enviar el OTP

```bash
curl -s -X POST $BASE/v1/calls/$CALL/otp/send \
  -H "x-api-key: $KEY" -H "content-type: application/json" -d '{}'
```
```json
{"ok":true,"sent":true,"channel":"sms","sent_to":"***-***-0101","expires_in_seconds":300,"agent_guidance":"Tell them a 6-digit code was sent to ***-***-0101 and ask them to read it back."}
```
La respuesta **no trae el código**. En local (`OTP_DELIVERY=console`) aparece en los logs de la API:

```bash
docker compose logs api | grep "DEV OTP" | tail -1
# ... "[DEV OTP] code=589345 (never enable console delivery in production)"
```

Body opcional: `{"caller_contact":"+15551234567"}`. Solo se usa si el carrier no tiene contacto registrado. Si lo tiene, se ignora.

**A dónde va el código**, por prioridad:
1. `OTP_DEMO_CONTACT` del `.env`, si está definido. Todos los códigos van a tu teléfono o email (modo demo).
2. El contacto del carrier en el directorio.
3. El teléfono que devuelve FMCSA.
4. `caller_contact` del body.

Si no hay ninguno, la respuesta es `no_contact_on_file` y el agente pide un número. Para pruebas locales, pon tu número en `OTP_DEMO_CONTACT` (formato E.164, por ejemplo `+5215512345678`) o manda `caller_contact` en el body.

## 4. Verificar el OTP

```bash
curl -s -X POST $BASE/v1/calls/$CALL/otp/verify \
  -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"code":"589345"}'
```
Correcto:
```json
{"ok":true,"verified":true,"agent_guidance":"Verified. Ask where they are and where they want to go, and their equipment type."}
```
Incorrecto (prueba con `000000`):
```json
{"ok":true,"verified":false,"reason":"mismatch","attempts_left":2,"agent_guidance":"That code does not match. Ask them to read it again."}
```
Al tercer fallo responde `locked: true` y la llamada termina como `otp_failed`. Ni el código correcto la desbloquea.

## 5. Buscar loads

```bash
curl -s -X POST $BASE/v1/calls/$CALL/loads/search \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"origin":"Houston, TX","equipment_type":"dry van"}'
```
```json
{"ok":true,"loads":[{"load_id":"LD00925","origin":"Houston, TX","destination":"Memphis, TN","pickup_datetime":"2026-10-14T15:05:00","delivery_datetime":"2026-10-15T10:05:00","equipment_type":"DRY_VAN","offer_rate":1277,"miles":484,"weight_lbs":20692,"commodity":"General Freight","pieces":8,"dimensions":"45ft x 8ft x 9ft","notes":null}],"agent_guidance":"Pitch the first load briefly: lane, pickup time, equipment, weight, and offer_rate. Ask if it works for them."}
```
- Campos opcionales: `origin`, `destination` y `equipment_type`, con al menos uno. Ejemplos: `"Chicago"`, `"Chicago, IL"`, `"TX"`, `"reefer"`, `"flatbed"`, `"power only"`.
- Solo devuelve `offer_rate`, el precio que el agente debe ofrecer. **Nunca** devuelve `RATE` ni `MAX_BUY`.
- Si llamas aquí sin haber verificado el OTP, responde `identity_not_verified`.

Con el TMS falso hay loads en Houston/Austin TX, Chicago IL, Atlanta GA, Miami FL y Gary IN.

## 6. Negociar (una llamada por cada movimiento del carrier)

El carrier pide más (contraoferta):
```bash
curl -s -X POST $BASE/v1/calls/$CALL/negotiate \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"load_id":"LD00925","action":"counter","amount":1600}'
```
```json
{"ok":true,"decision":"counter","rate":1370,"rounds_left":2,"agent_guidance":"Counter at $1370. Do not mention any limit or ceiling."}
```
Si baja a algo que podemos pagar:
```bash
curl -s -X POST $BASE/v1/calls/$CALL/negotiate \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"load_id":"LD00925","action":"counter","amount":1450}'
```
```json
{"ok":true,"decision":"accept","rate":1450,"agent_guidance":"Agree at $1450. Confirm the load and rate back to them, then book it."}
```
Otras acciones: `{"load_id":"LD00925","action":"accept"}` (acepta nuestra última oferta) y `{"load_id":"LD00925","action":"decline"}` (rechaza el load).

Después de 3 contraofertas sin acuerdo, la siguiente responde `decision: "reject"` con `reason: "max_rounds"`. La llamada queda como `failed_negotiation` y no hay transferencia.

## 7. Reservar y pasar al senior rep (mock)

```bash
curl -s -X POST $BASE/v1/calls/$CALL/book \
  -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"load_id":"LD00925"}'
```
```json
{"ok":true,"booked":true,"load_id":"LD00925","rate":1450,"booking_ref":"BR97067104962148","handoff_id":"HO-CB2AC0E5","agent_guidance":"Tell them the load is reserved at the agreed rate and a senior rep will contact them to confirm and collect paperwork. Close the call."}
```
Sin un rate acordado responde `no_agreed_rate`. Si el TMS perdió la respuesta, devuelve `pending_confirmation: true` y el rep confirma la reserva.

## 8. Cerrar la llamada (el registro que irá a Twin)

```bash
curl -s -X POST $BASE/v1/calls/$CALL/finalize \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"sentiment":"positive","notes":"demo"}'
```
```json
{"ok":true,"record":{"call_id":"demo-001","mc_number":"123456","carrier_name":"Blue Ridge Transport LLC","fmcsa_status":"eligible","otp_channel":"sms","otp_verified":true,"lane_origin":"Houston, TX","equipment_type":"DRY_VAN","load_id":"LD00925","loadboard_rate":1277,"opening_offer":1277,"carrier_offers":[1600,1450],"our_offers":[1277,1370],"negotiation_rounds":2,"agreed_rate":1450,"agreed_vs_loadboard_pct":13.55,"outcome":"booked","integration_errors":0,"booking_ref":"BR97067104962148","booking_status":"BOOKED","handoff_id":"HO-CB2AC0E5","sentiment":"positive","notes":"demo"}}
```
(Recortado. También incluye fechas, duración y `failure_reason`.) Para consultarlo sin cerrar: `curl -s $BASE/v1/calls/$CALL -H "x-api-key: $KEY"`.

`outcome` puede ser: `booked`, `failed_negotiation`, `carrier_declined`, `fmcsa_failed`, `otp_failed`, `no_loads`, `integration_error` o `abandoned`.

---

## Pruebas rápidas de seguridad

```bash
# Sin API key -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/v1/calls/x/verify-carrier -H "content-type: application/json" -d '{"mc_number":"123456"}'

# Saltarse el OTP -> identity_not_verified
NEW=hack-$(date +%s)
curl -s -X POST $BASE/v1/calls/$NEW/verify-carrier -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"mc_number":"123456"}'
curl -s -X POST $BASE/v1/calls/$NEW/loads/search -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"origin":"TX"}'

# Negociar un load que no se ofreció -> load_not_offered
curl -s -X POST $BASE/v1/calls/$CALL/negotiate -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"load_id":"LD00932","action":"accept"}'

# Body inválido -> 400
curl -s -X POST $BASE/v1/calls/$CALL/negotiate -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"action":"counter"}'
```

Para ver en los logs cómo el adapter reintenta los fallos del TMS falso: `docker compose logs -f api | grep "ltms fault"`.

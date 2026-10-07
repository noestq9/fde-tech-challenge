# Legacy TMS (LTMS) — Especificación del protocolo para el cliente/adaptador

> Fuente: *HappyRobot — Legacy TMS Protocol Reference* (FORM-9100, REV 1.0, doc HR-LTMS-PR-001), secciones: Protocol, Fault behavior, LOAD_QUERY, LOAD_GET, LOAD_BOOK, DEBUG_ECHO, Token provisioning y Changelog.
>
> Objetivo: construir un cliente (adapter) que consuma el LTMS para automatizar con HappyRobot los flujos de **búsqueda de cargas, consulta de detalle y reserva (booking)** de una empresa logística.
>
> Convenciones de este documento:
> - **[SPEC]** = afirmado explícitamente por el manual.
> - **[OBS]** = derivado de los transcripts de ejemplo (conteo de anchos, patrones).
> - **[INFERENCIA]** = hipótesis razonable no confirmada; validar contra el servidor real.
>
> El manual se define a sí mismo como "field manual, not a formal specification. Where behavior is not stated, **the wire is authoritative**" y pide explícitamente **clientes defensivos**.

---

## 1. Transporte [SPEC]

| Propiedad | Valor |
|---|---|
| Transporte | TCP plano (sin TLS documentado) |
| Codificación | ASCII |
| Terminador de línea | `\r\n` |
| Tamaño máximo de frame | 4096 bytes (incluye terminador) |
| Idle timeout | 30 s (el servidor cierra la conexión) |
| Ciclo de vida | **Una petición por conexión** |

- El servidor cierra la conexión tras escribir la respuesta. El cliente debe abrir una **conexión nueva por cada request**. Reutilizar la conexión no está soportado (comportamiento implementation-defined) → **nunca reutilizar**.
- Host y puerto: se obtienen del candidate portal (no están en la spec). Deben venir de configuración/variables de entorno.

## 2. Autenticación [SPEC]

- Cada request debe llevar `AUTH:<token>`.
- Token ausente o inválido → `ERR|CODE:AUTH_FAILED|MSG:invalid or missing auth token` y el servidor cierra la conexión.
- Tokens: scoped por candidato, emitidos en el candidate portal (no self-service), dan acceso a toda la instancia no productiva; **no** están restringidos a un MC number.
- Son **bearer credentials**: no deben ir a control de versiones, logs ni transcripts compartidos. Pueden revocarse sin aviso.
- Requisito del cliente: leer token de env var (p. ej. `LTMS_TOKEN`), y **redactar** el valor de `AUTH` en cualquier log/trace (p. ej. `AUTH:t-9c3a...` → `AUTH:***`).

## 3. Framing de la petición [SPEC]

```
CMD:<command>|AUTH:<token>|<FIELD>:<VALUE>|...\r\n
```

- Una sola línea, pares `KEY:VALUE` separados por `|`.
- Nombres de campo en MAYÚSCULAS.
- `CMD` debe ir **primero**. `AUTH` obligatorio siempre (en los ejemplos va segundo).
- Los valores **no** pueden contener `|` ni `\r\n`. → El cliente debe validar/rechazar (o sanear) antes de enviar. [INFERENCIA] También conviene rechazar caracteres no ASCII y, por prudencia, `:` dentro de valores no es necesario prohibir (el split es por el primer `:`), pero verificarlo con `DEBUG_ECHO`.
- Campos desconocidos se aceptan y descartan (útil para no romper, peligroso para typos: validar nombres en el cliente).
- La línea completa (con `\r\n`) debe ser ≤ 4096 bytes.

## 4. Framing de la respuesta [SPEC]

**Éxito**: cero o más líneas de registro + línea terminadora `END`.

```
<FIELD>:<VALUE>|<FIELD>:<VALUE>|...\r\n
...
END\r\n
```

**Error**: una sola línea (sin `END`).

```
ERR|CODE:<code>|MSG:<msg>\r\n
```

- Los valores de ancho fijo se rellenan con **espacios a la derecha**. Los anchos no se enumeran en el manual; se derivan de los transcripts (ver §9).
- Una respuesta es válida **solo** si termina en `END\r\n` (éxito) o es una línea `ERR|...` completa con `\r\n`.
- El orden de los campos dentro de un registro es estable dentro de un build del servidor pero **no** entre builds → parsear siempre por nombre de campo, nunca por posición.

### Códigos de error conocidos [SPEC] (lista NO exhaustiva)

| Código | Significado / cuándo aparece |
|---|---|
| `AUTH_FAILED` | Token ausente/inválido. El servidor cierra la conexión. |
| `UNKNOWN_CMD` | Comando no reconocido. |
| `MISSING_FIELD` | Falta campo requerido (p. ej. `LOAD_QUERY` sin filtros, `LOAD_BOOK` sin `MC_NUM`/`AGREED_RATE`). |
| `UNKNOWN_LOAD` | `LOAD_ID` inexistente (`MSG:load not found`). |
| `ALREADY_BOOKED` | La carga ya está reservada para este token (`MSG:load not available`). |
| `INVALID_RATE` | `AGREED_RATE` rechazado (`MSG:rate rejected`). Cubre "más que los casos obvios". |
| `MALFORMED` | Request mal formado. |
| `SERVER_ERROR` | Error interno. |

El cliente debe tratar cualquier otro código como error desconocido (no lanzar excepción de parseo), preservando `CODE` y `MSG` crudos.

## 5. Comandos

| Comando | Propósito | Fault injection |
|---|---|---|
| `LOAD_QUERY` | Buscar en el load board abierto | Sí |
| `LOAD_GET` | Registro completo de una carga | Sí |
| `LOAD_BOOK` | Comprometer una reserva | Sí |
| `DEBUG_ECHO` | Round-trip de diagnóstico | **No** (la bypassa) |

---

### 5.1 `LOAD_QUERY` — búsqueda

**Request**

| Campo | Requerido | Notas |
|---|---|---|
| `CMD` | sí | `LOAD_QUERY` |
| `AUTH` | sí | token |
| `ORIG_CITY` | filtro | Matching "forgiving" [SPEC]. [OBS] `Miami` devolvió `Miami` y `Miami Gardens` → prefijo/substring, posiblemente case-insensitive. |
| `ORIG_STATE` | filtro | Código de 2 letras. Matching **estricto** [SPEC]. |
| `ORIG_ZIP` | filtro | [INFERENCIA por simetría con la respuesta] 5 dígitos. Estricto [SPEC]. |
| `DEST_CITY` | filtro | Igual que `ORIG_CITY`. |
| `DEST_STATE` | filtro | Igual que `ORIG_STATE`. |
| `DEST_ZIP` | filtro | [INFERENCIA] Igual que `ORIG_ZIP`. |
| `EQTYPE` | filtro | Identificador corto en mayúsculas. Valores observados: `DRY_VAN`, `REEFER`. [INFERENCIA] probablemente existan otros (p. ej. `FLATBED`); el conjunto aceptado es "el que devuelve el generador". **Un valor fuera del conjunto no da error: devuelve 0 registros.** |
| `PICKUP_DT` (?) | filtro | El manual cita "pickup date" como filtro canónico pero el nombre/formato del campo de request **no aparece en ningún transcript**. [INFERENCIA] Probar `PICKUP_DT:YYYYMMDD` o `YYYYMMDDHHMMSS` y comparar resultados (recordar: campos desconocidos se descartan silenciosamente → un filtro mal nombrado "funciona" pero no filtra). |
| `MAX_RESULTS` | opcional | Limita resultados. El servidor aplica un techo propio (no publicado) e **ignora** valores excesivos. |

- Se requiere **al menos un filtro** además de `CMD` y `AUTH`; si no → `ERR|CODE:MISSING_FIELD|MSG:at least one filter required`.
- Validación recomendada en cliente: normalizar `*_STATE` a mayúsculas 2 letras, `*_ZIP` 5 dígitos, `EQTYPE` contra un enum configurable (y advertir si el resultado es vacío con un EQTYPE no conocido).

**Response**: 0..N registros + `END`. Campos por registro: `LOAD_ID, ORIG_CITY, ORIG_STATE, ORIG_ZIP, DEST_CITY, DEST_STATE, DEST_ZIP, PICKUP_DT, EQTYPE, RATE, MILES, STATUS`.

**Transcripts (verbatim; el padding es significativo)**

Transcript 1 — por estado y equipo
```
> CMD:LOAD_QUERY|AUTH:t-9c3a...|ORIG_STATE:GA|DEST_STATE:TX|EQTYPE:DRY_VAN|MAX_RESULTS:5
< LOAD_ID:LD0000045821|ORIG_CITY:Atlanta                       |ORIG_STATE:GA|ORIG_ZIP:30303|DEST_CITY:Dallas                        |DEST_STATE:TX|DEST_ZIP:75201|PICKUP_DT:20260512080000|EQTYPE:DRY_VAN   |RATE:0002150|MILES:000785|STATUS:OPEN
< LOAD_ID:LD0000045903|ORIG_CITY:Atlanta                       |ORIG_STATE:GA|ORIG_ZIP:30303|DEST_CITY:Houston                       |DEST_STATE:TX|DEST_ZIP:77002|PICKUP_DT:20260513140000|EQTYPE:DRY_VAN   |RATE:0002280|MILES:000789|STATUS:OPEN
< END
```

Transcript 2 — por ciudad, reefer
```
> CMD:LOAD_QUERY|AUTH:t-9c3a...|ORIG_CITY:Miami|EQTYPE:REEFER|MAX_RESULTS:3
< LOAD_ID:LD0000046112|ORIG_CITY:Miami                         |ORIG_STATE:FL|ORIG_ZIP:33101|DEST_CITY:Newark                        |DEST_STATE:NJ|DEST_ZIP:07102|PICKUP_DT:20260514063000|EQTYPE:REEFER    |RATE:0003420|MILES:001280|STATUS:OPEN
< LOAD_ID:LD0000046188|ORIG_CITY:Miami Gardens                 |ORIG_STATE:FL|ORIG_ZIP:33056|DEST_CITY:Charlotte                     |DEST_STATE:NC|DEST_ZIP:28202|PICKUP_DT:20260515110000|EQTYPE:REEFER    |RATE:0001980|MILES:000711|STATUS:OPEN
< END
```

Transcript 3 — resultado vacío
```
> CMD:LOAD_QUERY|AUTH:t-9c3a...|ORIG_CITY:Boise|DEST_STATE:VT|EQTYPE:REEFER
< END
```

Transcript 4 — rechazado
```
> CMD:LOAD_QUERY|AUTH:t-9c3a...
< ERR|CODE:MISSING_FIELD|MSG:at least one filter required
```

> ⚠️ Un resultado vacío (`END` solo) es legítimo, pero **también** es indistinguible de una respuesta parcial truncada justo antes del primer registro… salvo que falte el `END`. Ver §7.

---

### 5.2 `LOAD_GET` — detalle de carga

**Request**: `CMD:LOAD_GET|AUTH:<token>|LOAD_ID:<id>`

**Response**: exactamente **1 registro** + `END`. Incluye todos los campos de `LOAD_QUERY` más: `DELIVERY_DT, WEIGHT, COMMODITY, PIECES, DIMS, NOTES, MAX_BUY` (este último condicional).

Orden observado: `LOAD_ID, ORIG_CITY, ORIG_STATE, ORIG_ZIP, DEST_CITY, DEST_STATE, DEST_ZIP, PICKUP_DT, DELIVERY_DT, EQTYPE, RATE, WEIGHT, COMMODITY, PIECES, MILES, DIMS, NOTES, STATUS, MAX_BUY` (no depender del orden).

**Transcripts (verbatim)**

Transcript 1 — dry van
```
> CMD:LOAD_GET|AUTH:t-9c3a...|LOAD_ID:LD0000045821
< LOAD_ID:LD0000045821|ORIG_CITY:Atlanta                       |ORIG_STATE:GA|ORIG_ZIP:30303|DEST_CITY:Dallas                        |DEST_STATE:TX|DEST_ZIP:75201|PICKUP_DT:20260512080000|DELIVERY_DT:20260513170000|EQTYPE:DRY_VAN   |RATE:0002150|WEIGHT:0042000|COMMODITY:PALLETIZED CONSUMER GOODS       |PIECES:000026|MILES:000785|DIMS:48X40 STD GMA PALLETS              |NOTES:Drop trailer at destination. Appt required.                                                                       |STATUS:OPEN    |MAX_BUY:0001950
< END
```

Transcript 2 — reefer con notas del operador
```
> CMD:LOAD_GET|AUTH:t-9c3a...|LOAD_ID:LD0000046112
< LOAD_ID:LD0000046112|ORIG_CITY:Miami                         |ORIG_STATE:FL|ORIG_ZIP:33101|DEST_CITY:Newark                        |DEST_STATE:NJ|DEST_ZIP:07102|PICKUP_DT:20260514063000|DELIVERY_DT:20260516120000|EQTYPE:REEFER    |RATE:0003420|WEIGHT:0038500|COMMODITY:FRESH PRODUCE - MIXED           |PIECES:000022|MILES:001280|DIMS:48X40 CHEP PALLETS                 |NOTES:Reefer set 34F continuous. Pre-cool trailer. Live unload. 2H detention free, then $75/h.                          |STATUS:OPEN    |MAX_BUY:0003080
< END
```

Transcript 3 — notas en blanco
```
> CMD:LOAD_GET|AUTH:t-9c3a...|LOAD_ID:LD0000045903
< LOAD_ID:LD0000045903|ORIG_CITY:Atlanta                       |ORIG_STATE:GA|ORIG_ZIP:30303|DEST_CITY:Houston                       |DEST_STATE:TX|DEST_ZIP:77002|PICKUP_DT:20260513140000|DELIVERY_DT:20260514230000|EQTYPE:DRY_VAN   |RATE:0002280|WEIGHT:0040800|COMMODITY:RETAIL DRY GOODS                |PIECES:000031|MILES:000789|DIMS:48X40 STD GMA PALLETS              |NOTES:                                                                                                                  |STATUS:OPEN    |MAX_BUY:0002065
< END
```

Transcript 4 — id desconocido
```
> CMD:LOAD_GET|AUTH:t-9c3a...|LOAD_ID:LD9999999999
< ERR|CODE:UNKNOWN_LOAD|MSG:load not found
```

**Notas [SPEC]**
- `NOTES` es el campo más ancho y va relleno de espacios cuando está vacío. Una fracción no trivial de cargas tiene `NOTES` vacío. Un adapter que haga strip de whitespace colapsará `NOTES` en blanco a `""` → modelarlo como `notes: str | None` (vacío ⇒ `None`), y **no** confundirlo con un campo ausente/truncado.
- `COMMODITY` y `DIMS` son texto libre del operador; sin vocabulario controlado.
- `NOTES` puede contener caracteres como `.`, `,`, `$`, `/`, `-` (ver transcript 2). Nunca contiene `|`.
- `RATE` = tarifa publicada. `MAX_BUY` solo se expone a tokens con un flag; en otros tokens el campo **está ausente** del registro. La detección queda al cliente → `max_buy: int | None` según presencia del campo.
- `LOAD_GET` devuelve el registro **independientemente de `STATUS`**: cargas reservadas o con pickup pasado siguen resolviendo. El cliente no debe asumir que un `LOAD_GET` exitoso implica que la carga es reservable → revisar `STATUS` y `PICKUP_DT`.

---

### 5.3 `LOAD_BOOK` — reserva

**Request**

| Campo | Requerido | Notas |
|---|---|---|
| `CMD` | sí | `LOAD_BOOK` |
| `AUTH` | sí | |
| `LOAD_ID` | sí | p. ej. `LD0000045821` |
| `MC_NUM` | sí | MC number del carrier, numérico (ej. `872144`). |
| `AGREED_RATE` | sí | Entero en dólares **sin** padding en los ejemplos (`2200`). Falta cualquiera → `MISSING_FIELD`. |

**Response éxito**: 1 registro + `END` con `LOAD_ID, BOOKING_REF, STATUS, TIMESTAMP`.

**Transcripts (verbatim)**

```
# 1 — éxito
> CMD:LOAD_BOOK|AUTH:t-9c3a...|LOAD_ID:LD0000045821|MC_NUM:872144|AGREED_RATE:2200
< LOAD_ID:LD0000045821|BOOKING_REF:BR00000000091277|STATUS:BOOKED  |TIMESTAMP:20260504193122
< END

# 2 — reintento sobre la misma carga
> CMD:LOAD_BOOK|AUTH:t-9c3a...|LOAD_ID:LD0000045821|MC_NUM:872144|AGREED_RATE:2200
< ERR|CODE:ALREADY_BOOKED|MSG:load not available

# 3 — tarifa rechazada
> CMD:LOAD_BOOK|AUTH:t-9c3a...|LOAD_ID:LD0000046112|MC_NUM:872144|AGREED_RATE:0
< ERR|CODE:INVALID_RATE|MSG:rate rejected

# 4 — carga desconocida
> CMD:LOAD_BOOK|AUTH:t-9c3a...|LOAD_ID:LD9999999999|MC_NUM:872144|AGREED_RATE:2000
< ERR|CODE:UNKNOWN_LOAD|MSG:load not found

# 5 — request incompleto
> CMD:LOAD_BOOK|AUTH:t-9c3a...|LOAD_ID:LD0000045821
< ERR|CODE:MISSING_FIELD|MSG:missing required field
```

**Notas [SPEC]**
- La reserva está **ligada al token**: la misma carga puede tener estados distintos para tokens distintos (intencional).
- `BOOKING_REF` es asignado por el servidor y **opaco**: no parsearlo, solo almacenarlo.
- `TIMESTAMP` está en **UTC**.
- `INVALID_RATE` cubre "más que los casos obvios". El rango aceptable de `AGREED_RATE` **no se publica**; el operador debe acotarlo por observación.
- La vista del token es **monótona**: una vez observado `ALREADY_BOOKED` para un `LOAD_ID` en un token, seguirá devolviendo `ALREADY_BOOKED`. Otros tokens no se ven afectados.

**Observaciones sobre la regla de tarifa [OBS/INFERENCIA]**
- Carga `LD0000045821`: `RATE=2150`, `MAX_BUY=1950`; se aceptó `AGREED_RATE=2200` (> RATE y > MAX_BUY). Por tanto `MAX_BUY` **no** parece ser el límite que valida el servidor (o el transcript es anterior/ilustrativo). `0` se rechaza.
- Hipótesis a probar empíricamente: rango relativo a `RATE` (p. ej. ±X %), mínimo > 0, entero, sin decimales, máximo de 7 dígitos (ancho de `RATE`). Diseñar el cliente con la validación de tarifa como **política configurable** y registrar cada `INVALID_RATE` con (`RATE`, `MAX_BUY`, `AGREED_RATE`) para acotar la regla.
- Para la lógica de negocio de HappyRobot (negociación con el carrier): `MAX_BUY` es el techo comercial interno del broker; `RATE` el precio publicado. Nunca exponer `MAX_BUY` al carrier.

**Idempotencia y reintentos en `LOAD_BOOK` (crítico)**
`LOAD_BOOK` **no es idempotente** a nivel de protocolo y está sujeto a fault injection. Escenario: el servidor procesa la reserva pero la respuesta se pierde (timeout / parcial). Un reintento devolverá `ALREADY_BOOKED` — que en ese caso significa *"tú ya la reservaste"*, no *"otro la tomó"* (la vista es por token).
Estrategia recomendada:
1. Si el primer intento fue ambiguo (timeout, parcial, malformado) y el reintento devuelve `ALREADY_BOOKED`, clasificar el resultado como `BOOKED_UNCONFIRMED` (probablemente reservada por nosotros, sin `BOOKING_REF`).
2. Intentar confirmar con `LOAD_GET` (`STATUS` debería reflejar el estado para este token). [INFERENCIA] verificar qué valor de `STATUS` devuelve `LOAD_GET` tras reservar (`BOOKED`?).
3. Si el primer intento fue un `ALREADY_BOOKED` limpio (sin intento previo ambiguo en este proceso), es "no disponible".
4. Persistir localmente el estado de cada intento de booking (load_id, mc, rate, intento, resultado) para que reinicios del proceso no pierdan esta información.

---

### 5.4 `DEBUG_ECHO` — diagnóstico

**Request**: `CMD:DEBUG_ECHO|AUTH:<token>|MSG:<texto>[|campos extra...]`

**Response**: `ECHO|AUTH:OK|FIELDS_PARSED:<n>|MSG:<texto>` + `END`. Nota: la primera "columna" `ECHO` no tiene `:` (no es un `KEY:VALUE`) → el parser debe tolerar tokens sin `:`.

```
> CMD:DEBUG_ECHO|AUTH:t-9c3a...|MSG:HELLO
< ECHO|AUTH:OK|FIELDS_PARSED:3|MSG:HELLO
< END

> CMD:DEBUG_ECHO|AUTH:t-9c3a...|MSG:probe-7|X:1|Y:2|Z:3
< ECHO|AUTH:OK|FIELDS_PARSED:6|MSG:probe-7
< END

> CMD:DEBUG_ECHO|AUTH:bogus|MSG:HELLO
< ERR|CODE:AUTH_FAILED|MSG:invalid or missing auth token
```

- `MSG` se devuelve verbatim. Campos extra se aceptan, cuentan y descartan.
- `FIELDS_PARSED` cuenta todos los `KEY:VALUE` aceptados, **incluyendo** `CMD` y `AUTH` → usarlo como test de conformidad del encoder (enviar N campos ⇒ esperar N).
- Es el **único** comando sin fault injection: sirve para health-check de transporte/framing/auth, pero **no** dice nada sobre la salud del path operacional.

---

## 6. Modelo de datos y tipos (derivados) [OBS]

| Campo | Tipo lógico | Formato en el wire | Parseo |
|---|---|---|---|
| `LOAD_ID` | string | `LD` + 10 dígitos (12 chars) | tal cual |
| `ORIG_CITY` / `DEST_CITY` | string | texto, pad derecha a 30 | `rstrip` |
| `ORIG_STATE` / `DEST_STATE` | string | 2 letras | tal cual |
| `ORIG_ZIP` / `DEST_ZIP` | **string** | 5 dígitos, puede iniciar con `0` (`07102`) | **no** convertir a int |
| `PICKUP_DT` / `DELIVERY_DT` | datetime | `YYYYMMDDHHMMSS` (14) | zona horaria **no documentada** [INFERENCIA: hora local del sitio o UTC; tratar como naive y documentarlo] |
| `EQTYPE` | enum abierto | pad a 10 (`DRY_VAN   `, `REEFER    `) | `rstrip`; desconocidos → conservar string |
| `RATE` | int (USD) | 7 dígitos, zero-pad (`0002150` = 2150) | `int()` |
| `MAX_BUY` | int (USD) \| None | 7 dígitos zero-pad; **ausente** si el token no tiene el flag | `int()` o `None` |
| `MILES` | int | 6 dígitos zero-pad | `int()` |
| `WEIGHT` | int (lbs [INFERENCIA]) | 7 dígitos zero-pad | `int()` |
| `PIECES` | int | 6 dígitos zero-pad | `int()` |
| `COMMODITY` | string libre | pad a 32 | `rstrip` |
| `DIMS` | string libre | pad a 35 | `rstrip` |
| `NOTES` | string libre \| None | pad a 114; todo espacios = vacío | `rstrip`; `""` ⇒ `None` |
| `STATUS` | enum abierto | `OPEN` (query, 4) / `OPEN    ` (get, 8) / `BOOKED  ` (book, 8) | `rstrip`; desconocidos → conservar |
| `BOOKING_REF` | string opaco | `BR` + 14 dígitos (16) | tal cual, no parsear |
| `TIMESTAMP` | datetime UTC | `YYYYMMDDHHMMSS` | aware UTC |
| `AGREED_RATE` (req) | int | dígitos sin padding | `str(int)` |
| `MC_NUM` (req) | string numérico | dígitos | validar `^\d+$` |

Montos: [INFERENCIA] dólares enteros (no centavos): `RATE 0002150` para 785 millas ≈ $2.74/mi, coherente con mercado.

## 7. Comportamiento de fallos (fault injection) [SPEC]

Se inyectan fallos en comandos operacionales (`LOAD_QUERY`, `LOAD_GET`, `LOAD_BOOK`). **No se señalizan**: sin código, sin campo marcador, sin aviso out-of-band. "El contrato del operador es con el wire, no con el servidor." Categorías observadas (lista descriptiva, no normativa; pueden aparecer nuevas sin aviso):

| Categoría | Síntoma en el wire | Detección en el cliente |
|---|---|---|
| **Timeout** | Acepta conexión, lee el request, no escribe nada; cierra al idle timeout (30 s). | Read timeout del cliente (mucho menor que 30 s, configurable, p. ej. 5–10 s). |
| **Respuesta parcial** | Escribe un prefijo válido y cierra **sin** `END`. El registro truncado puede estar sintácticamente incompleto. | EOF antes de `END\r\n` ⇒ inválida. Descartar **toda** la respuesta (no devolver resultados parciales como si fueran completos). |
| **Respuesta malformada** | Viola el framing: delimitadores extra, líneas sin terminar, valores que **exceden** el ancho declarado. | Validación estricta por línea: `\r\n`, pares `KEY:VALUE`, campos esperados presentes, anchos/tipos correctos (§9), sin campos duplicados. |
| **Terminación retrasada** | Respuesta completa, pero la conexión queda abierta más de lo esperado. | **No** esperar al cierre: considerar la respuesta completa al leer `END\r\n` (o una línea `ERR|...\r\n`) y cerrar desde el cliente. |

`DEBUG_ECHO` no pasa por la capa de fallos: no sirve para sondearlos.

## 8. Requisitos del cliente (diseño recomendado)

### 8.1 Capa de transporte
- `send(request_line) -> raw_lines`: abre socket TCP nuevo, `connect_timeout` (p. ej. 3 s), escribe la línea, lee con `read_timeout` por operación y un **deadline total** por request.
- Lectura incremental por líneas `\r\n`; parar en cuanto se reciba `END\r\n` o una línea que empiece por `ERR|`. Cerrar el socket siempre (finally).
- Límite de lectura defensivo: cada línea ≤ 4096 bytes; total de respuesta acotado (p. ej. `MAX_RESULTS` × 4096 + margen). Exceder ⇒ `MalformedResponse`.
- Decodificar como ASCII estricto; bytes no ASCII ⇒ `MalformedResponse`.
- Una línea sin `\r` final (solo `\n`) ⇒ tratar como malformada [INFERENCIA; o tolerar con warning — decidir y documentar].

### 8.2 Encoder
- Orden: `CMD`, `AUTH`, resto.
- Rechazar valores con `|`, `\r`, `\n`, no ASCII; validar longitud total ≤ 4096 incl. `\r\n`.
- Validar nombres de campo contra una whitelist por comando (los desconocidos el servidor los ignora silenciosamente).
- Test de conformidad con `DEBUG_ECHO` (`FIELDS_PARSED`).

### 8.3 Parser
- Split de línea por `|`, cada parte por el **primer** `:`.
- Línea de error: `ERR|CODE:<c>|MSG:<m>` → `LtmsError(code, msg)`; `MSG` puede contener espacios.
- Registros: dict por nombre de campo; validar presencia de campos requeridos por comando, sin duplicados, anchos fijos (§9) y tipos (§6). Ancho excedido ⇒ malformado.
- Ser tolerante con campos **extra** desconocidos (posible evolución del build) pero registrarlos.
- `LOAD_GET` debe devolver exactamente 1 registro; `LOAD_BOOK` exactamente 1; si no ⇒ malformado.
- Mantener la respuesta cruda (con token redactado) para debugging.

### 8.4 Taxonomía de resultados/excepciones
- `LtmsTransportError` (connect fallido, reset) — reintentable.
- `LtmsTimeout` — reintentable (con cuidado en `LOAD_BOOK`).
- `LtmsPartialResponse` (EOF sin `END`) — reintentable.
- `LtmsMalformedResponse` — reintentable.
- `LtmsError(code)` — de negocio: `AUTH_FAILED` (no reintentar, alertar), `UNKNOWN_LOAD`, `ALREADY_BOOKED`, `INVALID_RATE`, `MISSING_FIELD`, `UNKNOWN_CMD`, `MALFORMED` (bug del cliente, no reintentar); `SERVER_ERROR` (reintentable con backoff); código desconocido (no reintentar por defecto).

### 8.5 Reintentos
- Lecturas (`LOAD_QUERY`, `LOAD_GET`): idempotentes → retry con backoff exponencial + jitter (p. ej. 3–5 intentos), dentro de un presupuesto total de tiempo compatible con una llamada de voz en vivo (el agente de HappyRobot está hablando con un carrier: preferir latencia acotada, p. ej. ≤ 8–10 s total, y devolver un error claro al agente si se agota).
- `LOAD_BOOK`: ver lógica de idempotencia en §5.3. Nunca reintentar ciegamente tras `INVALID_RATE`, `UNKNOWN_LOAD` o `ALREADY_BOOKED` limpio.

### 8.6 Interfaz de alto nivel sugerida
```python
class LtmsClient:
    def ping(self, msg: str = "HELLO") -> EchoResult: ...           # DEBUG_ECHO
    def search_loads(self, *, orig_city=None, orig_state=None, orig_zip=None,
                     dest_city=None, dest_state=None, dest_zip=None,
                     equipment=None, pickup_date=None, max_results=None) -> list[LoadSummary]: ...
    def get_load(self, load_id: str) -> LoadDetail: ...               # max_buy: Optional[int]
    def book_load(self, load_id: str, mc_number: str, agreed_rate: int) -> BookingResult: ...
        # BookingResult.status ∈ {BOOKED, BOOKED_UNCONFIRMED, NOT_AVAILABLE, RATE_REJECTED, UNKNOWN_LOAD}
```
Pensado para exponerse a HappyRobot como herramientas/endpoint HTTP (p. ej. un pequeño servicio REST/JSON delante del cliente TCP) para los flujos: buscar cargas por lane/equipo/fecha → detalle → negociación (RATE/MAX_BUY) → reserva con MC del carrier.

### 8.7 Observabilidad y seguridad
- Logs estructurados por request: comando, load_id, duración, intentos, categoría de fallo, código de error. Token siempre redactado.
- Métricas: tasa de cada categoría de fault, latencias, distribución de `INVALID_RATE` vs (RATE, MAX_BUY, AGREED_RATE).
- Config por env: `LTMS_HOST`, `LTMS_PORT`, `LTMS_TOKEN`, timeouts, reintentos.

### 8.8 Testing
- **Servidor fake local** (TCP) que reproduzca los transcripts de este documento y además los 4 modos de fallo (timeout, parcial, malformado, terminación retrasada) + campos extra, reordenados, `MAX_BUY` ausente, `NOTES` en blanco.
- Tests de golden parsing con los transcripts verbatim (anchos exactos).
- Test de encoder con `DEBUG_ECHO`/`FIELDS_PARSED`.
- Tests de idempotencia de booking (respuesta perdida + `ALREADY_BOOKED` en reintento).
- Script de exploración contra el servidor real para: nombre/formato del filtro de fecha, conjunto de `EQTYPE`, techo de `MAX_RESULTS`, regla de `INVALID_RATE`, `STATUS` posterior a booking, zona horaria de fechas.

## 9. Anchos de campo derivados de los transcripts [OBS]

Contados sobre los valores (sin incluir `KEY:`), consistentes en todos los transcripts:

| Campo | Ancho | Relleno | Comandos |
|---|---|---|---|
| `LOAD_ID` | 12 | — (siempre lleno) | QUERY, GET, BOOK |
| `ORIG_CITY` | 30 | espacios dcha. | QUERY, GET |
| `ORIG_STATE` | 2 | — | QUERY, GET |
| `ORIG_ZIP` | 5 | — | QUERY, GET |
| `DEST_CITY` | 30 | espacios dcha. | QUERY, GET |
| `DEST_STATE` | 2 | — | QUERY, GET |
| `DEST_ZIP` | 5 | — | QUERY, GET |
| `PICKUP_DT` | 14 | — | QUERY, GET |
| `DELIVERY_DT` | 14 | — | GET |
| `EQTYPE` | 10 | espacios dcha. | QUERY, GET |
| `RATE` | 7 | ceros izq. | QUERY, GET |
| `WEIGHT` | 7 | ceros izq. | GET |
| `COMMODITY` | 32 | espacios dcha. | GET |
| `PIECES` | 6 | ceros izq. | GET |
| `MILES` | 6 | ceros izq. | QUERY, GET |
| `DIMS` | 35 | espacios dcha. | GET |
| `NOTES` | 114 | espacios dcha. | GET |
| `STATUS` | **4 en QUERY** (`OPEN`, último campo, sin padding visible) / **8 en GET y BOOK** (`OPEN    `, `BOOKED  `) | espacios dcha. | QUERY, GET, BOOK |
| `MAX_BUY` | 7 | ceros izq. | GET (condicional) |
| `BOOKING_REF` | 16 | — | BOOK |
| `TIMESTAMP` | 14 | — | BOOK |
| `FIELDS_PARSED` | variable | — | ECHO |
| `MSG` (echo) | variable (verbatim) | — | ECHO |

Recomendación de validación: tratar el ancho como **máximo** (valor > ancho ⇒ malformado) y aceptar valores más cortos tras `rstrip` (p. ej. `STATUS` en QUERY). Para `STATUS`, el ancho de 4 en QUERY puede ser un artefacto del manual (último campo de la línea) — validar con ancho máximo 8.

## 10. Preguntas abiertas a resolver empíricamente

1. Nombre y formato del filtro de fecha de pickup en `LOAD_QUERY`.
2. Conjunto completo de `EQTYPE` válidos.
3. Techo real de `MAX_RESULTS` y valor por defecto si se omite.
4. Regla exacta de `INVALID_RATE` (relación con `RATE` / `MAX_BUY`, mínimos, máximos, formato).
5. Valores posibles de `STATUS` y cómo refleja `LOAD_GET` una carga reservada por este token vs. otro.
6. Zona horaria de `PICKUP_DT` / `DELIVERY_DT`.
7. Sensibilidad a mayúsculas/minúsculas y semántica exacta (prefijo vs substring) del matching de ciudad.
8. Si el token disponible tiene el flag de `MAX_BUY`.
9. Comportamiento ante `\n` sin `\r`, campos duplicados en el request y valores con `:`.

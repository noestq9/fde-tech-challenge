# Inbound Carrier Sales: agent backend

Backend for a HappyRobot voice agent that answers inbound carrier calls for a freight brokerage. It verifies the carrier with FMCSA, confirms identity with a one-time code, finds loads in the legacy TMS, negotiates the rate within the broker's ceiling, books the load and hands off to a senior rep (mocked).

The voice agent handles the conversation. **This service enforces the rules**: the agent never sees `max_rate` or the OTP code, and it cannot skip a step, because each endpoint checks the call's state before it acts.

## Call flow

| Step | Endpoint | Gate enforced in code |
|---|---|---|
| 1. FMCSA authority check | `POST /v1/calls/:callId/verify-carrier` | MC normalized; carrier must be allowed to operate with active authority |
| 2. Send OTP | `POST /v1/calls/:callId/otp/send` | FMCSA passed. Code goes to the contact **on file**, never shown to the agent |
| 3. Verify OTP | `POST /v1/calls/:callId/otp/verify` | 3 attempts, 5 min TTL, resends don't reset attempts |
| 4. Load search | `POST /v1/calls/:callId/loads/search` | OTP verified. `max_rate` stripped from every load |
| 5. Negotiate | `POST /v1/calls/:callId/negotiate` | Load must have been offered. Max 3 carrier counters, never above ceiling |
| 6. Book + handoff | `POST /v1/calls/:callId/book` | A rate must be agreed |
| 7. Call record | `POST /v1/calls/:callId/finalize` | Returns the flat record the workflow writes to Twin |
| Health | `GET /health` | Only unauthenticated route |

All other routes require the `X-API-Key` header. Business outcomes return HTTP 200 with `ok:false` and an `agent_guidance` line so the agent always gets a structured answer instead of improvising around a failure.

## Negotiation policy

First offer is `loadboard_rate`. On each carrier counter (up to 3):

- If the carrier asks for no more than our next step, we accept their number.
- Otherwise we counter at `loadboard + (max − loadboard) × step[round]`, with steps `0.35, 0.70, 1.0` by default (`NEGOTIATION_STEPS`), rounded down to $5.
- A 4th counter ends the negotiation as `failed_negotiation` with no transfer.

## Pricing

The TMS returns the listed rate (`RATE`) and, for flagged tokens, the broker ceiling (`MAX_BUY`). The ceiling can sit on either side of the listed rate: the manual's examples have it below (RATE 2150, MAX_BUY 1950), the live server has it above (RATE 1277, MAX_BUY 1552). The opening offer is `min(RATE, MAX_BUY × OPENING_RATIO)` (0.9 by default), so we open at the listed rate when there is room above it and below the ceiling when there isn't, and counters move from there toward `MAX_BUY`. When a token has no `MAX_BUY`, the ceiling falls back to `RATE × FALLBACK_CEILING_RATIO`. The agent only ever sees `offer_rate`.

## Legacy TMS adapter

`src/integrations/tms/` implements the protocol in `docs/LEGACY_TMS_PROTOCOL_SPEC.md`:

- **Transport:** new TCP connection per request, per-attempt deadline, stops reading at `END`/`ERR` (handles "delayed termination"), rejects non-ASCII, bare `\n` and oversized frames.
- **Encoder:** `CMD`, `AUTH` first; rejects `|`, CR/LF, non-ASCII and unknown fields (the server silently ignores them); token redacted in every log.
- **Parser:** strict framing, parse by field name, width and type checks, blank `NOTES` → `null`, missing `MAX_BUY` → `null`. Accepts both the manual's zero-padded numbers and the live server's space-padded ones (see `test/fixtures/real-wire-records.txt`, captured with `npm run tms:dump`).
- **Resilience:** retries with jittered backoff inside an 8 s budget (the carrier is on the line), circuit breaker, clear error kinds.
- **Booking idempotency:** a lost `LOAD_BOOK` response followed by `ALREADY_BOOKED` on retry is reported as `BOOKED_UNCONFIRMED` (the booking view is per token, so we booked it). If every attempt is ambiguous the result is `booking_unknown` and the call is handed to a rep, never reported as a silent success. Attempts can be journaled to `TMS_BOOKING_JOURNAL`.
- **Fake TMS:** `src/fakeTms/` speaks the same protocol and injects the four fault types. Its seed data includes the spec transcripts.

## Run

```bash
cp .env.example .env          # set API_KEY (openssl rand -hex 32)
docker compose up --build     # API + fake TMS, single command
npm run smoke                 # checks the running API
```

With TMS_HOST/TMS_PORT/TMS_TOKEN set in `.env`, `docker compose up --build api` runs against the real TMS.

Local development: `npm install`, `npm run tms:fake` in one terminal, `npm run dev` in another.

## Testing

| Command | What it checks |
|---|---|
| `npm test` | Unit and integration tests: negotiation, OTP, API gates, protocol golden tests from the spec transcripts, client against the fake TMS with each fault forced |
| `npm run sim:calls` | 22 scripted call scenarios (standard, edge, adversarial) through the API and the TCP adapter, with 20% injected faults. Writes `reports/*.md` |
| `npm run sim:calls -- --real` | Same scenarios against the real TMS (books real loads for your token) |
| `npm run tms:dump` | Raw responses from the real TMS with the parser's verdict on each (token redacted) |
| `npm run tms:probe` | Read-only probe of the real TMS: echo conformance, MAX_BUY flag, EQTYPE values, date filter, fault profile, retry success rate |
| `npm run fmcsa:check -- <MC>` | Live FMCSA lookup with your webKey |
| `npm run smoke` | Health, auth and gates on a running deployment (`API_URL`) |

Mock FMCSA MC numbers: `123456` and `234567` eligible, `345678` no active authority, `456789` not allowed to operate, `999999` outage.

## Status

- [x] API, auth, FMCSA client (live + mock), OTP, negotiation, call record, Docker
- [x] Legacy TMS TCP adapter, fake TMS, scenario runner
- [ ] HappyRobot workflow, voice agent prompt, Twin and Apps dashboard
- [ ] Cloud deploy, voice-level adversarial QA

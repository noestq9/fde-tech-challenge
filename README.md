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

## Run

```bash
cp .env.example .env          # set API_KEY (openssl rand -hex 32)
docker compose up --build     # single command
curl localhost:8080/health
```

Local development: `npm install && npm run dev`. Tests: `npm test`.

`FMCSA_MODE=mock` and `TMS_MODE=mock` run without credentials. Mock MC numbers: `123456` and `234567` eligible, `345678` no active authority, `456789` not allowed to operate, `999999` FMCSA outage. A search with origin `timeout` simulates a TMS timeout.

## Status

- [x] API, auth, FMCSA client (live + mock), OTP, negotiation, call record, Docker
- [ ] Legacy TMS TCP adapter (waiting for protocol spec)
- [ ] HappyRobot workflow, voice agent prompt, Twin and Apps dashboard
- [ ] Cloud deploy, QA suite with adversarial calls

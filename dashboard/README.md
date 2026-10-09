# Carrier Desk

Ops dashboard for the inbound carrier sales agent, built for HappyRobot Apps (Next.js). It reads the call log the workflow writes to Twin (`carrier_calls`) and lets the operations manager act on it, without opening platform logs.

- **Signals:** booking rate over verified carriers, average paid over the listed rate, counter rounds, verification lockouts, system errors, how calls ended, and every call with a link to its recording.
- **Actions:** a "Needs a rep" queue (bookings to confirm, bookings the TMS did not confirm, calls cut by a system error, verification lockouts). Each item is marked handled, which writes `ops_status` back to Twin.

## Setup

1. Twin: add a text column `ops_status` to `carrier_calls`.
2. HappyRobot → Settings → API Keys: create an organization key with Twin read and data edit.
3. Railway: new service from this repo with **Root Directory** `dashboard` (uses `Dockerfile` and `railway.json` here). Variables: `HAPPYROBOT_API_KEY`, `DASHBOARD_PASSWORD` (login user `ops`). Generate a domain.

Twin is read through the public API v2 (`GET /twin/tables/carrier_calls`, paged by 500, sorted here) and the action writes with `PATCH /twin/tables/carrier_calls/rows`. Calls happen only on the server; the key never reaches the browser. API limit: 300 requests/min per key.

Why outside HappyRobot Apps: the Apps module is not enabled on the account used for this POC. The challenge allows an external UI where Apps cannot be used; the data still lives in Twin.

## Local

```bash
npm install
npm run dev      # sample data when the gateway variables are unset
npm test
```

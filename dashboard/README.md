# Carrier Desk

Ops dashboard for the inbound carrier sales agent, built for HappyRobot Apps (Next.js). It reads the call log the workflow writes to Twin (`carrier_calls`) and lets the operations manager act on it, without opening platform logs.

- **Signals:** booking rate over verified carriers, average paid over the listed rate, counter rounds, verification lockouts, system errors, how calls ended, and every call with a link to its recording.
- **Actions:** a "Needs a rep" queue (bookings to confirm, bookings the TMS did not confirm, calls cut by a system error, verification lockouts). Each item is marked handled, which writes `ops_status` back to Twin.

## Setup in HappyRobot

1. Twin: add a text column `ops_status` to `carrier_calls`.
2. Settings → Twin Database → Deploy Gateway. Apps then receive `NEXT_PUBLIC_TWIN_GATEWAY` and `NEXT_PUBLIC_ORG_ID`.
3. Apps → new app from this folder (`dashboard/`). Set `DASHBOARD_PASSWORD` (login user `ops`).

The gateway is called only from the server (page and server action), never from the browser.

Not yet confirmed against the docs: the update syntax for the action (`PATCH ?run_id=eq.<id>`). If the gateway rejects it, the error shows on the page.

## Local

```bash
npm install
npm run dev      # sample data when the gateway variables are unset
npm test
```

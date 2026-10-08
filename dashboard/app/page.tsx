import { markCall } from './actions';
import { fetchCalls, usingSampleData } from '@/lib/twin';
import { OUTCOME_LABELS, inRange, kpis, needsAttention, outcomeBreakdown, type AttentionReason, type Range } from '@/lib/metrics';
import type { CallRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const RANGES: Array<[Range, string]> = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];
const pct = (v: number | null, digits = 0) => (v === null ? '–' : `${(v * 100).toFixed(digits)}%`);
const money = (v: number | null) => (v === null ? '–' : `$${v.toLocaleString('en-US')}`);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–';

const STATUS: Record<AttentionReason, { label: string; dot: string; action: 'confirmed' | 'followed_up'; button: string }> = {
  booking_unconfirmed: { label: 'Check TMS', dot: 'var(--critical)', action: 'confirmed', button: 'Mark confirmed' },
  system_error: { label: 'Call back', dot: 'var(--serious)', action: 'followed_up', button: 'Mark called back' },
  confirm_booking: { label: 'Confirm booking', dot: 'var(--warning)', action: 'confirmed', button: 'Mark confirmed' },
  otp_lockout: { label: 'Review', dot: 'var(--serious)', action: 'followed_up', button: 'Mark reviewed' },
};

export default async function Page({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range: raw } = await searchParams;
  const range: Range = raw === '30d' || raw === 'all' ? raw : '7d';
  let all: CallRow[] = [];
  let error: string | null = null;
  try {
    all = await fetchCalls();
  } catch (e) {
    error = (e as Error).message;
  }
  const rows = inRange(all, range);
  const k = kpis(rows);
  const breakdown = outcomeBreakdown(rows);
  const max = Math.max(1, ...breakdown.map((b) => b.count));
  const queue = needsAttention(rows);

  return (
    <main>
      <header className="top">
        <div>
          <h1>Carrier Desk</h1>
          <p className="sub">Inbound carrier calls handled by the AI agent</p>
        </div>
        <nav className="filters" aria-label="Date range">
          {RANGES.map(([value, label]) => (
            <a key={value} href={`?range=${value}`} aria-current={value === range}>{label}</a>
          ))}
        </nav>
      </header>

      {usingSampleData && <p className="notice">Showing sample data. Set NEXT_PUBLIC_TWIN_GATEWAY and NEXT_PUBLIC_ORG_ID to read the live call log from Twin.</p>}
      {error && <p className="notice" role="alert">Could not read the call log from Twin: {error}</p>}

      <section className="tiles" aria-label="Key numbers">
        <Tile label="Booking rate" value={pct(k.bookingRate)} hint={`${k.booked} booked of ${k.verified} verified carriers`} />
        <Tile label="Paid over listed rate" value={k.avgPremiumPct === null ? '–' : `${k.avgPremiumPct.toFixed(1)}%`} hint="Average on booked loads. Lower is better" />
        <Tile label="Counter rounds" value={k.avgRounds === null ? '–' : k.avgRounds.toFixed(1)} hint="Average to close a booking (max 3)" />
        <Tile label="Calls" value={String(k.calls)} hint={`${k.otpLockouts} verification lockouts · ${k.systemErrors} system errors`} />
      </section>

      <div className="grid2">
        <section className="card" aria-labelledby="outcomes">
          <h2 id="outcomes">How calls ended</h2>
          {breakdown.length === 0 ? (
            <p className="empty">No calls in this range.</p>
          ) : (
            <div className="bars" role="list">
              {breakdown.map((b) => (
                <div className="bar-row" role="listitem" key={b.outcome} title={`${b.label}: ${b.count} call${b.count === 1 ? '' : 's'} (${pct(b.count / rows.length)})`}>
                  <span className="name">{b.label}</span>
                  <span className="bar-track"><span className="bar-fill" style={{ display: 'block', width: `${(b.count / max) * 100}%` }} /></span>
                  <span className="count">{b.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="queue">
          <h2 id="queue">Needs a rep ({queue.length})</h2>
          {queue.length === 0 ? (
            <p className="empty">Nothing waiting. Every booking is confirmed and every problem call followed up.</p>
          ) : (
            <div className="queue">
              {queue.slice(0, 8).map(({ row, reason, text }) => {
                const s = STATUS[reason];
                return (
                  <div className="item" key={row.run_id}>
                    <div>
                      <span className="status" style={{ ['--dot' as string]: s.dot }}>{s.label}</span>
                      <div className="who">
                        {row.carrier_name ?? 'Unknown carrier'} {row.mc_number && <span className="why">MC {row.mc_number}</span>}
                      </div>
                      <div className="why">
                        {row.load_id ? `${row.load_id} · ` : ''}
                        {row.lane_origin ?? '?'} → {row.lane_destination ?? 'any'}
                        {row.agreed_rate !== null ? ` · ${money(row.agreed_rate)}` : ''} · {when(row.completed_at)}
                      </div>
                      <div className="why">{text}</div>
                    </div>
                    <form action={markCall}>
                      <input type="hidden" name="run_id" value={row.run_id} />
                      <input type="hidden" name="status" value={s.action} />
                      <button type="submit">{s.button}</button>
                    </form>
                  </div>
                );
              })}
              {queue.length > 8 && <p className="empty">+{queue.length - 8} more in the table below.</p>}
            </div>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="calls">
        <h2 id="calls">All calls</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th><th>Carrier</th><th>MC</th><th>Lane</th><th>Equipment</th><th>Outcome</th>
                <th className="num">Listed</th><th className="num">Agreed</th><th className="num">Rounds</th><th>Rep</th><th>Recording</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.run_id}>
                  <td>{when(r.completed_at)}</td>
                  <td>{r.carrier_name ?? '–'}</td>
                  <td>{r.mc_number ?? '–'}</td>
                  <td>{r.lane_origin ?? '–'} → {r.lane_destination ?? 'any'}</td>
                  <td>{r.equipment_type ?? '–'}</td>
                  <td>{OUTCOME_LABELS[r.outcome ?? ''] ?? r.outcome ?? '–'}</td>
                  <td className="num">{money(r.loadboard_rate)}</td>
                  <td className="num">{money(r.agreed_rate)}</td>
                  <td className="num">{r.negotiation_rounds ?? '–'}</td>
                  <td>{r.ops_status === 'confirmed' ? 'Confirmed' : r.ops_status === 'followed_up' ? 'Followed up' : '–'}</td>
                  <td>{r.run_url ? <a href={r.run_url} target="_blank" rel="noreferrer">Open</a> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

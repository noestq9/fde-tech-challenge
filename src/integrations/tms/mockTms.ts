import { SEED } from '../../fakeTms/server.js';
import type { BookingResult, Load, LoadSearchQuery, LoadSummary, TmsClient } from './types.js';
import { TmsError } from './types.js';

// In-memory TmsClient over the same seed data as the fake TCP server. No network, no faults
// (except origin "timeout"), so API tests stay fast and deterministic.

const toIso = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;

const LOADS: Load[] = SEED.map((l) => ({
  loadId: l.LOAD_ID,
  origin: `${l.ORIG_CITY}, ${l.ORIG_STATE}`,
  originZip: l.ORIG_ZIP,
  destination: `${l.DEST_CITY}, ${l.DEST_STATE}`,
  destinationZip: l.DEST_ZIP,
  pickupDatetime: toIso(l.PICKUP_DT),
  deliveryDatetime: toIso(l.DELIVERY_DT),
  equipmentType: l.EQTYPE,
  loadboardRate: l.RATE,
  miles: l.MILES,
  status: 'OPEN',
  weight: l.WEIGHT,
  commodityType: l.COMMODITY,
  numOfPieces: l.PIECES,
  dimensions: l.DIMS,
  notes: l.NOTES || null,
  maxRate: l.MAX_BUY,
}));

const lc = (s?: string) => (s ?? '').toLowerCase();

export class MockTms implements TmsClient {
  private booked = new Set<string>();

  async searchLoads(q: LoadSearchQuery): Promise<LoadSummary[]> {
    if (lc(q.originCity) === 'timeout') throw new TmsError('timeout', 'simulated TMS timeout');
    return LOADS.filter(
      (l) =>
        !this.booked.has(l.loadId) &&
        (!q.originCity || lc(l.origin).startsWith(lc(q.originCity))) &&
        (!q.originState || l.origin.endsWith(`, ${q.originState.toUpperCase()}`)) &&
        (!q.destinationCity || lc(l.destination).startsWith(lc(q.destinationCity))) &&
        (!q.destinationState || l.destination.endsWith(`, ${q.destinationState.toUpperCase()}`)) &&
        (!q.equipmentType || l.equipmentType === q.equipmentType.toUpperCase()),
    ).slice(0, q.maxResults ?? 10);
  }

  async getLoad(loadId: string): Promise<Load | null> {
    const l = LOADS.find((x) => x.loadId === loadId.toUpperCase());
    return l ? { ...l, status: this.booked.has(l.loadId) ? 'BOOKED' : 'OPEN' } : null;
  }

  async bookLoad(loadId: string, _mcNumber: string, rate: number): Promise<BookingResult> {
    const id = loadId.toUpperCase();
    const l = LOADS.find((x) => x.loadId === id);
    if (!l) throw new TmsError('not_found', `load ${id} not found`);
    if (this.booked.has(id)) throw new TmsError('not_available', `load ${id} already booked`);
    if (rate <= 0) throw new TmsError('rate_rejected', 'rate rejected');
    this.booked.add(id);
    return { loadId: id, status: 'BOOKED', bookingRef: `BR${Date.now().toString().padStart(14, '0').slice(-14)}` };
  }
}

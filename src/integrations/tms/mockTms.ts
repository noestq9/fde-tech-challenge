import type { BookingResult, Load, LoadSearchQuery, TmsClient } from './types.js';
import { TmsError } from './types.js';

const SEED: Load[] = [
  { loadId: 'HR10001', origin: 'Chicago, IL', destination: 'Dallas, TX', pickupDatetime: '2026-10-09T08:00:00-05:00', deliveryDatetime: '2026-10-10T16:00:00-05:00', equipmentType: 'dry_van', loadboardRate: 2100, maxRate: 2450, weight: 38000, commodityType: 'Packaged foods', numOfPieces: 22, miles: 967, dimensions: '48x40x60', notes: 'Drop trailer at shipper' },
  { loadId: 'HR10002', origin: 'Chicago, IL', destination: 'Atlanta, GA', pickupDatetime: '2026-10-09T10:00:00-05:00', deliveryDatetime: '2026-10-10T18:00:00-04:00', equipmentType: 'reefer', loadboardRate: 2400, maxRate: 2800, weight: 41000, commodityType: 'Frozen poultry', numOfPieces: 24, miles: 716, dimensions: '48x40x55', notes: 'Set reefer to -10F, continuous' },
  { loadId: 'HR10003', origin: 'Gary, IN', destination: 'Denver, CO', pickupDatetime: '2026-10-10T07:00:00-05:00', deliveryDatetime: '2026-10-12T12:00:00-06:00', equipmentType: 'flatbed', loadboardRate: 3100, maxRate: 3550, weight: 44000, commodityType: 'Steel coils', numOfPieces: 6, miles: 1015, dimensions: '72x72x60', notes: 'Tarps and chains required' },
  { loadId: 'HR10004', origin: 'Milwaukee, WI', destination: 'Columbus, OH', pickupDatetime: '2026-10-09T13:00:00-05:00', deliveryDatetime: '2026-10-10T09:00:00-04:00', equipmentType: 'dry_van', loadboardRate: 1250, maxRate: 1450, weight: 22000, commodityType: 'Paper products', numOfPieces: 18, miles: 436, dimensions: '48x40x48', notes: '' },
];

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** In-memory stand-in for the legacy TMS, used for tests and demos until the TCP adapter is wired. */
export class MockTms implements TmsClient {
  private loads = new Map(SEED.map((l) => [l.loadId, { ...l }]));
  private booked = new Set<string>();

  async searchLoads(q: LoadSearchQuery): Promise<Load[]> {
    if (norm(q.origin) === 'timeout') throw new TmsError('timeout', 'simulated TMS timeout');
    return [...this.loads.values()].filter(
      (l) =>
        !this.booked.has(l.loadId) &&
        (!q.origin || norm(l.origin).startsWith(norm(q.origin))) &&
        (!q.destination || norm(l.destination).startsWith(norm(q.destination))) &&
        (!q.equipmentType || norm(l.equipmentType) === norm(q.equipmentType)),
    );
  }

  async getLoad(loadId: string): Promise<Load | null> {
    return this.loads.get(loadId.toUpperCase()) ?? null;
  }

  async bookLoad(loadId: string, _mcNumber: string, _rate: number): Promise<BookingResult> {
    const id = loadId.toUpperCase();
    if (!this.loads.has(id)) throw new TmsError('not_found', `load ${id} not found`);
    if (this.booked.has(id)) throw new TmsError('rejected', `load ${id} already booked`);
    this.booked.add(id);
    return { loadId: id, confirmation: `TMS-${id}-${Date.now().toString(36).toUpperCase()}` };
  }
}

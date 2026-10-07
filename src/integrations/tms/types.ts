// Contract between the API and the TMS. The live TCP adapter and the in-memory mock both implement it,
// so the rest of the code never knows which one it talks to.

export interface LoadSummary {
  loadId: string;
  origin: string; // "Atlanta, GA"
  originZip: string;
  destination: string;
  destinationZip: string;
  pickupDatetime: string; // naive ISO (TMS timezone is undocumented)
  equipmentType: string; // DRY_VAN | REEFER | FLATBED | ...
  loadboardRate: number;
  miles: number;
  status: string; // OPEN | BOOKED | ...
}

export interface Load extends LoadSummary {
  deliveryDatetime: string;
  weight: number;
  commodityType: string;
  numOfPieces: number;
  dimensions: string;
  notes: string | null;
  /** Broker ceiling (TMS field MAX_BUY). Absent for tokens without the flag. Never leaves the backend. */
  maxRate: number | null;
}

export interface LoadSearchQuery {
  originCity?: string;
  originState?: string;
  destinationCity?: string;
  destinationState?: string;
  equipmentType?: string;
  maxResults?: number;
}

export interface BookingResult {
  loadId: string;
  /** BOOKED_UNCONFIRMED: first attempt was lost in transit and the retry said ALREADY_BOOKED, i.e. we booked it. */
  status: 'BOOKED' | 'BOOKED_UNCONFIRMED';
  bookingRef: string | null;
}

export interface TmsClient {
  searchLoads(q: LoadSearchQuery): Promise<LoadSummary[]>;
  getLoad(loadId: string): Promise<Load | null>;
  bookLoad(loadId: string, mcNumber: string, rate: number): Promise<BookingResult>;
}

export type TmsErrorKind =
  | 'timeout' // no answer in the time budget
  | 'malformed' // partial or invalid responses on every attempt
  | 'unavailable' // connection errors, server errors, open circuit
  | 'auth' // token rejected: alert ops, never retry
  | 'not_found'
  | 'not_available' // already booked by someone else
  | 'rate_rejected'
  | 'booking_unknown' // booking may or may not have gone through: a human must check
  | 'client_bug'; // MALFORMED / MISSING_FIELD / UNKNOWN_CMD: our request was wrong

export class TmsError extends Error {
  constructor(public readonly kind: TmsErrorKind, message: string, public readonly code?: string) {
    super(message);
    this.name = 'TmsError';
  }
}

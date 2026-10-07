// Contract between the API and the TMS. The live TCP adapter and the in-memory mock both implement it,
// so the rest of the code never knows which one it talks to.

export type EquipmentType = 'dry_van' | 'reefer' | 'flatbed';

export interface Load {
  loadId: string;
  origin: string;
  destination: string;
  pickupDatetime: string;
  deliveryDatetime: string;
  equipmentType: EquipmentType | string;
  loadboardRate: number;
  /** Broker ceiling. Stays inside the backend: never serialized to the agent. */
  maxRate: number;
  weight: number;
  commodityType: string;
  numOfPieces: number;
  miles: number;
  dimensions: string;
  notes: string;
}

export interface LoadSearchQuery {
  origin?: string;
  destination?: string;
  equipmentType?: string;
  pickupDate?: string;
}

export interface BookingResult {
  loadId: string;
  confirmation: string;
}

export interface TmsClient {
  searchLoads(q: LoadSearchQuery): Promise<Load[]>;
  getLoad(loadId: string): Promise<Load | null>;
  bookLoad(loadId: string, mcNumber: string, rate: number): Promise<BookingResult>;
}

/** Normalized TMS failures so routes can map them to clear outcomes. */
export class TmsError extends Error {
  constructor(public readonly kind: 'timeout' | 'malformed' | 'unavailable' | 'rejected' | 'not_found', message: string) {
    super(message);
    this.name = 'TmsError';
  }
}

/** The only load shape the agent ever receives. */
export function toPublicLoad(l: Load) {
  const { maxRate: _hidden, ...rest } = l;
  return rest;
}

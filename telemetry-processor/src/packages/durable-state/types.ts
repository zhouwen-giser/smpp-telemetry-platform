export type StateOperation =
  | { type: 'put'; namespace: string; key: string; value: unknown }
  | { type: 'delete'; namespace: string; key: string }
  | { type: 'check'; namespace: string; key: string; expected: unknown }
  | { type: 'increment'; namespace: string; key: string; amount?: number };

export interface StateScanOptions { prefix?: string; after?: string; limit?: number }
export interface StateItem<T = unknown> { key: string; value: T }
export interface IndexedFrame {
  ingestSequence: number;
  segment: number;
  offset: number;
  offsetEnd: number;
  crc: number;
  kind: string;
}
export interface SegmentState {
  segment: number;
  bytes: number;
  indexedThrough: number;
  firstSequence: number;
  lastSequence: number;
  closed: boolean;
  archivePath: string | null;
  archiveHash: string | null;
  gcState: 'hot' | 'planned' | 'complete';
}

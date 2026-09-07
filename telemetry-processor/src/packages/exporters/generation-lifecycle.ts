import type { WalStore } from "../wal/wal.js";

export interface GenerationLifecycle {
  targetId: string; generation: string; walEpoch: string;
  status: "active" | "draining" | "retired";
  readableUntil: string; updatedAt: string;
  replayJobId?: string;
}
export const generationKey = (targetId: string, generation: string, walEpoch: string): string => `${targetId}/${generation}/${walEpoch}`;

/** Active publishers extend a lease. Draining and retired publishers never resurrect themselves. */
export async function refreshGenerationLease(wal: WalStore, targetId: string, generation: string, now: string): Promise<GenerationLifecycle> {
  const key = generationKey(targetId, generation, wal.walEpoch);
  const previous = wal.state.get<GenerationLifecycle>("generation:lifecycle", key);
  if (previous && previous.status !== "active") return previous;
  const next: GenerationLifecycle = { ...(previous ?? {}), targetId, generation, walEpoch: wal.walEpoch, status: "active",
    readableUntil: new Date(Math.max(Date.parse(previous?.readableUntil ?? now), Date.parse(now) + 600000)).toISOString(), updatedAt: now };
  await wal.state.transaction([{ type: "check", namespace: "generation:lifecycle", key, expected: previous ?? null }, { type: "put", namespace: "generation:lifecycle", key, value: next }]);
  return next;
}
export function assertGenerationWritable(wal: WalStore, targetId: string, generation: string): void {
  const state = wal.state.get<GenerationLifecycle>("generation:lifecycle", generationKey(targetId, generation, wal.walEpoch));
  if (state && state.status !== "active") throw new Error("GENERATION_NOT_ACTIVE");
}

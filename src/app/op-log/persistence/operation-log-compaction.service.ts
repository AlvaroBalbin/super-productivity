import { inject, Injectable } from '@angular/core';
import { LockService } from '../sync/lock.service';
import {
  COMPACTION_RETENTION_MS,
  COMPACTION_TIMEOUT_MS,
  EMERGENCY_COMPACTION_RETENTION_MS,
  LOCK_NAMES,
  SLOW_COMPACTION_THRESHOLD_MS,
} from '../core/operation-log.const';
import { OperationLogStoreService } from './operation-log-store.service';
import { OperationLogEntry } from '../core/operation.types';
import { StateSnapshotService } from '../backup/state-snapshot.service';
import { CURRENT_SCHEMA_VERSION } from './schema-migration.service';
import { VectorClockService } from '../sync/vector-clock.service';
import { OpLog } from '../../core/log';
import { extractEntityKeysFromState } from './extract-entity-keys';
import { hasMeaningfulStateData } from '../validation/has-meaningful-state-data.util';
import { OperationCaptureService } from '../capture/operation-capture.service';
import { getPhantomChangeRisk } from '../capture/phantom-change-guard.util';
import { OperationWriteFlushService } from '../sync/operation-write-flush.service';
import { HydrationStateService } from '../apply/hydration-state.service';

/**
 * An operation may be dropped once it is terminal (synced or rejected, with its
 * application complete), older than the retention window, and covered by the
 * snapshot `lastAppliedOpSeq` belongs to.
 */
const isPrunableOp = (
  entry: OperationLogEntry,
  cutoff: number,
  lastAppliedOpSeq: number,
): boolean => {
  const isRejected = entry.rejectedAt !== undefined;
  const isApplicationComplete =
    isRejected ||
    entry.applicationStatus === undefined ||
    entry.applicationStatus === 'applied';
  const terminalAt = entry.rejectedAt ?? entry.appliedAt;

  return (
    (entry.syncedAt !== undefined || isRejected) &&
    isApplicationComplete &&
    terminalAt < cutoff &&
    entry.seq <= lastAppliedOpSeq // keep tail for conflict frontier
  );
};

/**
 * Manages the compaction (garbage collection) of the operation log.
 * To prevent the log from growing indefinitely, this service periodically
 * creates a complete snapshot of the current application state and stores it
 * in IndexedDB. It then deletes old operations from the log that are already
 * reflected in the snapshot and have been successfully synced (if applicable)
 * and are older than a defined retention window.
 */
@Injectable({ providedIn: 'root' })
export class OperationLogCompactionService {
  private opLogStore = inject(OperationLogStoreService);
  private lockService = inject(LockService);
  private stateSnapshot = inject(StateSnapshotService);
  private vectorClockService = inject(VectorClockService);
  private operationCapture = inject(OperationCaptureService);
  private writeFlushService = inject(OperationWriteFlushService);
  private hydrationState = inject(HydrationStateService);

  async compact(): Promise<boolean> {
    return this._doCompact(COMPACTION_RETENTION_MS);
  }

  /**
   * Emergency compaction triggered when storage quota is exceeded. Deletes
   * operations that the state cache ALREADY on disk covers, using a shorter
   * retention window (1 day instead of 7) to free more space.
   *
   * Delete-only on purpose: quota handling runs from the failing write's own
   * call stack, so live state still holds a change that no durable op
   * represents. Snapshotting there would bake that phantom change into
   * state_cache (#8751) — which is why the guard in _doCompact would make a
   * snapshotting emergency compaction skip every single time (#9082). Pruning
   * against the existing cache frees space without reading live state at all.
   *
   * Returns true if operations were deleted, false otherwise.
   */
  async emergencyCompact(): Promise<boolean> {
    try {
      return await this._pruneOpsCoveredByStateCache(EMERGENCY_COMPACTION_RETENTION_MS);
    } catch (e) {
      OpLog.err('OperationLogCompactionService: Emergency compaction failed', e);
      return false;
    }
  }

  /**
   * Deletes operations the state cache on disk already covers, leaving the
   * cache itself untouched. The seq bound comes from that cache, so an
   * operation is only ever dropped when the snapshot replacing it is durable.
   * @param retentionMs - How long to keep synced operations (in ms)
   */
  private async _pruneOpsCoveredByStateCache(retentionMs: number): Promise<boolean> {
    return this.lockService.request(LOCK_NAMES.OPERATION_LOG, async () => {
      // GUARD (#9140): while this session booted via the hydration fallback,
      // the snapshot on disk could not be loaded — the operations it covers are
      // exactly what the next boot's recovery replays, so pruning them would
      // destroy the last way back. Skipping is always safe (see _doCompact).
      if (this.hydrationState.isHydrationFallbackActive()) {
        OpLog.warn(
          'OperationLogCompactionService: Skipping emergency compaction — hydration fallback recovery active (#9140)',
        );
        return false;
      }

      const stateCache = await this.opLogStore.loadStateCache();
      if (!stateCache) {
        OpLog.warn(
          'OperationLogCompactionService: Skipping emergency compaction — no state cache to prune against',
        );
        return false;
      }

      const cutoff = Date.now() - retentionMs;
      let deletedCount = 0;
      await this.opLogStore.deleteOpsWhere((entry) => {
        const isPrunable = isPrunableOp(entry, cutoff, stateCache.lastAppliedOpSeq);
        if (isPrunable) {
          deletedCount++;
        }
        return isPrunable;
      });

      OpLog.normal('OperationLogCompactionService: Emergency compaction completed', {
        deletedCount,
      });

      // Nothing freed means the retry would just hit the quota again.
      return deletedCount > 0;
    });
  }

  /**
   * Core compaction logic: snapshots the live state and prunes the operations
   * it covers.
   * @param retentionMs - How long to keep synced operations (in ms)
   */
  private async _doCompact(retentionMs: number): Promise<boolean> {
    // Fast-path (re-checked inside the lock via getPhantomChangeRisk): the
    // divergence flag is sticky for the session, so once set every attempt
    // would skip anyway — avoid the cross-tab lock churn, since a compact()
    // fires after every write while the counter sits at the threshold.
    if (this.operationCapture.hasUnrecoveredPersistFailure()) {
      OpLog.warn(
        'OperationLogCompactionService: Skipping compaction — an unrecovered persist failure left live state ahead of the op log (#8751)',
      );
      return false;
    }
    const compactExclusively = async (): Promise<boolean> => {
      const startTime = Date.now();

      // A snapshot must never advance past remote operations whose reducers have
      // not committed yet. Otherwise restart hydration would treat those ops as
      // covered by the snapshot even though their state is missing from it.
      const pendingRemoteOps = await this.opLogStore.getPendingRemoteOps();
      this.checkCompactionTimeout(startTime, 'pending operation check');
      if (pendingRemoteOps.length > 0) {
        OpLog.warn(
          'OperationLogCompactionService: Skipping compaction — remote reducer work is pending',
        );
        return false;
      }

      // GUARD (#8751): live state must not be snapshotted while it contains
      // changes that no durable op represents (failed or still-pending writes,
      // undrained deferred actions) — the state-cache write below would bake
      // such a phantom change in as permanent, silent cross-device divergence.
      // Checked synchronously IMMEDIATELY before the snapshot read (no awaits
      // in between) so nothing can slip in behind the guard.
      //
      // DO NOT HOIST THIS ABOVE THE getPendingRemoteOps() AWAIT. The position
      // is load-bearing in both directions, and this is the upper bound:
      // triggerCompaction() fires from inside the write path, so the action
      // that triggered us is still counted pending here and is decremented on
      // a microtask chain once that write releases the lock we just took. The
      // await above is a real IndexedDB round-trip, which lets those
      // microtasks drain first — that is the ONLY reason the guard observes a
      // settled counter rather than skipping on every single attempt.
      // Checking earlier ("the cheap guard first") starves compaction
      // permanently. Covered by the guard-position spec.
      //
      // Skipping is always safe: the op-log stays the source of truth, and
      // compaction re-runs once writes settle / the deferred drain succeeds /
      // the user reloads after an unrecovered failure (the sticky snackbar
      // asks for exactly that). Quota recovery cannot wait for that, which is
      // why it prunes against the existing cache instead of coming through
      // here (see emergencyCompact).
      const phantomRisk = getPhantomChangeRisk(this.operationCapture);
      if (phantomRisk) {
        OpLog.warn(
          `OperationLogCompactionService: Skipping compaction — ${phantomRisk} (#8751)`,
        );
        return false;
      }

      // GUARD (#9140): while this session booted via the hydration fallback,
      // the live state may be PARTIAL (rebuilt from the surviving op tail
      // only) while the intact-but-unhydratable snapshot still sits on disk.
      // Compacting would overwrite that last complete local copy AND prune
      // the ops the next boot's recovery replays. Skipping is always safe —
      // see the #7892 note below; pruning resumes after the next clean boot.
      if (this.hydrationState.isHydrationFallbackActive()) {
        OpLog.warn(
          'OperationLogCompactionService: Skipping compaction — hydration fallback recovery active (#9140)',
        );
        return false;
      }

      // 1. Get current state from NgRx store
      const currentState = this.stateSnapshot.getStateSnapshotForOperationLog();
      this.checkCompactionTimeout(startTime, 'state snapshot');

      // GUARD (#7892): never compact against an empty/degraded state. Compaction
      // both writes the state cache AND deletes old synced ops — if the live
      // state were a transient empty/initial state, we would cache emptiness and
      // then prune the very ops needed to recover. Skipping is always safe for
      // correctness: the op-log stays the source of truth and replaying the
      // un-pruned log reconstructs the correct state, including legitimate full
      // wipes. Trade-off: a store that is *genuinely* empty-but-active (e.g. the
      // user deleted everything yet keeps generating synced ops) will never get
      // its old synced ops pruned while it stays empty, so the log can grow. That
      // is an accepted cost — preventing empty-over-good is worth more than GC for
      // this rare case, and pruning resumes as soon as real data exists again.
      if (!hasMeaningfulStateData(currentState)) {
        OpLog.warn(
          'OperationLogCompactionService: Skipping compaction — current state has no ' +
            'meaningful data (refusing to overwrite cache and prune ops against empty state)',
        );
        return false;
      }

      // 2. Get current vector clock (max of all ops); pruning happens inside
      // saveStateCache (store-owned, #9096)
      const currentVectorClock = await this.vectorClockService.getCurrentVectorClock();
      this.checkCompactionTimeout(startTime, 'vector clock');

      // 3. Get lastSeq IMMEDIATELY before writing cache to minimize race window
      // This ensures new ops written after this point have seq > lastSeq
      const lastSeq = await this.opLogStore.getLastSeq();

      // 4. Extract entity keys for conflict detection after compaction
      // This allows us to distinguish between entities that existed at snapshot time
      // vs new entities created later - critical for correct vector clock comparison
      const snapshotEntityKeys = extractEntityKeysFromState(currentState);

      // 5. Write to state cache with schema version and entity keys
      await this.opLogStore.saveStateCache({
        state: currentState,
        lastAppliedOpSeq: lastSeq,
        vectorClock: currentVectorClock,
        compactedAt: Date.now(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        snapshotEntityKeys,
      });

      // After snapshot is saved, new operations with seq > lastSeq won't be deleted

      // 6. Reset compaction counter (persistent across tabs/restarts)
      await this.opLogStore.resetCompactionCounter();

      // 7. Delete old terminal operations (keep recent for conflict resolution)
      const cutoff = Date.now() - retentionMs;

      await this.opLogStore.deleteOpsWhere((entry) =>
        isPrunableOp(entry, cutoff, lastSeq),
      );

      // Log metrics for slow compaction
      const totalDuration = Date.now() - startTime;
      if (totalDuration > SLOW_COMPACTION_THRESHOLD_MS) {
        OpLog.normal('OperationLogCompactionService: Compaction completed', {
          durationMs: totalDuration,
          entityCount: snapshotEntityKeys.length,
        });
      }

      return true;
    };

    // #8469: drain the capture pipeline before capturing so no action can be
    // dispatched-but-unsequenced at the state read — otherwise its effect is
    // baked into the cache while its seq lands after lastAppliedOpSeq, and the
    // next boot's tail replay double-applies it.
    return this.writeFlushService.flushThenRunExclusive(compactExclusively);
  }

  /**
   * Checks if compaction has exceeded the timeout threshold.
   * If exceeded, throws an error to abort compaction before the lock expires.
   * This prevents data corruption from concurrent access.
   */
  private checkCompactionTimeout(startTime: number, phase: string): void {
    const elapsed = Date.now() - startTime;
    if (elapsed > COMPACTION_TIMEOUT_MS) {
      throw new Error(
        `Compaction timeout after ${elapsed}ms during ${phase}. ` +
          `Aborting to prevent lock expiration. ` +
          `Consider reducing state size or increasing timeout.`,
      );
    }
  }
}

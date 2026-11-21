import crypto from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getAdminServices } from './firebaseAdmin.ts';

const JOB_DOC_PATH = 'systemJobs/publishScheduledNews';
const LOCK_LEASE_MS = 4 * 60 * 1000;

export async function publishDueScheduledNews(
  triggeredBy = 'scheduler',
  dbOverride?: Firestore
): Promise<{ ok: boolean; publishedCount: number; skipped?: boolean }> {
  const db = dbOverride || getAdminServices().db;
  if (!db) {
    return { ok: false, publishedCount: 0, skipped: true };
  }

  const nowMs = Date.now();
  const lockOwner = crypto.randomUUID();
  const jobRef = db.doc(JOB_DOC_PATH);

  const acquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    const data = snap.exists ? snap.data() || {} : {};
    const isRunning =
      Boolean(data.running) &&
      typeof data.leaseUntilMs === 'number' &&
      data.leaseUntilMs > nowMs;
    if (isRunning) return false;

    tx.set(
      jobRef,
      {
        running: true,
        lockOwner,
        leaseUntilMs: nowMs + LOCK_LEASE_MS,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });

  if (!acquired) {
    return { ok: true, publishedCount: 0, skipped: true };
  }

  try {
    const nowTs = Timestamp.fromMillis(nowMs);
    const scheduled = await db
      .collection('news')
      .where('status', '==', 'scheduled')
      .where('publishedAt', '<=', nowTs)
      .limit(50)
      .get();

    if (!scheduled.empty) {
      const batch = db.batch();
      scheduled.docs.forEach((docSnap) => {
        batch.update(docSnap.ref, {
          status: 'published',
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      const logRef = db.collection('auditLogs').doc();
      batch.set(logRef, {
        actorUid: triggeredBy === 'scheduler' ? 'system_scheduler' : triggeredBy,
        actorLabel: triggeredBy === 'scheduler' ? 'Agendador NXF' : triggeredBy,
        action: 'PUBLISH_SCHEDULED_NEWS',
        entityType: 'news',
        entityId: scheduled.docs.map((d) => d.id).join(',').slice(0, 120),
        summary: `${scheduled.size} notícia(s) agendada(s) publicada(s) automaticamente.`,
        createdAt: FieldValue.serverTimestamp(),
      });

      await batch.commit();
    }

    await jobRef.set(
      {
        running: false,
        lockOwner: null,
        leaseUntilMs: 0,
        lastRunAt: nowTs,
        lastPublishedCount: scheduled.size,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, publishedCount: scheduled.size };
  } catch (err) {
    await jobRef.set(
      {
        running: false,
        lockOwner: null,
        leaseUntilMs: 0,
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { ok: false, publishedCount: 0 };
  }
}

let newsSchedulerStarted = false;

export function startNewsScheduler(): void {
  if (newsSchedulerStarted) return;
  newsSchedulerStarted = true;

  const runSafe = () => {
    const { configured } = getAdminServices();
    if (!configured) return;
    void publishDueScheduledNews('scheduler').catch((err) => {
      console.warn('[NewsScheduler] Falha ao publicar matérias agendadas:', err instanceof Error ? err.message : String(err));
    });
  };

  setTimeout(runSafe, 20_000).unref();
  setInterval(runSafe, 15 * 60 * 1000).unref();
}

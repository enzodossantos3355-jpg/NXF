/**
 * NXF eSports — Suíte de Testes das Regras de Segurança do Cloud Firestore
 *
 * Execução contra o Firebase Firestore Emulator (requer Java 11+):
 *   npm run test:rules
 *   (equivalente a: firebase emulators:exec --only firestore "npx tsx firestore.rules.test.ts")
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

const PROJECT_ID = 'nxf-esports-rules-test';

async function seedBaselineData(testEnv: RulesTestEnvironment) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();

    await setDoc(doc(db, 'test', 'connection'), { ok: true });
    await setDoc(doc(db, 'app_settings', 'legacy'), { secret: 'blocked' });
    await setDoc(doc(db, 'sent_offers', 'legacy1'), { amount: 100 });

    await setDoc(doc(db, 'users', 'primary1'), {
      uid: 'primary1',
      fullName: 'Admin Principal',
      displayName: 'AdminNXF',
      code: '#NXF001',
      roles: ['primary_admin'],
      teamIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'admins', 'primary1'), {
      uid: 'primary1',
      role: 'primary_admin',
      permissions: ['*'],
      active: true,
      grantedBy: 'primary1',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'candidate1'), {
      uid: 'candidate1',
      fullName: 'Candidato Teste',
      displayName: 'Cand1',
      code: '#CAND01',
      roles: ['candidate'],
      teamIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'player1'), {
      uid: 'player1',
      fullName: 'Jogador Um',
      displayName: 'Player1',
      code: '#PLY001',
      roles: ['player'],
      teamIds: ['team-a'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'coachA'), {
      uid: 'coachA',
      fullName: 'Coach Alpha',
      displayName: 'CoachA',
      code: '#COACHA',
      roles: ['coach'],
      teamIds: ['team-a'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'teams', 'team-a'), {
      id: 'team-a',
      name: 'NXF Alpha',
      category: 'Principal',
      isPublic: true,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'teams', 'team-secret'), {
      id: 'team-secret',
      name: 'NXF Academy Private',
      category: 'Interna',
      isPublic: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'teamMemberships', 'team-a_player1'), {
      teamId: 'team-a',
      uid: 'player1',
      nickname: 'Player1',
      roleInTeam: 'starter',
      status: 'active',
      joinedAt: now,
    });
    await setDoc(doc(db, 'teamMemberships', 'team-a_coachA'), {
      teamId: 'team-a',
      uid: 'coachA',
      nickname: 'CoachA',
      roleInTeam: 'coach',
      status: 'active',
      joinedAt: now,
    });

    await setDoc(doc(db, 'vacancies', 'vac-open'), {
      teamId: 'team-a',
      teamName: 'NXF Alpha',
      title: 'Tank Titular',
      roleTarget: 'Tank',
      status: 'open',
      createdBy: 'primary1',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'vacancies', 'vac-closed'), {
      teamId: 'team-a',
      teamName: 'NXF Alpha',
      title: 'Vaga Fechada Interna',
      roleTarget: 'Suporte',
      status: 'closed',
      createdBy: 'primary1',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'applications', 'vac-open_candidate1'), {
      vacancyId: 'vac-open',
      teamId: 'team-a',
      applicantUid: 'candidate1',
      applicantName: 'Cand1',
      stage: 'recebida',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'trainings', 'tr-a1'), {
      teamId: 'team-a',
      title: 'Scrim Alpha',
      scheduledAt: now,
      status: 'scheduled',
      createdBy: 'coachA',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'systemSettings', 'global'), {
      enabledModules: { teams: true },
      brawlApiConfigured: false,
      updatedBy: 'primary1',
      updatedAt: now,
    });

    await setDoc(doc(db, 'auditLogs', 'log1'), {
      actorUid: 'primary1',
      action: 'BOOTSTRAP',
      entityType: 'admins',
      entityId: 'primary1',
      summary: 'Seed log',
      createdAt: now,
    });
  });
}

async function run() {
  const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules },
  });

  try {
    await seedBaselineData(testEnv);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    const candDb = testEnv.authenticatedContext('candidate1').firestore();
    const playerDb = testEnv.authenticatedContext('player1').firestore();
    const coachADb = testEnv.authenticatedContext('coachA').firestore();
    const primaryDb = testEnv.authenticatedContext('primary1').firestore();

    // 1. Legacy collections explicitly blocked for everyone
    await assertFails(getDoc(doc(anonDb, 'app_settings', 'legacy')));
    await assertFails(getDoc(doc(primaryDb, 'app_settings', 'legacy')));
    await assertFails(setDoc(doc(primaryDb, 'sent_offers', 'x'), { a: 1 }));

    // 2. Unauthenticated reads of public vs private docs
    await assertSucceeds(getDocs(query(collection(anonDb, 'teams'), where('isPublic', '==', true))));
    await assertFails(getDoc(doc(anonDb, 'teams', 'team-secret')));
    await assertFails(getDoc(doc(anonDb, 'users', 'candidate1')));
    await assertFails(getDoc(doc(anonDb, 'systemSettings', 'global')));

    // 3. Candidate isolation & anti-escalation
    await assertSucceeds(getDoc(doc(candDb, 'users', 'candidate1')));
    await assertFails(getDoc(doc(candDb, 'users', 'player1')));
    await assertFails(getDoc(doc(candDb, 'teams', 'team-secret')));
    await assertFails(getDoc(doc(candDb, 'vacancies', 'vac-closed')));
    await assertFails(getDoc(doc(candDb, 'systemSettings', 'global')));
    await assertFails(
      updateDoc(doc(candDb, 'users', 'candidate1'), {
        roles: ['primary_admin'],
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(candDb, 'admins', 'candidate1'), {
        uid: 'candidate1',
        role: 'primary_admin',
        active: true,
        grantedBy: 'candidate1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(candDb, 'applications', 'vac-open_candidate1'), {
        stage: 'aprovada',
        updatedAt: serverTimestamp(),
      })
    );

    // 4. Official member (player / coach) scoped access
    await assertSucceeds(getDoc(doc(playerDb, 'teams', 'team-secret')));
    await assertSucceeds(getDoc(doc(playerDb, 'systemSettings', 'global')));
    await assertSucceeds(
      getDocs(query(collection(playerDb, 'trainings'), where('teamId', '==', 'team-a')))
    );
    await assertFails(
      setDoc(doc(coachADb, 'trainings', 'tr-secret'), {
        teamId: 'team-secret',
        title: 'Unauthorized Team Training',
        scheduledAt: Timestamp.now(),
        status: 'scheduled',
        createdBy: 'coachA',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 5. System-only & backend-only writes blocked from client SDK even for Primary Admin
    await assertFails(setDoc(doc(playerDb, 'playerStats', 'player1'), { trophies: 99999 }));
    await assertFails(deleteDoc(doc(primaryDb, 'auditLogs', 'log1')));
    await assertFails(
      setDoc(doc(primaryDb, 'admins', 'player1'), {
        uid: 'player1',
        role: 'primary_admin',
        active: true,
        grantedBy: 'primary1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(primaryDb, 'notifications', 'n1'), {
        recipientUid: 'player1',
        title: 'Direct client write blocked',
        body: 'Must go via backend',
        category: 'system',
        read: false,
        createdAt: serverTimestamp(),
      })
    );

    // 6. Primary Admin legitimate read operations succeed
    await assertSucceeds(getDocs(collection(primaryDb, 'auditLogs')));
    await assertSucceeds(getDocs(collection(primaryDb, 'users')));

    console.log('Todos os testes de regras do Firestore passaram com sucesso.');
  } finally {
    await testEnv.cleanup();
  }
}

run().catch((err) => {
  console.error('Falha nos testes de regras do Firestore:', err);
  process.exit(1);
});

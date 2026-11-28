/**
 * NXF eSports — Suíte Completa de Testes das Regras de Segurança do Cloud Firestore
 *
 * Cobre todos os 7 perfis de acesso exigidos pela arquitetura:
 *   1. Visitante (não autenticado)
 *   2. Candidato (conta básica ['candidate'])
 *   3. Jogador oficial (['player'] vinculado a team-a)
 *   4. Treinador (['coach'] vinculado a team-a)
 *   5. Gestor de equipe (['manager'] vinculado a team-a)
 *   6. Administrador Delegado (perfis separados: cms.manage e system.manage)
 *   7. Administrador Principal (primary_admin)
 *
 * Execução contra o Firebase Firestore Emulator (requer Java 11+):
 *   npm run test:rules
 *   (equivalente a: firebase emulators:exec --only firestore "npx tsx firestore.rules.test.ts")
 */

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

const PROJECT_ID = 'demo-nxf-esports-rules-test';

async function seedBaselineData(testEnv: RulesTestEnvironment) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();

    // Documento de verificação de conectividade e coleções desconhecidas/internas
    await setDoc(doc(db, 'test', 'connection'), { ok: true });
    await setDoc(doc(db, 'unknown_collection', 'doc1'), { secret: 'blocked' });
    await setDoc(doc(db, 'mediaBlobs', 'blob1'), { base64Data: 'AAAA' });
    await setDoc(doc(db, 'systemJobs', 'brawlStarsSync'), { running: false });
    await setDoc(doc(db, 'playerAnalytics', 'player1'), {
      uid: 'player1',
      brawlTag: '#PLY001',
      battlesAnalyzed: 10,
      wins: 7,
      losses: 3,
      winRate: 70,
      updatedAt: now,
    });
    await setDoc(doc(db, 'teamAnalytics', 'team-a'), {
      teamId: 'team-a',
      teamName: 'NXF Alpha',
      battlesAnalyzed: 12,
      wins: 9,
      losses: 3,
      winRate: 75,
      updatedAt: now,
    });
    await setDoc(doc(db, 'brawlBattles', 'b_sample001'), {
      battleId: 'b_sample001',
      mode: 'gemGrab',
      map: 'Hard Rock Mine',
      createdAt: now,
    });
    await setDoc(doc(db, 'matchTrackerCandidates', 'cand_sample001'), {
      battleId: 'b_sample001',
      matchId: 'match-locked',
      status: 'pending_review',
      createdAt: now,
    });
    await setDoc(doc(db, 'brawlSyncLogs', 'log_sample001'), {
      jobType: 'stats_sync',
      status: 'ok',
      createdAt: now,
    });
    await setDoc(doc(db, 'matches', 'match-locked'), {
      teamId: 'team-a',
      teamName: 'NXF Alpha',
      opponentName: 'NXF Beta',
      tournamentId: 't-locked',
      stage: 'groups',
      format: 'MD3',
      scheduledAt: now,
      status: 'completed',
      nxfScore: 2,
      opponentScore: 0,
      locked: true,
      isPublic: true,
      createdAt: now,
      updatedAt: now,
    });

    // 1. Administrador Principal
    await setDoc(doc(db, 'users', 'primary1'), {
      uid: 'primary1',
      fullName: 'Admin Principal',
      displayName: 'AdminNXF',
      code: '#NXF001',
      roles: ['primary_admin'],
      delegatedPermissions: [],
      teamIds: [],
      status: 'active',
      brawlTag: '#NXF001',
      brawlTagStatus: 'approved',
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

    // 2. Administrador Delegado — apenas CMS (cms.manage)
    await setDoc(doc(db, 'users', 'delegatedCms'), {
      uid: 'delegatedCms',
      fullName: 'Editor CMS NXF',
      displayName: 'CmsNXF',
      code: '#CMS001',
      roles: ['delegated_admin'],
      delegatedPermissions: ['cms.manage'],
      teamIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'admins', 'delegatedCms'), {
      uid: 'delegatedCms',
      role: 'delegated_admin',
      permissions: ['cms.manage'],
      active: true,
      grantedBy: 'primary1',
      createdAt: now,
      updatedAt: now,
    });

    // 3. Administrador Delegado — apenas Sistema (system.manage)
    await setDoc(doc(db, 'users', 'delegatedSys'), {
      uid: 'delegatedSys',
      fullName: 'Operador Sistema NXF',
      displayName: 'SysNXF',
      code: '#SYS001',
      roles: ['delegated_admin'],
      delegatedPermissions: ['system.manage'],
      teamIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'admins', 'delegatedSys'), {
      uid: 'delegatedSys',
      role: 'delegated_admin',
      permissions: ['system.manage'],
      active: true,
      grantedBy: 'primary1',
      createdAt: now,
      updatedAt: now,
    });

    // 4. Gestor de equipe (team-a)
    await setDoc(doc(db, 'users', 'managerA'), {
      uid: 'managerA',
      fullName: 'Gestor Alpha',
      displayName: 'MgrA',
      code: '#MGRA01',
      roles: ['manager'],
      teamIds: ['team-a'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // 5. Treinador (team-a)
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

    // 6. Jogador oficial (team-a) com brawlTag já aprovada + perfil público
    await setDoc(doc(db, 'users', 'player1'), {
      uid: 'player1',
      fullName: 'Jogador Um',
      displayName: 'Player1',
      code: '#PLY001',
      roles: ['player'],
      teamIds: ['team-a'],
      status: 'active',
      brawlTag: '#PLY001',
      brawlTagStatus: 'approved',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'publicProfiles', 'player1'), {
      uid: 'player1',
      nickname: 'Player1',
      publicRole: 'Jogador Oficial',
      layout: 'classic',
      teamIds: ['team-a'],
      brawlTag: '#PLY001',
      brawlTagApproved: true,
      isActiveMember: true,
      showInEntrySelector: true,
      moderationStatus: 'approved',
      createdAt: now,
      updatedAt: now,
    });

    // 7. Candidato ativo + usuário suspenso
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
    await setDoc(doc(db, 'users', 'suspended1'), {
      uid: 'suspended1',
      fullName: 'Conta Suspensa',
      displayName: 'Susp1',
      code: '#SUSP01',
      roles: ['player'],
      teamIds: ['team-a'],
      status: 'suspended',
      createdAt: now,
      updatedAt: now,
    });

    // Equipes (pública vs privada) e vínculos de elenco
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

    await setDoc(doc(db, 'teamMemberships', 'team-a_managerA'), {
      teamId: 'team-a',
      uid: 'managerA',
      nickname: 'MgrA',
      roleInTeam: 'manager',
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
    await setDoc(doc(db, 'teamMemberships', 'team-a_player1'), {
      teamId: 'team-a',
      uid: 'player1',
      nickname: 'Player1',
      roleInTeam: 'starter',
      status: 'active',
      joinedAt: now,
    });

    // Vagas e candidaturas
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
    await setDoc(doc(db, 'applicationNotes', 'vac-open_candidate1'), {
      applicationId: 'vac-open_candidate1',
      teamId: 'team-a',
      notes: 'Avaliação confidencial: boa leitura de mapa, testar em scrim.',
      updatedBy: 'coachA',
      updatedAt: now,
    });

    // Treinamentos e presença (equipe A vs equipe secreta)
    await setDoc(doc(db, 'trainings', 'tr-a1'), {
      teamId: 'team-a',
      title: 'Scrim Alpha',
      scheduledAt: now,
      status: 'scheduled',
      createdBy: 'coachA',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'trainings', 'tr-secret1'), {
      teamId: 'team-secret',
      title: 'Scrim Secreta',
      scheduledAt: now,
      status: 'scheduled',
      createdBy: 'primary1',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'attendance', 'tr-a1_player1'), {
      trainingId: 'tr-a1',
      teamId: 'team-a',
      uid: 'player1',
      nickname: 'Player1',
      playerStatus: 'confirmed',
      coachVerifiedStatus: 'present',
      verifiedBy: 'coachA',
      updatedAt: now,
    });

    // CMS (notícia publicada vs rascunho)
    await setDoc(doc(db, 'news', 'news-pub'), {
      slug: 'estreia-nxf',
      title: 'Estreia NXF',
      summary: 'Resumo público da estreia oficial.',
      content: 'Conteúdo público completo da matéria.',
      status: 'published',
      authorUid: 'primary1',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'news', 'news-draft'), {
      slug: 'rascunho-interno',
      title: 'Rascunho Interno',
      summary: 'Resumo interno não publicado.',
      content: 'Conteúdo interno de rascunho.',
      status: 'draft',
      authorUid: 'primary1',
      createdAt: now,
      updatedAt: now,
    });

    // Sistema, suporte e auditoria
    await setDoc(doc(db, 'systemSettings', 'global'), {
      enabledModules: { teams: true },
      brawlApiConfigured: false,
      primaryAdminCount: 1,
      updatedBy: 'primary1',
      updatedAt: now,
    });
    await setDoc(doc(db, 'supportTickets', 'tk-1'), {
      requesterUid: 'player1',
      requesterName: 'Player1',
      subject: 'Problema na tag',
      category: 'brawl_tag',
      description: 'Minha tag não sincronizou corretamente no painel.',
      status: 'aberto',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'auditLogs', 'log1'), {
      actorUid: 'primary1',
      action: 'BOOTSTRAP_PRIMARY_ADMIN',
      entityType: 'admins',
      entityId: 'primary1',
      summary: 'Seed log',
      createdAt: now,
    });
  });
}

async function run() {
  const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  const emulatorHostEnv = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').trim();
  const lastColon = emulatorHostEnv.lastIndexOf(':');
  const host = lastColon > 0 ? emulatorHostEnv.slice(0, lastColon) : '127.0.0.1';
  const port = lastColon > 0 ? Number(emulatorHostEnv.slice(lastColon + 1)) || 8080 : 8080;

  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host, port, rules },
  });

  try {
    await seedBaselineData(testEnv);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    const candDb = testEnv.authenticatedContext('candidate1').firestore();
    const suspDb = testEnv.authenticatedContext('suspended1').firestore();
    const playerDb = testEnv.authenticatedContext('player1').firestore();
    const coachADb = testEnv.authenticatedContext('coachA').firestore();
    const managerADb = testEnv.authenticatedContext('managerA').firestore();
    const delegatedCmsDb = testEnv.authenticatedContext('delegatedCms').firestore();
    const delegatedSysDb = testEnv.authenticatedContext('delegatedSys').firestore();
    const primaryDb = testEnv.authenticatedContext('primary1').firestore();

    // =========================================================================
    // 1. Default-deny e coleções exclusivas de backend
    // =========================================================================
    await assertFails(getDoc(doc(anonDb, 'unknown_collection', 'doc1')));
    await assertFails(getDoc(doc(primaryDb, 'unknown_collection', 'doc1')));
    await assertFails(getDoc(doc(primaryDb, 'mediaBlobs', 'blob1')));
    await assertFails(getDoc(doc(primaryDb, 'systemJobs', 'brawlStarsSync')));
    await assertSucceeds(getDoc(doc(anonDb, 'test', 'connection')));

    // =========================================================================
    // 2. Visitante (não autenticado)
    // =========================================================================
    await assertSucceeds(getDocs(query(collection(anonDb, 'teams'), where('isPublic', '==', true))));
    await assertSucceeds(getDocs(query(collection(anonDb, 'news'), where('status', '==', 'published'))));
    await assertSucceeds(getDocs(query(collection(anonDb, 'vacancies'), where('status', '==', 'open'))));
    await assertSucceeds(
      getDocs(
        query(
          collection(anonDb, 'publicProfiles'),
          where('isActiveMember', '==', true),
          where('showInEntrySelector', '==', true),
          where('moderationStatus', '==', 'approved')
        )
      )
    );
    await assertFails(getDocs(collection(anonDb, 'teams'))); // Sem filtro isPublic == true
    await assertFails(getDoc(doc(anonDb, 'teams', 'team-secret')));
    await assertFails(getDoc(doc(anonDb, 'news', 'news-draft')));
    await assertFails(getDoc(doc(anonDb, 'users', 'candidate1')));
    await assertFails(getDoc(doc(anonDb, 'systemSettings', 'global')));
    await assertFails(getDoc(doc(anonDb, 'applicationNotes', 'vac-open_candidate1')));
    await assertFails(getDocs(collection(anonDb, 'applicationNotes')));

    // =========================================================================
    // 3. Candidato (isolamento e bloqueio de escalação de privilégio)
    // =========================================================================
    await assertSucceeds(getDoc(doc(candDb, 'users', 'candidate1')));
    await assertSucceeds(
      getDocs(query(collection(candDb, 'applications'), where('applicantUid', '==', 'candidate1')))
    );
    await assertFails(getDoc(doc(candDb, 'users', 'player1')));
    await assertFails(getDoc(doc(candDb, 'teams', 'team-secret')));
    await assertFails(getDoc(doc(candDb, 'vacancies', 'vac-closed')));
    await assertFails(getDoc(doc(candDb, 'systemSettings', 'global')));
    await assertFails(getDoc(doc(candDb, 'trainings', 'tr-a1')));
    await assertFails(
      updateDoc(doc(candDb, 'users', 'candidate1'), {
        roles: ['primary_admin'],
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(candDb, 'users', 'candidate1'), {
        brawlTagStatus: 'approved',
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
    // Candidato NUNCA pode acessar notas internas de recrutamento (get ou list)
    await assertFails(getDoc(doc(candDb, 'applicationNotes', 'vac-open_candidate1')));
    await assertFails(getDocs(collection(candDb, 'applicationNotes')));
    await assertFails(
      getDocs(query(collection(candDb, 'applicationNotes'), where('teamId', '==', 'team-a')))
    );
    // Candidato NÃO pode forjar teamId diferente da vaga ao se candidatar
    await assertFails(
      setDoc(doc(candDb, 'applications', 'vac-open_candidate1'), {
        vacancyId: 'vac-open',
        teamId: 'team-secret',
        applicantUid: 'candidate1',
        applicantName: 'Cand1',
        stage: 'recebida',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // Usuário suspenso não pode atualizar próprio cadastro nem ler dados restritos
    await assertFails(
      updateDoc(doc(suspDb, 'users', 'suspended1'), {
        displayName: 'TentativaSusp',
        updatedAt: serverTimestamp(),
      })
    );

    // =========================================================================
    // 4. Jogador Oficial (acesso por equipe, anti-spoofing, bloqueio de systemSettings)
    // =========================================================================
    await assertSucceeds(getDoc(doc(playerDb, 'teams', 'team-secret')));
    await assertFails(getDoc(doc(playerDb, 'systemSettings', 'global')));
    await assertFails(getDoc(doc(playerDb, 'applicationNotes', 'vac-open_candidate1')));
    await assertFails(
      getDocs(query(collection(playerDb, 'applicationNotes'), where('teamId', '==', 'team-a')))
    );
    await assertSucceeds(
      getDocs(query(collection(playerDb, 'trainings'), where('teamId', 'in', ['team-a'])))
    );
    await assertFails(
      getDocs(query(collection(playerDb, 'trainings'), where('teamId', 'in', ['team-secret'])))
    );
    await assertSucceeds(
      getDocs(query(collection(playerDb, 'attendance'), where('uid', '==', 'player1')))
    );
    // Jogador com brawlTagStatus já 'approved' pode atualizar displayName mantendo tag intacta
    await assertSucceeds(
      updateDoc(doc(playerDb, 'users', 'player1'), {
        displayName: 'Player1New',
        brawlTagStatus: 'approved',
        updatedAt: serverTimestamp(),
      })
    );
    // Jogador pode atualizar sua confirmação de presença sem sobrescrever coachVerifiedStatus
    await assertSucceeds(
      updateDoc(doc(playerDb, 'attendance', 'tr-a1_player1'), {
        nickname: 'Player1New',
        playerStatus: 'declined',
        justification: 'Imprevisto familiar',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(playerDb, 'attendance', 'tr-a1_player1'), {
        coachVerifiedStatus: 'justified',
        updatedAt: serverTimestamp(),
      })
    );
    // Jogador NÃO pode alterar campos privilegiados em publicProfiles nem forjar brawlTagApproved
    await assertFails(
      updateDoc(doc(playerDb, 'publicProfiles', 'player1'), {
        publicRole: 'Administrador Principal',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(playerDb, 'publicProfiles', 'player1'), {
        brawlTag: '#FAKETAG',
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(playerDb, 'publicProfiles', 'player1'), {
        brawlTag: '#NEWTAG1',
        brawlTagApproved: false,
        socialLinks: { twitter: 'https://x.com/player1' },
        updatedAt: serverTimestamp(),
      })
    );
    // Jogador NÃO pode enviar chaves inválidas em socialLinks
    await assertFails(
      updateDoc(doc(playerDb, 'publicProfiles', 'player1'), {
        socialLinks: { hackedKey: 'evil' },
        updatedAt: serverTimestamp(),
      })
    );

    // =========================================================================
    // 5. Treinador (escopo na própria equipe, bloqueado em elenco/equipe/outra equipe)
    // =========================================================================
    await assertFails(getDoc(doc(coachADb, 'systemSettings', 'global')));
    await assertSucceeds(
      getDocs(query(collection(coachADb, 'trainings'), where('teamId', 'in', ['team-a'])))
    );
    await assertSucceeds(
      getDocs(query(collection(coachADb, 'attendance'), where('teamId', 'in', ['team-a'])))
    );
    await assertSucceeds(
      getDocs(query(collection(coachADb, 'applications'), where('teamId', 'in', ['team-a'])))
    );
    await assertSucceeds(
      getDocs(query(collection(coachADb, 'applicationNotes'), where('teamId', 'in', ['team-a'])))
    );
    await assertSucceeds(
      setDoc(doc(coachADb, 'applicationNotes', 'vac-open_candidate1'), {
        applicationId: 'vac-open_candidate1',
        teamId: 'team-a',
        notes: 'Nota privada atualizada pelo coach.',
        updatedBy: 'coachA',
        updatedAt: serverTimestamp(),
      })
    );
    // Campo internalNotes é estritamente proibido na coleção applications
    await assertFails(
      updateDoc(doc(coachADb, 'applications', 'vac-open_candidate1'), {
        stage: 'em_analise',
        internalNotes: 'Tentativa indevida no doc público ao candidato',
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(coachADb, 'applications', 'vac-open_candidate1'), {
        stage: 'em_analise',
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(coachADb, 'attendance', 'tr-a1_player1'), {
        coachVerifiedStatus: 'justified',
        verifiedBy: 'coachA',
        updatedAt: serverTimestamp(),
      })
    );
    // Treinador NÃO pode criar treino em outra equipe nem alterar teams / teamMemberships
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
    await assertFails(
      updateDoc(doc(coachADb, 'teams', 'team-a'), {
        name: 'Hackeado pelo Coach',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(coachADb, 'teamMemberships', 'team-a_player1'), {
        status: 'transferred',
        endedAt: serverTimestamp(),
      })
    );

    // =========================================================================
    // 6. Gestor de Equipe (gerencia própria equipe e notas privadas; elenco exige backend)
    // =========================================================================
    await assertFails(getDoc(doc(managerADb, 'systemSettings', 'global')));
    await assertSucceeds(
      getDocs(query(collection(managerADb, 'applications'), where('teamId', 'in', ['team-a'])))
    );
    await assertSucceeds(
      getDocs(query(collection(managerADb, 'applicationNotes'), where('teamId', 'in', ['team-a'])))
    );
    await assertSucceeds(
      setDoc(doc(managerADb, 'applicationNotes', 'vac-open_candidate1'), {
        applicationId: 'vac-open_candidate1',
        teamId: 'team-a',
        notes: 'Nota privada revisada pelo gestor.',
        updatedBy: 'managerA',
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(managerADb, 'teams', 'team-a'), {
        name: 'NXF Alpha Atualizado',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(managerADb, 'teams', 'team-secret'), {
        name: 'Acesso indevido',
        updatedAt: serverTimestamp(),
      })
    );
    // Escrita direta em teamMemberships bloqueada no cliente (exige rota segura do backend para sincronizar users.teamIds)
    await assertFails(
      updateDoc(doc(managerADb, 'teamMemberships', 'team-a_player1'), {
        status: 'transferred',
        endedAt: serverTimestamp(),
      })
    );

    // =========================================================================
    // 7. Administradores Delegados (separação estrita por permissão)
    // =========================================================================
    // Delegado CMS lê systemSettings e gerencia notícias, mas NÃO lê users/auditLogs/admins nem resolve tickets
    await assertSucceeds(getDoc(doc(delegatedCmsDb, 'systemSettings', 'global')));
    await assertSucceeds(getDoc(doc(delegatedCmsDb, 'news', 'news-draft')));
    await assertSucceeds(
      updateDoc(doc(delegatedCmsDb, 'news', 'news-draft'), {
        title: 'Rascunho Editado pelo CMS',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(getDocs(collection(delegatedCmsDb, 'users')));
    await assertFails(getDocs(collection(delegatedCmsDb, 'auditLogs')));
    await assertFails(getDocs(collection(delegatedCmsDb, 'admins')));
    await assertFails(getDoc(doc(delegatedCmsDb, 'applicationNotes', 'vac-open_candidate1')));
    await assertFails(
      updateDoc(doc(delegatedCmsDb, 'supportTickets', 'tk-1'), {
        status: 'resolvido',
        updatedAt: serverTimestamp(),
      })
    );

    // Delegado Sistema lê auditLogs e resolve tickets, mas NÃO edita news nem lê lista de admins
    await assertSucceeds(getDoc(doc(delegatedSysDb, 'systemSettings', 'global')));
    await assertSucceeds(getDocs(collection(delegatedSysDb, 'auditLogs')));
    await assertSucceeds(
      updateDoc(doc(delegatedSysDb, 'supportTickets', 'tk-1'), {
        status: 'resolvido',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(getDocs(collection(delegatedSysDb, 'admins')));
    await assertFails(
      updateDoc(doc(delegatedSysDb, 'news', 'news-draft'), {
        title: 'Sem permissão CMS',
        updatedAt: serverTimestamp(),
      })
    );

    // =========================================================================
    // 8. Administrador Principal (leitura global + bloqueio de escritas exclusivas do backend)
    // =========================================================================
    await assertSucceeds(getDoc(doc(primaryDb, 'systemSettings', 'global')));
    await assertSucceeds(getDocs(collection(primaryDb, 'auditLogs')));
    await assertSucceeds(getDocs(collection(primaryDb, 'users')));
    await assertSucceeds(getDocs(collection(primaryDb, 'admins')));
    await assertSucceeds(getDocs(collection(primaryDb, 'applicationNotes')));

    // Escritas exclusivas do Backend Admin SDK permanecem bloqueadas no client mesmo para primary_admin
    await assertFails(setDoc(doc(primaryDb, 'systemSettings', 'global'), { primaryAdminCount: 99 }));
    await assertFails(setDoc(doc(primaryDb, 'playerStats', 'player1'), { trophies: 99999 }));
    await assertFails(deleteDoc(doc(primaryDb, 'auditLogs', 'log1')));
    await assertFails(
      updateDoc(doc(primaryDb, 'teamMemberships', 'team-a_player1'), {
        status: 'transferred',
        endedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(primaryDb, 'applications', 'vac-open_candidate1'), {
        internalNotes: 'Campo banido mesmo para primary_admin',
        updatedAt: serverTimestamp(),
      })
    );
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

    // =========================================================================
    // 9. Novas coleções competitivas (Brawl Intelligence & Match Tracker) e trava de fase
    // =========================================================================
    // playerAnalytics: leitura pública; escrita bloqueada no client mesmo para primary_admin
    await assertSucceeds(getDoc(doc(anonDb, 'playerAnalytics', 'player1')));
    await assertSucceeds(getDoc(doc(candDb, 'playerAnalytics', 'player1')));
    await assertFails(setDoc(doc(primaryDb, 'playerAnalytics', 'player1'), { winRate: 100 }));

    // teamAnalytics & brawlBattles: apenas membros oficiais ativos; negado a visitantes e candidatos; escrita bloqueada
    await assertFails(getDoc(doc(anonDb, 'teamAnalytics', 'team-a')));
    await assertFails(getDoc(doc(candDb, 'teamAnalytics', 'team-a')));
    await assertSucceeds(getDoc(doc(playerDb, 'teamAnalytics', 'team-a')));
    await assertFails(setDoc(doc(primaryDb, 'teamAnalytics', 'team-a'), { winRate: 100 }));

    await assertFails(getDoc(doc(anonDb, 'brawlBattles', 'b_sample001')));
    await assertFails(getDoc(doc(candDb, 'brawlBattles', 'b_sample001')));
    await assertSucceeds(getDoc(doc(playerDb, 'brawlBattles', 'b_sample001')));
    await assertFails(setDoc(doc(primaryDb, 'brawlBattles', 'b_sample001'), { hacked: true }));

    // matchTrackerCandidates: restrito a gestores competitivos/admins; negado a visitante/candidato/jogador; escrita bloqueada
    await assertFails(getDoc(doc(anonDb, 'matchTrackerCandidates', 'cand_sample001')));
    await assertFails(getDoc(doc(candDb, 'matchTrackerCandidates', 'cand_sample001')));
    await assertFails(getDoc(doc(playerDb, 'matchTrackerCandidates', 'cand_sample001')));
    await assertSucceeds(getDoc(doc(primaryDb, 'matchTrackerCandidates', 'cand_sample001')));
    await assertFails(
      updateDoc(doc(primaryDb, 'matchTrackerCandidates', 'cand_sample001'), { status: 'approved' })
    );

    // brawlSyncLogs: restrito a admins/sistema/competitivo; negado a visitante/candidato/jogador; escrita bloqueada
    await assertFails(getDoc(doc(anonDb, 'brawlSyncLogs', 'log_sample001')));
    await assertFails(getDoc(doc(playerDb, 'brawlSyncLogs', 'log_sample001')));
    await assertSucceeds(getDoc(doc(delegatedSysDb, 'brawlSyncLogs', 'log_sample001')));
    await assertSucceeds(getDoc(doc(primaryDb, 'brawlSyncLogs', 'log_sample001')));
    await assertFails(setDoc(doc(primaryDb, 'brawlSyncLogs', 'log_sample001'), { status: 'tampered' }));

    // Partida pertencente a fase encerrada e travada (locked == true): alteração bloqueada mesmo para primary_admin
    await assertFails(
      updateDoc(doc(primaryDb, 'matches', 'match-locked'), {
        nxfScore: 0,
        opponentScore: 2,
        updatedAt: serverTimestamp(),
      })
    );

    console.log('Todos os testes de regras do Firestore (7 perfis + coleções competitivas) passaram com sucesso.');
  } finally {
    await testEnv.cleanup();
  }
}

run().catch((err) => {
  console.error('Falha nos testes de regras do Firestore:', err);
  process.exit(1);
});

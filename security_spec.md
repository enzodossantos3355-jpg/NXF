# NXF eSports — Especificação de Segurança (Fase 0: Payload-First Security TDD)

## 1. Invariantes de Dados e Isolamento
1. **Isolamento de PII**: Dados sensíveis (`email`, `roles`, `delegatedPermissions`, `authProviders`) residem exclusivamente em `users/{userId}` e `admins/{userId}`, nunca em `publicProfiles/{profileId}`.
2. **Prevenção de Auto-Promoção**: Um usuário criando `users/{userId}` no cliente só pode registrar `roles: ['candidate']` e `status: 'active'` (ou `'pending_verification'`); a criação ou promoção em `admins/{userId}` ou atribuição de cargos (`player`, `coach`, `manager`, `delegated_admin`, `primary_admin`) é estritamente bloqueada para não-administradores.
3. **Escopo de Equipe**: Gerentes (`manager`) e Técnicos (`coach`) só podem criar/editar registros competitivos (`matches`, `trainings`) ou aprovar presenças vinculados a um `teamId` onde possuam vínculo ativo em `teamMemberships/{teamId}_{uid}`.
4. **Prevenção de Candidatura Duplicada**: Candidaturas utilizam ID determinístico `{vacancyId}_{applicantUid}`, garantindo unicidade e propriedade estrita.
5. **Integridade Temporal**: Campos `createdAt` e `updatedAt` exigem igualdade estrita com `request.time` no servidor, e `createdAt`/`uid` originais são imutáveis após a criação.
6. **Bloqueio do Último Administrador Principal**: Remoção ou desativação de um administrador principal exige confirmação de que existe outro administrador principal ativo (via backend/Cloud Function ou verificação de integridade no registro) e reautenticação recente no cliente.

## 2. Os 12 Payloads Adversariais ("Dirty Dozen")
1. **Shadow Field em Perfil Público**: Enviar `isAdmin: true` ou `email: "leak@x.com"` ao atualizar `publicProfiles/{uid}`. Esperado: `PERMISSION_DENIED` via `hasOnly()`.
2. **Auto-Promoção em `users/{uid}`**: Usuário comum enviando `roles: ['primary_admin']` na criação ou atualização de `users/{uid}`. Esperado: `PERMISSION_DENIED`.
3. **Escrita Direta em `admins/{uid}`**: Usuário não-admin tentando criar `admins/{uid}` com `role: 'primary_admin'`. Esperado: `PERMISSION_DENIED`.
4. **Leitura de PII Alheio**: Usuário autenticado tentando ler `users/{otherUid}` ou listar `users`. Esperado: `PERMISSION_DENIED`.
5. **Escopo Cruzado de Equipe**: Técnico da equipe `team_a` tentando agendar treino para `team_b`. Esperado: `PERMISSION_DENIED`.
6. **Falsificação de Autor de Ticket**: Usuário A criando `supportTickets/{id}` com `requesterUid: "userB"`. Esperado: `PERMISSION_DENIED`.
7. **Saltar Etapa de Candidatura**: Candidato tentando atualizar `applications/{id}` alterando `stage` de `"recebida"` para `"aprovada"`. Esperado: `PERMISSION_DENIED`.
8. **Poisoning de ID**: Criar documento com ID > 128 caracteres ou caracteres inválidos (`../../admin`). Esperado: `PERMISSION_DENIED` via `isValidId()`.
9. **Spoofing de Timestamp**: Criar ou editar documento passando `createdAt` retroativo em vez de `request.time`. Esperado: `PERMISSION_DENIED`.
10. **Payload Gigante (Denial of Wallet)**: Inserir `bio` com 50.000 caracteres em `publicProfiles/{uid}`. Esperado: `PERMISSION_DENIED` via `.size() <= 500`.
11. **Modificação de `auditLogs`**: Qualquer usuário (mesmo admin) tentando editar ou excluir um registro em `auditLogs/{id}`. Esperado: `PERMISSION_DENIED` (logs imutáveis).
12. **Escrita Client-Side em `playerStats`**: Jogador tentando forjar troféus em `playerStats/{uid}`. Esperado: `PERMISSION_DENIED` (exclusivo de Admin SDK / Cloud Functions).

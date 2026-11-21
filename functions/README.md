# Cloud Functions (Desativado / Migrado para Render Starter)

As Cloud Functions v2 e dependências do Firebase Blaze (`functions/src/index.ts`, `Cloud Scheduler`, `Secret Manager`) foram **removidas** deste projeto.

Toda a lógica de servidor (aceite de convites, aprovações, RBAC, notificações, auditoria, publicação agendada de notícias, uploads compatíveis com Spark e integração com a API oficial do Brawl Stars) agora executa no backend **Node.js + Express** em `/server.ts` e `/server/*`, preparado para hospedagem no **Render Starter**.

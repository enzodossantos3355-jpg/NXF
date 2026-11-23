# NXF eSports — Guia Técnico de Configuração e Implantação

Plataforma web oficial (Portal Público + Painel Privado Executivo Gamer + PWA) da organização **NXF eSports (NEXO FURY)** para Brawl Stars.

---

## 1. Arquitetura Oficial (Firebase Spark + Render)
- **Frontend SPA / PWA (Render Static Site)**: React 19, TypeScript, Vite, Tailwind CSS v4, React Router DOM, `vite-plugin-pwa`.
- **Backend API & Agendamentos (Render Starter — Node.js 22 + Express)**:
  - Autenticação por **Firebase ID Token** + RBAC no servidor via **Firebase Admin SDK**.
  - Provisionamento seguro do primeiro Administrador Principal (`POST /api/admin/bootstrap`), gestão de cargos, aprovação de Brawl Tags, rotação de credenciais, convites, notificações e exportação de auditoria JSON.
  - Integração com a **API oficial do Brawl Stars** + sincronização automática a cada **6 horas** com lock distribuído no Firestore (`systemJobs/brawlStarsSync`).
  - Publicação automática de notícias agendadas a cada **15 minutos** (`systemJobs/publishScheduledNews`).
  - Upload e entrega de mídias compatível com **Firebase Spark** (`POST /api/uploads/profile`, `POST /api/uploads/cms`, `GET /api/media/:id`), com validação real de assinatura binária (*magic bytes*).
- **Banco e Autenticação (Firebase Spark Gratuito)**:
  - Firebase Authentication (`Email/Password` atuando exclusivamente como motor interno para **Code + Senha**, sem login Google e sem campo de e-mail visível).
  - Cloud Firestore (`firestore.rules` + `firestore.indexes.json`).
  - Sem dependência de Firebase Blaze, Cloud Functions, Cloud Scheduler, Secret Manager ou Cloud NAT.

---

## 2. Pré-requisitos do Firebase (Plano Spark)
1. Abrir o projeto dedicado da NXF eSports no [Firebase Console](https://console.firebase.google.com/).
2. **Aplicativo Web (`</>`)**:
   - Em *Configurações do projeto → Seus aplicativos*, registrar um aplicativo Web para obter `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId` e `appId`.
3. **Authentication**:
   - Ativar provedor **E-mail/Senha** (*Authentication → Sign-in method → Email/Password*).
   - Adicionar o domínio do Static Site (ex.: `nxf-esports.onrender.com`) em *Authentication → Settings → Authorized domains*.
4. **Cloud Firestore**:
   - Criar o banco em modo de produção (banco padrão `(default)` no plano Spark).
   - Quando autorizado, implantar `firestore.rules` e `firestore.indexes.json` no novo projeto.
5. **Firebase Storage (Opcional / Não necessário no Spark)**:
   - Projetos novos no plano Spark não precisam ativar bucket no Storage: o upload de avatares, banners e mídias do CMS funciona integralmente via backend Express (`/api/uploads/*`).
   - Se o projeto possuir bucket ativo futuramente, implante também `storage.rules`.

---

## 3. Provisionamento Seguro do Primeiro Administrador Principal
Nenhuma senha administrativa padrão existe no código. Escolha um dos dois caminhos seguros pelo servidor:

### Opção A — Pela interface `/entrar` usando segredo do servidor Render
1. Defina `BOOTSTRAP_ADMIN_SECRET` (mínimo 12 caracteres aleatórios) nas variáveis do serviço **Render Starter**.
2. Acesse `/entrar` e clique em **Configurar primeiro administrador**.
3. Informe o segredo do servidor, Nome Completo, Nick, Code e Senha (mín. 8 caracteres).
4. O backend verifica a chave com comparação em tempo constante (`timingSafeEqual`), bloqueia automaticamente qualquer segundo bootstrap quando já existir `primary_admin` ativo e grava Custom Claims + `/admins/{uid}` + `/users/{uid}`.
5. **Recomendado**: remova `BOOTSTRAP_ADMIN_SECRET` do painel do Render após concluir o bootstrap.

### Opção B — Via script CLI (`scripts/bootstrap-admin.mjs`)
```bash
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
export FIREBASE_FIRESTORE_DATABASE_ID="(default)"
node scripts/bootstrap-admin.mjs --code "#NXF001" --name "Nome Completo" --nick "FounderNXF"
```

---

## 4. API do Brawl Stars e Problema de IP da Supercell no Render Starter
A API oficial da Supercell (`https://api.brawlstars.com/v1`) exige que o IP público de origem esteja autorizado na chave da API. Como o **Render Starter** utiliza IPs dinâmicos compartilhados:

1. **Comportamento honesto do sistema**:
   - Se a Supercell responder `HTTP 403 (accessDenied.invalidIp)`, o backend registra o diagnóstico exato em `systemJobs/brawlStarsSync` e mantém `brawlApiConfigured = false` (Configuração pendente).
   - O painel **NXF System** inclui o botão **Testar Tag na API** (`POST /api/brawl/test-tag`) e o card **Sincronização Brawl Stars** (`POST /api/brawl/sync`) com exibição clara de token, status HTTP e erro.
2. **Como resolver o IP de origem com Render Starter**:
   - **Alternativa recomendada (sem sair do Render Starter)**: configurar um add-on ou micro-relay HTTP(S) de IP estático (ex.: QuotaGuard Static / Fixie / pequeno VPS Nginx reverso com IP fixo autorizado na Supercell) e definir `BRAWL_STARS_API_BASE_URL` no Render Starter apontando para esse relay.
   - Alternativamente, atualizar futuramente o plano de saída para serviço com egress IP estático e cadastrar o IP fixo no portal `developer.brawlstars.com`.

---

## 5. Implantação no Render (Dois Serviços)

### Serviço 1 — Backend API (`nxf-esports-api` — Render Starter)
- **Runtime**: Node (`npm ci` / `npm start`, executa `node server.ts` no Node 22+)
- **Health Check**: `/api/health`
- **Variáveis obrigatórias**:
  - `NODE_ENV=production`
  - `FIREBASE_PROJECT_ID` (ID do projeto no Firebase Console)
  - `FIREBASE_FIRESTORE_DATABASE_ID=(default)`
  - `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON ou Base64 da Service Account do novo projeto Firebase)
  - `FIREBASE_WEB_API_KEY` (Web API Key do aplicativo Web do novo projeto Firebase — usada em `/api/auth/login-profile`)
  - `ALLOWED_ORIGINS` (URL exata do Static Site, ex.: `https://nxf-esports.onrender.com`)
  - `PUBLIC_API_URL` (URL pública desta API, ex.: `https://nxf-esports-api.onrender.com`)
  - `BOOTSTRAP_ADMIN_SECRET` (apenas até concluir o 1º admin)
  - `BRAWL_STARS_API_TOKEN` (exclusivo do backend)
  - `BRAWL_STARS_API_BASE_URL` (padrão `https://api.brawlstars.com/v1` ou URL do relay de IP fixo)

### Serviço 2 — Frontend Static Site (`nxf-esports`)
- **Build Command**: `npm ci && npm run build`
- **Publish Directory**: `dist`
- **Rewrite**: `/* -> /index.html` (`public/_redirects` + `render.yaml`)
- **Variáveis obrigatórias**:
  - `VITE_API_BASE_URL` (URL do backend Render Starter, ex.: `https://nxf-esports-api.onrender.com`)
  - `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_FIRESTORE_DATABASE_ID`, `VITE_APP_URL`

---

## 6. Testes Locais e Validação
```bash
# 1. Desenvolvimento local unificado (Express + Vite + /api)
npm run dev

# 2. Typecheck e Build de produção
npm run lint
npm run build

# 3. Testes unitários/integração do backend Express + Brawl API + Uploads
npm run test:api

# 4. Análise estática ESLint das regras do Firestore
npx eslint firestore.rules

# 5. Suíte de testes das regras no Firestore Emulator (requer Java 11+)
npm run test:rules
```

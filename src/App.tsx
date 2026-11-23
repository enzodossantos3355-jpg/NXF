import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoadingSkeleton } from './components/common/StateViews';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SiteProvider } from './context/SiteContext';
import { PrivateLayout } from './layouts/PrivateLayout';
import { PublicLayout } from './layouts/PublicLayout';
import { isFirebaseConfigured, missingFirebaseEnvVars } from './lib/firebase';

import { AboutPage } from './pages/public/AboutPage';
import { CandidatePortalPage } from './pages/public/CandidatePortalPage';
import { CompetitivePage } from './pages/public/CompetitivePage';
import { EntryPage } from './pages/public/EntryPage';
import { HomePage } from './pages/public/HomePage';
import { InstallAppPage } from './pages/public/InstallAppPage';
import { MemberProfilePage } from './pages/public/MemberProfilePage';
import { NewsDetailPage, NewsPage } from './pages/public/NewsPage';
import { RecruitmentPage } from './pages/public/RecruitmentPage';
import { TeamDetailPage } from './pages/public/TeamDetailPage';
import { TeamsPage } from './pages/public/TeamsPage';

import { CompetitiveAdminPage } from './pages/private/CompetitiveAdminPage';
import { DashboardPage } from './pages/private/DashboardPage';
import { NotificationsPage } from './pages/private/NotificationsPage';
import { OrganizationPage } from './pages/private/OrganizationPage';
import { ProfileSettingsPage } from './pages/private/ProfileSettingsPage';
import { RecruitmentAdminPage } from './pages/private/RecruitmentAdminPage';
import { StudioCmsPage } from './pages/private/StudioCmsPage';
import { SystemAdminPage } from './pages/private/SystemAdminPage';
import { TrainingsPage } from './pages/private/TrainingsPage';

function FirebaseConfigMissingShell() {
  return (
    <div className="min-h-screen bg-[#0D0D10] text-white flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-[#141419] border border-white/10 rounded-xl p-6 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-[#EF3340]">
          NXF eSports — Configuração Pendente
        </p>
        <h1 className="font-display text-2xl font-bold text-white">
          Firebase não configurado neste ambiente
        </h1>
        <p className="text-sm text-[#A1A1AA] leading-relaxed">
          Defina as variáveis de ambiente públicas do novo projeto Firebase no Render (Static Site) ou no arquivo <code className="text-white">.env</code> local e realize um novo build.
        </p>
        <div className="bg-[#0D0D10] border border-white/8 rounded-lg p-3 space-y-1">
          <p className="text-xs font-semibold text-[#D4D4D8]">Variáveis ausentes:</p>
          <ul className="text-xs font-mono text-[#EF3340] space-y-0.5">
            {missingFirebaseEnvVars.map((envName) => (
              <li key={envName}>{envName}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function AuthLoadingShell() {
  return (
    <div className="min-h-screen bg-[#0D0D10] p-8 max-w-4xl mx-auto">
      <LoadingSkeleton rows={4} />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { firebaseUser, authReady, profileDocsReady } = useAuth();
  if (!authReady || (firebaseUser && !profileDocsReady)) {
    return <AuthLoadingShell />;
  }
  if (!firebaseUser) {
    return <Navigate to="/entrar" replace />;
  }
  return <>{children}</>;
}

function OfficialMemberRoute({ children }: { children: React.ReactNode }) {
  const { firebaseUser, authReady, profileDocsReady, capabilities } = useAuth();
  if (!authReady || (firebaseUser && !profileDocsReady)) {
    return <AuthLoadingShell />;
  }
  if (!firebaseUser) {
    return <Navigate to="/entrar" replace />;
  }
  if (!capabilities.isOfficialMember) {
    return <Navigate to="/minha-conta" replace />;
  }
  return <>{children}</>;
}

function CmsRoute({ children }: { children: React.ReactNode }) {
  const { capabilities } = useAuth();
  if (!capabilities.canManageCms) {
    return <Navigate to="/painel" replace />;
  }
  return <>{children}</>;
}

function SystemRoute({ children }: { children: React.ReactNode }) {
  const { capabilities } = useAuth();
  if (!capabilities.canAccessSystem && !capabilities.isAnyAdmin) {
    return <Navigate to="/painel" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  if (!isFirebaseConfigured) {
    return <FirebaseConfigMissingShell />;
  }

  return (
    <ErrorBoundary>
      <AuthProvider>
        <SiteProvider>
          <BrowserRouter>
            <Routes>
              {/* Portal Público */}
              <Route element={<PublicLayout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/equipes" element={<TeamsPage />} />
                <Route path="/equipes/:teamId" element={<TeamDetailPage />} />
                <Route path="/competitivo" element={<CompetitivePage />} />
                <Route path="/noticias" element={<NewsPage />} />
                <Route path="/noticias/:slug" element={<NewsDetailPage />} />
                <Route path="/recrutamento" element={<RecruitmentPage />} />
                <Route path="/sobre" element={<AboutPage />} />
                <Route path="/instalar" element={<InstallAppPage />} />
                <Route path="/entrar" element={<EntryPage />} />
                <Route path="/membro/:profileId" element={<MemberProfilePage />} />
                <Route
                  path="/minha-conta"
                  element={
                    <ProtectedRoute>
                      <CandidatePortalPage />
                    </ProtectedRoute>
                  }
                />
              </Route>

              {/* Painel Privado — Exclusivo para Membros Oficiais e Administração */}
              <Route
                path="/painel"
                element={
                  <OfficialMemberRoute>
                    <PrivateLayout />
                  </OfficialMemberRoute>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path="perfil" element={<ProfileSettingsPage />} />
                <Route path="organizacao" element={<OrganizationPage />} />
                <Route path="competitivo" element={<CompetitiveAdminPage />} />
                <Route path="treinamentos" element={<TrainingsPage />} />
                <Route path="recrutamento" element={<RecruitmentAdminPage />} />
                <Route path="notificacoes" element={<NotificationsPage />} />
                <Route
                  path="studio"
                  element={
                    <CmsRoute>
                      <StudioCmsPage />
                    </CmsRoute>
                  }
                />
                <Route
                  path="system"
                  element={
                    <SystemRoute>
                      <SystemAdminPage />
                    </SystemRoute>
                  }
                />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </SiteProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

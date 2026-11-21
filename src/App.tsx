import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoadingSkeleton } from './components/common/StateViews';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SiteProvider } from './context/SiteContext';
import { PrivateLayout } from './layouts/PrivateLayout';
import { PublicLayout } from './layouts/PublicLayout';

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

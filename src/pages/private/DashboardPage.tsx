import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  CalendarClock,
  Palette,
  Settings,
  ShieldCheck,
  Trophy,
  UserCheck,
  Users,
} from 'lucide-react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { ROLE_LABELS } from '../../lib/permissions';
import { PendingConfigNotice } from '../../components/common/StateViews';

export function DashboardPage() {
  const { firebaseUser, userDoc, capabilities, systemSettings } = useAuth();
  const [counts, setCounts] = useState({
    teams: 0,
    matches: 0,
    vacancies: 0,
    notifications: 0,
  });

  useEffect(() => {
    if (!firebaseUser) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(query(collection(db, 'teams'), limit(50)), (s) =>
        setCounts((c) => ({ ...c, teams: s.size }))
      , () => {})
    );
    unsubs.push(
      onSnapshot(
        query(collection(db, 'matches'), where('status', '==', 'scheduled'), limit(50)),
        (s) => setCounts((c) => ({ ...c, matches: s.size })),
        () => {}
      )
    );
    unsubs.push(
      onSnapshot(
        query(collection(db, 'vacancies'), where('status', '==', 'open'), limit(50)),
        (s) => setCounts((c) => ({ ...c, vacancies: s.size })),
        () => {}
      )
    );
    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'notifications'),
          where('recipientUid', '==', firebaseUser.uid),
          where('read', '==', false),
          limit(50)
        ),
        (s) => setCounts((c) => ({ ...c, notifications: s.size })),
        () => {}
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [firebaseUser]);

  // Painel FIXO sem personalização de ordem ou duplicação de cartões em contas multi-cargo
  const cards = [
    {
      id: 'profile',
      visible: true,
      title: 'Meu Perfil e Visibilidade',
      metric: userDoc?.brawlTagStatus === 'approved' ? userDoc.brawlTag || 'Tag aprovada' : 'Configuração pessoal',
      description: 'Edite avatar, banner, bio, layout público e solicitação de Tag Brawl Stars.',
      to: '/painel/perfil',
      icon: ShieldCheck,
    },
    {
      id: 'org',
      visible: capabilities.isOfficialMember,
      title: 'Equipes e Elencos',
      metric: `${counts.teams} equipes`,
      description: 'Divisões ativas, titulares, reservas, comissão técnica e convites individuais.',
      to: '/painel/organizacao',
      icon: Users,
    },
    {
      id: 'competitive',
      visible: capabilities.isOfficialMember,
      title: 'Agenda Competitiva',
      metric: `${counts.matches} agendadas`,
      description: 'Campeonatos, confrontos MD3/MD5/MD7, mapas e placares oficiais.',
      to: '/painel/competitivo',
      icon: Trophy,
    },
    {
      id: 'trainings',
      visible: capabilities.isOfficialMember,
      title: 'Treinamentos e Presença',
      metric: 'Rotina de equipe',
      description: 'Confirmação de presença, justificativas e registro real pelo técnico.',
      to: '/painel/treinamentos',
      icon: CalendarClock,
    },
    {
      id: 'recruitment',
      visible: true,
      title: 'Recrutamento',
      metric: `${counts.vacancies} vagas abertas`,
      description: capabilities.canManageRecruitment
        ? 'Gerencie vagas e candidatos em visualização Tabela ou Kanban.'
        : 'Acompanhe o status das suas candidaturas enviadas.',
      to: '/painel/recrutamento',
      icon: UserCheck,
    },
    {
      id: 'notifications',
      visible: true,
      title: 'Notificações do Sistema',
      metric: `${counts.notifications} não lidas`,
      description: 'Alertas operacionais, preferências de push e segmentação por equipe.',
      to: '/painel/notificacoes',
      icon: Bell,
    },
    {
      id: 'studio',
      visible: capabilities.canManageCms,
      title: 'NXF Studio (CMS)',
      metric: 'Portal público',
      description: 'Edite banners desktop/mobile, notícias, patrocinadores e seções da Home.',
      to: '/painel/studio',
      icon: Palette,
    },
    {
      id: 'system',
      visible: capabilities.canAccessSystem || capabilities.isAnyAdmin,
      title: 'NXF System e Suporte',
      metric: 'Governança',
      description: 'Cargos, auditoria, diagnósticos, exportação, backup e suporte técnico.',
      to: '/painel/system',
      icon: Settings,
    },
  ].filter((c) => c.visible);

  return (
    <div className="space-y-6">
      <div className="border-b border-white/8 pb-4 space-y-1">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Painel Executivo Gamer
        </p>
        <h1 className="font-display text-3xl font-bold text-white">
          Visão Geral da Conta
        </h1>
        <p className="text-xs text-[#A1A1AA]">
          Cargos acumulados:{' '}
          <span className="text-white font-medium">
            {capabilities.roles.map((r) => ROLE_LABELS[r]).join(' · ')}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="bg-[#15151A] hover:bg-[#202027] border border-white/8 hover:border-[#DC172B]/60 rounded-lg p-5 flex flex-col justify-between gap-4 transition-colors"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Icon className="w-5 h-5 text-[#EF3340]" />
                  <span className="font-mono-tabular text-xs text-[#A1A1AA]">
                    {card.metric}
                  </span>
                </div>
                <h2 className="text-base font-bold text-white">{card.title}</h2>
                <p className="text-xs text-[#A1A1AA] leading-relaxed">
                  {card.description}
                </p>
              </div>
              <span className="text-xs font-semibold text-white">Abrir módulo →</span>
            </Link>
          );
        })}
      </div>

      {capabilities.isAnyAdmin && !systemSettings?.brawlApiConfigured && (
        <PendingConfigNotice
          title="Integração Oficial Brawl Stars (Render Backend)"
          description="A sincronização periódica de playerStats a cada 6 horas opera no backend Node.js + Express hospedado no Render Starter, exigindo token e IP autorizado na Supercell."
          requirements={[
            'Definir BRAWL_STARS_API_TOKEN nas variáveis de ambiente do Render Starter.',
            'Autorizar o IP de saída (ou configurar relay/proxy de IP fixo em BRAWL_STARS_API_BASE_URL) no portal da Supercell.',
            'Validar a conexão em NXF System usando o botão Testar API com uma Brawl Tag real.',
          ]}
        />
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { SafeImage } from '../../components/common/BrandMark';
import type { Team } from '../../types/nxf';

export function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'teams'), where('isPublic', '==', true)),
      (snap) => {
        setTeams(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div className="border-b border-white/8 pb-5 space-y-1.5">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Divisões Competitivas
        </p>
        <h1 className="font-display text-4xl font-bold text-white">Equipes NXF eSports</h1>
        <p className="text-sm text-[#A1A1AA]">
          Elencos ativos, comissão técnica, calendário e histórico competitivo de cada divisão oficial.
        </p>
      </div>

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : teams.length === 0 ? (
        <EmptyState
          title="Nenhuma equipe pública registrada"
          description="As equipes serão exibidas automaticamente assim que forem criadas e publicadas no módulo Organização."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {teams.map((team) => (
            <Link
              key={team.id}
              to={`/equipes/${team.id}`}
              className="bg-[#15151A] border border-white/8 hover:border-[#DC172B]/60 rounded-lg overflow-hidden transition-colors"
            >
              <SafeImage
                src={team.bannerUrl || team.logoUrl}
                alt={team.name}
                className="h-44 w-full object-cover"
                fallbackLabel={team.name}
              />
              <div className="p-5 space-y-2">
                <p className="text-xs font-medium text-[#EF3340]">{team.category}</p>
                <h2 className="text-xl font-bold text-white">{team.name}</h2>
                {team.description && (
                  <p className="text-xs text-[#A1A1AA] line-clamp-3">{team.description}</p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

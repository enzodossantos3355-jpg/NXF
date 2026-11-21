import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Send } from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { BLUEPRINT_LIMITS, type Application, type Vacancy } from '../../types/nxf';

const STAGE_LABELS: Record<Application['stage'], string> = {
  recebida: 'Recebida',
  em_analise: 'Em análise',
  em_teste: 'Em teste',
  aprovada: 'Aprovada',
  rejeitada: 'Não selecionada',
};

export function RecruitmentPage() {
  const { firebaseUser, userDoc } = useAuth();
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [myApplications, setMyApplications] = useState<Record<string, Application>>({});
  const [loading, setLoading] = useState(true);

  const [activeVacancy, setActiveVacancy] = useState<Vacancy | null>(null);
  const [brawlTag, setBrawlTag] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    const unsub = onSnapshot(
      query(
        collection(db, 'vacancies'),
        where('status', '==', 'open'),
        orderBy('createdAt', 'desc')
      ),
      (snap) => {
        setVacancies(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Vacancy, 'id'>) }))
        );
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!firebaseUser) {
      setMyApplications({});
      return;
    }

    const unsub = onSnapshot(
      query(
        collection(db, 'applications'),
        where('applicantUid', '==', firebaseUser.uid)
      ),
      (snap) => {
        const map: Record<string, Application> = {};
        snap.docs.forEach((d) => {
          const data = { id: d.id, ...(d.data() as Omit<Application, 'id'>) };
          map[data.vacancyId] = data;
        });
        setMyApplications(map);
      },
      () => {}
    );
    return () => unsub();
  }, [firebaseUser]);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !activeVacancy) return;

    const appId = `${activeVacancy.id}_${firebaseUser.uid}`;
    if (myApplications[activeVacancy.id]) {
      setFeedback('Você já possui uma inscrição enviada para esta vaga.');
      return;
    }

    setSubmitting(true);
    setFeedback('');
    try {
      await setDoc(doc(db, 'applications', appId), {
        vacancyId: activeVacancy.id,
        teamId: activeVacancy.teamId,
        applicantUid: firebaseUser.uid,
        applicantName: (userDoc?.displayName || firebaseUser.displayName || 'Candidato').slice(
          0,
          BLUEPRINT_LIMITS.DISPLAY_NAME_MAX
        ),
        brawlTag: brawlTag.trim().toUpperCase().slice(0, BLUEPRINT_LIMITS.BRAWL_TAG_MAX),
        answers,
        stage: 'recebida',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setActiveVacancy(null);
      setBrawlTag('');
      setAnswers({});
      setFeedback('Candidatura registrada com sucesso. Acompanhe o status abaixo.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `applications/${appId}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div className="border-b border-white/8 pb-5 space-y-1.5">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Seletiva NXF eSports
        </p>
        <h1 className="font-display text-4xl font-bold text-white">Recrutamento</h1>
        <p className="text-sm text-[#A1A1AA] max-w-2xl">
          Vagas abertas por divisão. Os dados de candidatura são privados e visíveis apenas para você e para a comissão responsável pela equipe.
        </p>
      </div>

      {feedback && (
        <div className="p-4 bg-[#15151A] border border-[#DC172B]/50 rounded-md text-sm text-white">
          {feedback}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : vacancies.length === 0 ? (
        <EmptyState
          title="Nenhuma vaga aberta no momento"
          description="Novas seletivas para jogadores, analistas ou comissão técnica serão publicadas nesta página."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {vacancies.map((v) => {
            const existingApp = myApplications[v.id];
            return (
              <div
                key={v.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-6 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <p className="text-xs text-[#EF3340] font-medium">
                    {v.teamName} · {v.roleTarget}
                    {v.deadline ? ` · Prazo: ${formatFirestoreDate(v.deadline)}` : ''}
                  </p>
                  <h2 className="text-xl font-bold text-white">{v.title}</h2>
                  {v.requirements && (
                    <p className="text-sm text-[#A1A1AA] whitespace-pre-line">
                      {v.requirements}
                    </p>
                  )}
                </div>

                {existingApp ? (
                  <div className="pt-3 border-t border-white/8 flex items-center justify-between text-xs">
                    <span className="inline-flex items-center gap-1.5 text-white font-semibold">
                      <CheckCircle2 className="w-4 h-4 text-[#EF3340]" />
                      Inscrição enviada
                    </span>
                    <span className="text-[#A1A1AA]">
                      Etapa atual: <strong className="text-white">{STAGE_LABELS[existingApp.stage]}</strong>
                    </span>
                  </div>
                ) : firebaseUser ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveVacancy(v);
                      setBrawlTag(userDoc?.brawlTag || userDoc?.code || '');
                      setFeedback('');
                    }}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Inscrever-se nesta vaga
                  </button>
                ) : (
                  <Link
                    to="/entrar"
                    className="inline-flex items-center justify-center px-4 py-2.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-white text-xs font-semibold rounded-md transition-colors"
                  >
                    Entre ou crie uma conta básica para se inscrever
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de candidatura */}
      {activeVacancy && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={handleApply}
            className="w-full max-w-lg bg-[#15151A] border border-white/12 rounded-lg p-6 space-y-4"
          >
            <div>
              <p className="text-xs text-[#EF3340] font-medium">
                {activeVacancy.teamName} · {activeVacancy.roleTarget}
              </p>
              <h2 className="text-xl font-bold text-white">{activeVacancy.title}</h2>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#A1A1AA]">
                Tag no Brawl Stars (opcional)
              </label>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.BRAWL_TAG_MAX}
                value={brawlTag}
                onChange={(e) => setBrawlTag(e.target.value)}
                placeholder="#EXEMPLO99"
                className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm font-mono-tabular text-white focus:border-[#DC172B] focus:outline-none"
              />
            </div>

            {(activeVacancy.customFields && activeVacancy.customFields.length > 0
              ? activeVacancy.customFields
              : ['Disponibilidade de horários', 'Experiência competitiva anterior']
            ).map((fieldLabel) => (
              <div key={fieldLabel} className="space-y-1.5">
                <label className="block text-xs font-medium text-[#A1A1AA]">
                  {fieldLabel}
                </label>
                <textarea
                  required
                  rows={2}
                  maxLength={400}
                  value={answers[fieldLabel] || ''}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [fieldLabel]: e.target.value }))
                  }
                  className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
                />
              </div>
            ))}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setActiveVacancy(null)}
                className="px-4 py-2 bg-[#202027] text-xs font-medium text-white rounded-md"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white rounded-md"
              >
                {submitting ? 'Enviando...' : 'Enviar candidatura'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

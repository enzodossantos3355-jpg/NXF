import React, { useEffect, useState } from 'react';
import { Bell, CheckCheck, Send } from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState } from '../../components/common/StateViews';
import type { NotificationItem } from '../../types/nxf';

export function NotificationsPage() {
  const { firebaseUser, capabilities } = useAuth();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [pushEnabled, setPushEnabled] = useState(false);

  const [recipientUid, setRecipientUid] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!firebaseUser) return;
    const u1 = onSnapshot(
      query(
        collection(db, 'notifications'),
        where('recipientUid', '==', firebaseUser.uid),
        orderBy('createdAt', 'desc')
      ),
      (s) =>
        setItems(
          s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NotificationItem, 'id'>) }))
        ),
      () => {}
    );

    const u2 = onSnapshot(
      doc(db, 'notificationPreferences', firebaseUser.uid),
      (s) => {
        if (s.exists()) {
          setPushEnabled(Boolean(s.data()?.pushEnabled));
        }
      },
      () => {}
    );

    return () => {
      u1();
      u2();
    };
  }, [firebaseUser]);

  const handleTogglePush = async () => {
    if (!firebaseUser) return;
    const next = !pushEnabled;
    if (next && typeof Notification !== 'undefined') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setFeedback('Permissão de notificações do navegador não concedida.');
        return;
      }
    }
    try {
      await setDoc(
        doc(db, 'notificationPreferences', firebaseUser.uid),
        {
          uid: firebaseUser.uid,
          pushEnabled: next,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setPushEnabled(next);
      setFeedback(
        next
          ? 'Preferência de Push salva. O envio automático em segundo plano depende da chave VAPID e Cloud Messaging configurados.'
          : 'Notificações Push desativadas.'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `notificationPreferences/${firebaseUser.uid}`);
    }
  };

  const handleMarkRead = async (item: NotificationItem) => {
    if (item.read) return;
    try {
      await updateDoc(doc(db, 'notifications', item.id), { read: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `notifications/${item.id}`);
    }
  };

  const handleSendSystemNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setFeedback('');
    if (!recipientUid.trim() || !title.trim() || !body.trim()) return;
    try {
      await apiFetch('/api/notifications/send', {
        method: 'POST',
        body: {
          recipientUid: recipientUid.trim(),
          title: title.trim().slice(0, 120),
          body: body.trim().slice(0, 500),
          category: 'system',
        },
      });
      setTitle('');
      setBody('');
      setFeedback('Notificação institucional enviada pelo servidor ao destinatário.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Erro ao enviar notificação pelo servidor.'
      );
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/8 pb-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-white">Notificações do Sistema</h1>
          <p className="text-xs text-[#A1A1AA]">
            Avisos operacionais, convocações de treino e atualizações de candidatura. Esta plataforma não possui chat ou mensagens privadas entre membros.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleTogglePush()}
          className={`px-4 py-2 rounded-md text-xs font-semibold border transition-colors ${
            pushEnabled
              ? 'bg-[#DC172B] border-[#DC172B] text-white'
              : 'bg-[#15151A] border-white/10 text-[#A1A1AA] hover:text-white'
          }`}
        >
          {pushEnabled ? 'Push ativado' : 'Ativar Push (FCM)'}
        </button>
      </div>

      {feedback && (
        <div className="p-3 bg-[#15151A] border border-white/15 rounded text-xs text-white">
          {feedback}
        </div>
      )}
      {errorMsg && (
        <div className="p-3 bg-[#DC172B]/15 border border-[#DC172B]/50 rounded text-xs text-white">
          {errorMsg}
        </div>
      )}

      {(capabilities.isAnyAdmin || capabilities.isManager || capabilities.isCoach) && (
        <form
          onSubmit={handleSendSystemNotification}
          className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
        >
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Send className="w-4 h-4 text-[#EF3340]" /> Enviar Notificação Direcionada
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              required
              value={recipientUid}
              onChange={(e) => setRecipientUid(e.target.value)}
              placeholder="UID do destinatário"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs font-mono-tabular text-white"
            />
            <input
              type="text"
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Título do aviso"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
          </div>
          <textarea
            rows={2}
            required
            maxLength={500}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Conteúdo objetivo da notificação..."
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-[#202027] hover:bg-[#DC172B] text-xs font-semibold text-white rounded transition-colors"
          >
            Disparar aviso
          </button>
        </form>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Nenhuma notificação recebida"
          description="Alertas do sistema sobre treinos, candidaturas e decisões administrativas serão listados aqui."
        />
      ) : (
        <div className="space-y-3">
          {items.map((n) => (
            <div
              key={n.id}
              className={`bg-[#15151A] border rounded-lg p-4 flex items-start justify-between gap-4 ${
                n.read ? 'border-white/6 opacity-75' : 'border-[#DC172B]/60'
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
                  <Bell className="w-3.5 h-3.5 text-[#EF3340]" />
                  <span>{n.category}</span>
                  <span>·</span>
                  <span>{formatFirestoreDate(n.createdAt)}</span>
                </div>
                <h3 className="text-sm font-bold text-white">{n.title}</h3>
                <p className="text-xs text-[#A1A1AA]">{n.body}</p>
              </div>
              {!n.read && (
                <button
                  type="button"
                  onClick={() => void handleMarkRead(n)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#202027] rounded text-xs text-white shrink-0"
                >
                  <CheckCheck className="w-3.5 h-3.5" /> Lida
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

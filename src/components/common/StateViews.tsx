import React from 'react';
import { AlertCircle, Inbox, Wrench } from 'lucide-react';

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Carregando dados">
      {Array.from({ length: rows }).map((_, idx) => (
        <div
          key={idx}
          className="h-14 rounded-md bg-[#15151A] border border-white/6 animate-pulse"
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-[#15151A] border border-white/8 rounded-lg p-8 text-center flex flex-col items-center">
      <div className="w-10 h-10 rounded-md bg-[#202027] border border-white/10 flex items-center justify-center mb-3">
        <Inbox className="w-5 h-5 text-[#A1A1AA]" />
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="text-sm text-[#A1A1AA] max-w-md mt-1.5 leading-relaxed">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Não foi possível carregar os dados',
  description,
  onRetry,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div className="bg-[#15151A] border border-[#DC172B]/40 rounded-lg p-6 space-y-3">
      <div className="flex items-center gap-2.5 text-[#EF3340]">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      <p className="text-sm text-[#A1A1AA]">{description}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-medium text-white rounded-md transition-colors"
        >
          Tentar novamente
        </button>
      )}
    </div>
  );
}

export function PendingConfigNotice({
  title,
  description,
  requirements,
}: {
  title: string;
  description: string;
  requirements: string[];
}) {
  return (
    <div className="bg-[#15151A] border border-white/12 rounded-lg p-5 space-y-3">
      <div className="flex items-center gap-2.5">
        <Wrench className="w-4 h-4 text-[#EF3340] shrink-0" />
        <h4 className="text-sm font-semibold text-white">
          {title} — Configuração pendente
        </h4>
      </div>
      <p className="text-xs text-[#A1A1AA] leading-relaxed">{description}</p>
      <ul className="space-y-1 text-xs text-[#A1A1AA] list-disc list-inside">
        {requirements.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

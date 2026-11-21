import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    let friendly = error.message || 'Ocorreu uma falha inesperada na interface.';
    try {
      const parsed = JSON.parse(error.message) as {
        error?: string;
        operationType?: string;
        path?: string;
      };
      if (parsed?.error) {
        if (parsed.error.toLowerCase().includes('permission')) {
          friendly = `Acesso bloqueado pelas regras de segurança do servidor (${parsed.operationType || 'leitura'} em ${parsed.path || 'recurso protegido'}).`;
        } else {
          friendly = parsed.error;
        }
      }
    } catch {
      // erro padrão não JSON
    }
    return { hasError: true, message: friendly };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0D0D10] text-white flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#15151A] border border-white/10 rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-3 text-[#EF3340]">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h1 className="text-xl font-bold tracking-tight">
                Falha de Execução ou Permissão
              </h1>
            </div>
            <p className="text-sm text-[#A1A1AA] leading-relaxed">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.assign('/')}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#DC172B] hover:bg-[#EF3340] text-white text-sm font-semibold rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-4 h-4" />
              Voltar ao início
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

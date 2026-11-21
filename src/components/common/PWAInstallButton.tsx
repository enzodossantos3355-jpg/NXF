import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="inline-flex items-center gap-2 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="w-4 h-4 shrink-0" />
        {compact ? 'Instalar' : 'Instalar aplicativo'}
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 px-3 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-white text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <Smartphone className="w-4 h-4 shrink-0" />
          Instalar no iOS
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-install-title"
          >
            <div className="w-full max-w-sm bg-[#15151A] border border-white/10 rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 id="ios-install-title" className="text-lg font-bold">
                  Instalar no iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1.5 text-[#A1A1AA] hover:text-white rounded"
                  aria-label="Fechar instruções"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="space-y-2 text-sm text-[#A1A1AA] list-decimal list-inside">
                <li>
                  Toque no botão <strong className="text-white">Compartilhar</strong> na barra do Safari.
                </li>
                <li>
                  Role as opções e toque em{' '}
                  <strong className="text-white">Adicionar à Tela de Início</strong>.
                </li>
                <li>Confirme o nome NXF e toque em Adicionar.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2.5 bg-[#202027] hover:bg-[#2B2B35] text-white text-sm font-medium rounded-md transition-colors"
              >
                Entendi
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 md:bottom-4 left-4 z-50 flex items-center gap-2 rounded-md bg-[#202027] border border-[#DC172B] px-3 py-2 text-xs font-medium text-white shadow-lg"
    >
      <WifiOff className="w-3.5 h-3.5 text-[#EF3340] shrink-0" />
      <span>Modo offline — recursos privados exigem conexão ativa.</span>
    </div>
  );
};

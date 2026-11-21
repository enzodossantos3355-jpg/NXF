import React from 'react';
import { CheckCircle2, Globe, Monitor, Smartphone } from 'lucide-react';
import { PWAInstallButton } from '../../components/common/PWAInstallButton';
import { usePWAInstall } from '../../hooks/usePWAInstall';

export function InstallAppPage() {
  const { isInstallable, isInstalled } = usePWAInstall();

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div className="border-b border-white/8 pb-5 space-y-2">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Aplicativo Web Progressivo (PWA)
        </p>
        <h1 className="font-display text-4xl font-bold text-white">
          Instalar o aplicativo NXF eSports
        </h1>
        <p className="text-sm text-[#A1A1AA]">
          A instalação como aplicativo depende do suporte do seu navegador e sistema operacional. Quando disponível, utilize o botão direto abaixo ou siga o guia da sua plataforma.
        </p>
      </div>

      {isInstalled ? (
        <div className="bg-[#15151A] border border-white/12 rounded-lg p-6 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-[#EF3340] shrink-0" />
          <div>
            <p className="text-sm font-semibold text-white">Aplicativo já em execução</p>
            <p className="text-xs text-[#A1A1AA]">
              Você já está acessando a NXF eSports no modo aplicativo instalado.
            </p>
          </div>
        </div>
      ) : isInstallable ? (
        <div className="bg-[#15151A] border border-[#DC172B]/50 rounded-lg p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-base font-bold text-white">Instalação direta disponível</p>
            <p className="text-xs text-[#A1A1AA]">
              Seu navegador confirmou suporte ao prompt de instalação do aplicativo.
            </p>
          </div>
          <PWAInstallButton />
        </div>
      ) : (
        <div className="bg-[#15151A] border border-white/10 rounded-lg p-5 text-xs text-[#A1A1AA]">
          O prompt automático de instalação não foi disponibilizado por este navegador ou contexto atual. Siga as instruções manuais correspondentes ao seu dispositivo abaixo.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2 text-white">
            <Smartphone className="w-4 h-4 text-[#EF3340]" />
            <h2 className="text-base font-bold">Android (Chrome / Edge)</h2>
          </div>
          <ol className="space-y-2 text-xs text-[#A1A1AA] list-decimal list-inside leading-relaxed">
            <li>Abra o portal oficial no Google Chrome ou Microsoft Edge.</li>
            <li>Toque no menu de três pontos no canto superior direito.</li>
            <li>Selecione <strong className="text-white">Instalar aplicativo</strong> ou Adicionar à tela inicial.</li>
          </ol>
        </div>

        <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2 text-white">
            <Globe className="w-4 h-4 text-[#EF3340]" />
            <h2 className="text-base font-bold">iPhone e iPad (Safari)</h2>
          </div>
          <ol className="space-y-2 text-xs text-[#A1A1AA] list-decimal list-inside leading-relaxed">
            <li>Acesse pelo navegador <strong className="text-white">Safari</strong> (iOS não libera instalação em navegadores de terceiros da mesma forma).</li>
            <li>Toque no ícone <strong className="text-white">Compartilhar</strong>.</li>
            <li>Escolha <strong className="text-white">Adicionar à Tela de Início</strong> e confirme.</li>
          </ol>
        </div>

        <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2 text-white">
            <Monitor className="w-4 h-4 text-[#EF3340]" />
            <h2 className="text-base font-bold">Computador (Chrome / Edge)</h2>
          </div>
          <ol className="space-y-2 text-xs text-[#A1A1AA] list-decimal list-inside leading-relaxed">
            <li>Localize o ícone de instalação na barra de endereços do navegador.</li>
            <li>Ou abra o menu do navegador em <strong className="text-white">Salvar e compartilhar → Instalar NXF eSports</strong>.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

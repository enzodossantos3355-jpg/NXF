import React, { useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { DEFAULT_BRAND_LOGO } from '../../context/SiteContext';

export function BrandMark({
  logoUrl,
  size = 'md',
}: {
  logoUrl?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const src = logoUrl || DEFAULT_BRAND_LOGO;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const dimensions =
    size === 'sm'
      ? 'h-8 w-8'
      : size === 'lg'
        ? 'h-14 w-14'
        : 'h-9 w-9';

  if (failed || !src) {
    return (
      <div
        className={`${dimensions} rounded bg-[#202027] border border-white/10 flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <span className="font-display font-bold text-sm tracking-tight text-white">
          N<span className="text-[#DC172B]">F</span>
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="NEXO FURY [NXF]"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${dimensions} rounded object-cover bg-[#0D0D10] border border-white/10 shrink-0`}
    />
  );
}

export function SafeImage({
  src,
  alt,
  className = '',
  fallbackLabel,
}: {
  src?: string;
  alt: string;
  className?: string;
  fallbackLabel?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <div
        className={`bg-[#15151A] border border-white/8 flex flex-col items-center justify-center text-center p-4 ${className}`}
      >
        <Shield className="w-6 h-6 text-[#71717A] mb-2" />
        <span className="text-xs text-[#71717A] font-medium">
          {fallbackLabel || alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

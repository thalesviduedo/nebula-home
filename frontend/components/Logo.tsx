/**
 * Marca do Nebula Home: casa com sinal Wi-Fi, gradiente ciano → azul →
 * violeta (esquerda → direita), como no logo. SVG puro para escalar em
 * qualquer tamanho: topbar, favicon e imagens de SEO saem todos daqui.
 */
export default function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="Nebula Home"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="nb-house" x1="12" y1="54" x2="52" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.5" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="nb-wifi" x1="18" y1="42" x2="46" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>

      {/* contorno da casa com os pés abertos na base */}
      <path
        d="M 20 56 H 14 V 28 L 28.5 11 Q 32 7.6 35.5 11 L 50 28 V 56 H 44"
        fill="none"
        stroke="url(#nb-house)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* ondas do Wi-Fi + ponto (arcos concêntricos com folga entre si) */}
      <path
        d="M 19.27 31.27 A 18 18 0 0 1 44.73 31.27"
        fill="none"
        stroke="url(#nb-wifi)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M 23.16 35.16 A 12.5 12.5 0 0 1 40.84 35.16"
        fill="none"
        stroke="url(#nb-wifi)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M 27.05 39.05 A 7 7 0 0 1 36.95 39.05"
        fill="none"
        stroke="url(#nb-wifi)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="32" cy="45.4" r="3.3" fill="url(#nb-wifi)" />
    </svg>
  );
}

import type { MetadataRoute } from "next";

/** manifest.webmanifest — ícones saem das convenções app/icon.svg e app/apple-icon.png */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nebula Home — Painel local para dispositivos Tuya",
    short_name: "Nebula Home",
    description:
      "Controle Tuya por LAN ou nuvem, blaster IR, câmera P2P, cenas e energia. As chaves ficam só no navegador.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f131c",
    theme_color: "#0f131c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}

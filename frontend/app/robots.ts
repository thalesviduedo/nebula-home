import type { MetadataRoute } from "next";

/** Painel local: nada aqui precisa ser rastreado, mas a regra fica explícita. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: "http://127.0.0.1:3100/sitemap.xml",
  };
}

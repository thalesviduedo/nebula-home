import type { MetadataRoute } from "next";

/** O painel mora em 127.0.0.1:3100; o sitemap lista os módulos reais. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "http://127.0.0.1:3100";
  const now = new Date();
  const routes = ["", "/iluminacao", "/tomadas", "/ir", "/cameras", "/inventario", "/casa"];
  return routes.map((r) => ({
    url: `${base}${r}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: r === "" ? 1 : 0.6,
  }));
}

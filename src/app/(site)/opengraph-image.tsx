import { ImageResponse } from "next/og";
import { company, seo } from "@/content/lopes";

export const alt = seo.ogImageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Imagem de compartilhamento (Open Graph) gerada a partir dos dados institucionais. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #1b1716 0%, #2a2422 60%, #4a1d28 100%)",
          color: "#f6f1ea",
          fontFamily: "serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1 }}>{company.shortName}</div>
          <div style={{ marginTop: 10, fontSize: 18, letterSpacing: 8, color: "#a88655", fontFamily: "sans-serif" }}>
            COSMÉTICOS
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 60, lineHeight: 1.1, maxWidth: 940 }}>
          Tradição que conecta marcas, negócios e oportunidades.
        </div>
        <div style={{ display: "flex", fontSize: 24, color: "#c9bfb4", fontFamily: "sans-serif" }}>
          {`${company.descriptor} · ${company.yearsText} · ${company.city}, ${company.stateCode}`}
        </div>
      </div>
    ),
    size,
  );
}

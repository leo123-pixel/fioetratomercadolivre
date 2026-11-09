import { ImageResponse } from "next/og";
import { company, seo } from "@/content/lopes";

export const alt = seo.ogImageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Imagem de compartilhamento (Open Graph) com a paleta oficial: verde-petróleo e dourado. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#053839",
          color: "#f3f0ea",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 760,
            height: 760,
            borderRadius: 9999,
            border: "1px solid rgba(203,162,92,0.35)",
            display: "flex",
          }}
        />
        <div style={{ display: "flex", fontSize: 96, fontWeight: 600, letterSpacing: 24 }}>LOPES</div>
        <div style={{ display: "flex", marginTop: 8, fontSize: 22, letterSpacing: 10, color: "#cba25c" }}>
          COSMÉTICOS
        </div>
        <div style={{ display: "flex", marginTop: 40, fontSize: 18, letterSpacing: 6, color: "#b9c7c6" }}>
          {company.descriptor.toUpperCase()}
        </div>
        <div style={{ display: "flex", width: 56, height: 3, background: "#cba25c", marginTop: 36 }} />
        <div style={{ display: "flex", marginTop: 32, fontSize: 32 }}>{company.slogan[0]}</div>
        <div style={{ display: "flex", marginTop: 6, fontSize: 32, color: "#cba25c" }}>{company.slogan[1]}</div>
        <div style={{ display: "flex", position: "absolute", bottom: 40, fontSize: 16, letterSpacing: 6, color: "#b9c7c6" }}>
          {`${company.city.toUpperCase()} · ${company.stateCode} · DESDE ${company.foundingYear}`}
        </div>
      </div>
    ),
    size,
  );
}

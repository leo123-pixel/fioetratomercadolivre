import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { company, seo } from "@/content/lopes";

export const alt = seo.ogImageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Imagem de compartilhamento (Open Graph): logo oficial (versão clara) sobre o verde-petróleo. */
export default async function OpengraphImage() {
  const logo = company.logoLight
    ? `data:image/png;base64,${(await readFile(join(process.cwd(), "public", company.logoLight.src))).toString("base64")}`
    : null;
  const logoHeight = 260;
  const logoWidth = company.logoLight ? Math.round((company.logoLight.width / company.logoLight.height) * logoHeight) : 0;

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
          color: "#f0eee6",
          fontFamily: "sans-serif",
        }}
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} width={logoWidth} height={logoHeight} alt="" />
        ) : (
          <div style={{ display: "flex", fontSize: 96, fontWeight: 600 }}>{company.name}</div>
        )}
        <div style={{ display: "flex", width: 56, height: 3, background: "#cba25c", marginTop: 40 }} />
        <div style={{ display: "flex", marginTop: 30, fontSize: 32 }}>{company.slogan[0]}</div>
        <div style={{ display: "flex", marginTop: 6, fontSize: 32, color: "#cba25c" }}>{company.slogan[1]}</div>
      </div>
    ),
    size,
  );
}

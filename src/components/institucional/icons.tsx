/** Ícones de linha discretos (SVG inline, sem dependências). Decorativos: aria-hidden. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

const paths: Record<string, React.ReactNode> = {
  experience: (
    <>
      <circle cx="12" cy="9" r="5.5" />
      <path d="M8.5 13.2 7 21l5-2.6L17 21l-1.5-7.8" />
      <path d="m10 9 1.4 1.4L14.2 7.6" />
    </>
  ),
  portfolio: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  relationship: (
    <>
      <path d="M3 11.5 7.5 7l3 1.5L13 6.5l4 1 4 4" />
      <path d="m7 15 2.5 2.5a1.4 1.4 0 0 0 2-2L9 13" />
      <path d="m11 17 1.5 1.5a1.4 1.4 0 0 0 2-2l-2.5-2.5" />
      <path d="m14 16.5.5.5a1.4 1.4 0 0 0 2-2l-4-4" />
      <path d="M3 11.5 7 15M21 11.5l-4.5 4.5" />
    </>
  ),
  expertise: (
    <>
      <path d="M12 3.5 3 8l9 4.5L21 8z" />
      <path d="M7 10.2V15c0 1.4 2.2 3 5 3s5-1.6 5-3v-4.8" />
      <path d="M21 8v5.5" />
    </>
  ),
  orders: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
    </>
  ),
  perfumery: (
    <>
      <path d="M10 3.5h4v3h-4z" />
      <path d="M9 6.5h6" />
      <rect x="6" y="9" width="12" height="11.5" rx="3" />
      <path d="M9.5 14.5h5" />
    </>
  ),
  store: (
    <>
      <path d="M4 9.5V20h16V9.5" />
      <path d="M3 9.5 5 4h14l2 5.5c0 1.4-1.1 2.5-2.5 2.5S16 10.9 16 9.5c0 1.4-1.1 2.5-2.5 2.5h-3C9.1 12 8 10.9 8 9.5 8 10.9 6.9 12 5.5 12S3 10.9 3 9.5z" />
      <path d="M10 20v-4.5h4V20" />
    </>
  ),
  salon: (
    <>
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M8.3 15.7 18 4M15.7 15.7 6 4" />
    </>
  ),
  professional: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
      <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" />
      <path d="M3.5 12.5h17" />
    </>
  ),
  pharmacy: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  cart: (
    <>
      <path d="M3 4h2.5l2 11h10.5l2-8H6.5" />
      <circle cx="9" cy="19" r="1.4" />
      <circle cx="17" cy="19" r="1.4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  phone: <path d="M5 4h3.5l1.7 4.3-2.2 1.4a11 11 0 0 0 6.3 6.3l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5C10.6 20 4 13.4 3.5 5.6A1.5 1.5 0 0 1 5 4z" />,
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  instagram: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
    </>
  ),
  facebook: <path d="M14.5 8H16V4.5h-2.2C11.3 4.5 10 6 10 8.5V11H8v3.5h2V21h3.5v-6.5h2.3l.5-3.5h-2.8V9c0-.6.4-1 1-1z" />,
  linkedin: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M8 10.5V16M8 7.8v.1M11.5 16v-3.2c0-1.4.9-2.3 2.1-2.3s2 .9 2 2.3V16M11.5 10.5V16" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M4 20l1.2-3.9A8.5 8.5 0 1 1 8.4 19z" />
      <path d="M9 8.5c0 3.6 2.9 6.5 6.5 6.5l1-1.5-2-1-1 .8a4.5 4.5 0 0 1-2.3-2.3l.8-1-1-2z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  arrowUpRight: <path d="M7 17 17 7M8 7h9v9" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, ...rest }: IconProps & { name: string }) {
  return <Svg {...rest}>{paths[name] ?? null}</Svg>;
}

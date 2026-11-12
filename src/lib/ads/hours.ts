/**
 * Horário de funcionamento dos servidores da ADS.
 *
 * A ADS desliga os servidores fora do expediente (confirmado: depois das 18h no horário de Campo Grande/MS).
 * Fora dessa janela as automações de estoque e preço não consultam a ADS — só voltariam erro — e
 * retomam sozinhas quando a janela abre. Ações manuais continuam disponíveis.
 */
export const ADS_TIMEZONE = "America/Campo_Grande";
export const ADS_TIMEZONE_LABEL = "horário de Campo Grande/MS";
export const DEFAULT_ADS_HOURS = { start: "07:00", end: "18:00" } as const;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface AdsHours {
  /** "HH:MM" no fuso de Campo Grande; null (ou início = fim) = sem restrição. */
  adsHoursStart: string | null;
  adsHoursEnd: string | null;
}

let clock: () => Date = () => new Date();

/** Somente testes: fixa o relógio usado na janela da ADS (null restaura o real). */
export function setAdsClockForTesting(fn: (() => Date) | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setAdsClockForTesting só pode ser usado em testes");
  clock = fn ?? (() => new Date());
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutos desde a meia-noite no fuso da ADS. */
export function adsLocalMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: ADS_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export function adsHoursLabel(h: AdsHours): string {
  if (!h.adsHoursStart || !h.adsHoursEnd || h.adsHoursStart === h.adsHoursEnd) return "sem restrição de horário";
  return `das ${h.adsHoursStart} às ${h.adsHoursEnd} (${ADS_TIMEZONE_LABEL})`;
}

/** A ADS está no horário de funcionamento agora? Devolve o motivo quando não. */
export function adsHoursState(h: AdsHours, now: Date = clock()): { open: boolean; reason: string | null } {
  const start = h.adsHoursStart && HHMM.test(h.adsHoursStart) ? toMinutes(h.adsHoursStart) : null;
  const end = h.adsHoursEnd && HHMM.test(h.adsHoursEnd) ? toMinutes(h.adsHoursEnd) : null;
  if (start === null || end === null || start === end) return { open: true, reason: null };
  const t = adsLocalMinutes(now);
  // Janela que atravessa a meia-noite (ex.: 22:00 às 06:00) também é aceita.
  const open = start < end ? t >= start && t < end : t >= start || t < end;
  return open
    ? { open: true, reason: null }
    : { open: false, reason: `Fora do horário da ADS (${adsHoursLabel(h).replace(/^das /, "")}); retoma sozinha quando a janela abrir` };
}

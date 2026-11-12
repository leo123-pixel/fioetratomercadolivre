import { describe, expect, it } from "vitest";
import { adsHoursLabel, adsHoursState, adsLocalMinutes } from "@/lib/ads/hours";

// Campo Grande/MS = UTC-4 (sem horário de verão).
const at = (utc: string) => new Date(utc);
const DEFAULT = { adsHoursStart: "07:00", adsHoursEnd: "18:00" };

describe("horário de funcionamento da ADS", () => {
  it("converte para o horário de Campo Grande", () => {
    expect(adsLocalMinutes(at("2026-11-12T22:00:00Z"))).toBe(18 * 60);
    expect(adsLocalMinutes(at("2026-11-13T03:30:00Z"))).toBe(23 * 60 + 30);
  });

  it("aberta das 07:00 às 18:00; depois das 18:00 e de madrugada, fechada", () => {
    expect(adsHoursState(DEFAULT, at("2026-11-12T10:59:00Z")).open).toBe(false); // 06:59
    expect(adsHoursState(DEFAULT, at("2026-11-12T11:00:00Z")).open).toBe(true); // 07:00
    expect(adsHoursState(DEFAULT, at("2026-11-12T21:59:00Z")).open).toBe(true); // 17:59
    const closed = adsHoursState(DEFAULT, at("2026-11-12T22:00:00Z")); // 18:00
    expect(closed).toEqual({ open: false, reason: expect.stringMatching(/Fora do horário da ADS \(07:00 às 18:00/) });
    expect(adsHoursState(DEFAULT, at("2026-11-13T05:00:00Z")).open).toBe(false); // 01:00
  });

  it("janela que atravessa a meia-noite e janela vazia (sem restrição)", () => {
    const night = { adsHoursStart: "22:00", adsHoursEnd: "06:00" };
    expect(adsHoursState(night, at("2026-11-13T03:00:00Z")).open).toBe(true); // 23:00
    expect(adsHoursState(night, at("2026-11-12T16:00:00Z")).open).toBe(false); // 12:00
    expect(adsHoursState({ adsHoursStart: null, adsHoursEnd: null }, at("2026-11-13T03:00:00Z")).open).toBe(true);
    expect(adsHoursLabel({ adsHoursStart: null, adsHoursEnd: "18:00" })).toBe("sem restrição de horário");
    expect(adsHoursLabel(DEFAULT)).toBe("das 07:00 às 18:00 (horário de Campo Grande/MS)");
  });
});

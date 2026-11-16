import { describe, expect, it } from "vitest";
import { allocate, distributeWithinChannel, planQuotas, worstCaseExposure, type ChannelExposure, type ChannelRule } from "@/lib/inventory/allocation";
import { assertInventoryEnabled, assertRemoteWriteAllowed, inventoryCoreMode, InventoryCoreDisabledError, InventoryWriteBlockedError } from "@/lib/inventory/mode";
import { computePosition } from "@/lib/inventory/position";
import { applyEvents, deriveState, EMPTY_FACTS, type ReservationEvent, type ReservationState } from "@/lib/inventory/reservations";
import { GatedRemoteTransferExecutor, runTransferProtocol, SimulatedTransferExecutor, type TransferRequest } from "@/lib/inventory/transfer";

/**
 * Regras puras do Inventory Core: cotas, posição segura, compromissos, transferências e modo.
 * Inclui testes de propriedade (gerador determinístico com semente) para os invariantes de alocação.
 */
const ML_NS_5050: ChannelRule[] = [
  { channel: "mercadolivre", type: "PERCENT", value: 50, priority: 1 },
  { channel: "nuvemshop", type: "PERCENT", value: 50, priority: 2 },
];
const qty = (r: ReturnType<typeof allocate>, ch: string) => r.allocations.find((a) => a.channel === ch)!.quantity;

describe("cotas exclusivas por canal", () => {
  it("exemplo da especificação: ADS 10, segurança 2 → 8 disponíveis, 4 + 4", () => {
    const p = computePosition({ snapshot: { status: "KNOWN", quantity: 10, fetchedAt: new Date() }, reservations: [], safetyReserve: 2, maxSnapshotAgeMinutes: 60 });
    expect(p.safeSellable).toBe(8);
    const r = allocate(p.safeSellable, { rules: ML_NS_5050, remainderMode: "PRIORITY" });
    expect(qty(r, "mercadolivre")).toBe(4);
    expect(qty(r, "nuvemshop")).toBe(4);
    expect(r.allocated).toBe(8);
  });

  it("estoque zero: todas as cotas zero", () => {
    const r = allocate(0, { rules: ML_NS_5050, remainderMode: "PRIORITY" });
    expect(r.allocations.map((a) => a.quantity)).toEqual([0, 0]);
  });

  it("estoque desconhecido: bloqueado, nenhuma cota (não vira zero)", () => {
    const r = allocate(null, { rules: ML_NS_5050, remainderMode: "PRIORITY" });
    expect(r.status).toBe("BLOCKED");
    expect(r.allocations.every((a) => a.quantity === null)).toBe(true);
  });

  it("estoque menor que o número de canais: 1 unidade vai para UM canal só (prioridade)", () => {
    const r = allocate(1, { rules: ML_NS_5050, remainderMode: "PRIORITY" });
    expect(qty(r, "mercadolivre")).toBe(1);
    expect(qty(r, "nuvemshop")).toBe(0);
    const u = allocate(1, { rules: ML_NS_5050, remainderMode: "UNALLOCATED" });
    expect(u.allocated).toBe(0);
    expect(u.unallocated).toBe(1);
  });

  it("arredondamento: 7 em 50/50 → 4 + 3; 3 em 1/3 cada → 1+1+1 sem exceder", () => {
    const r = allocate(7, { rules: ML_NS_5050, remainderMode: "PRIORITY" });
    expect([qty(r, "mercadolivre"), qty(r, "nuvemshop")]).toEqual([4, 3]);
    const three = allocate(10, {
      rules: [
        { channel: "a1", type: "PERCENT", value: 33.34, priority: 1 },
        { channel: "b1", type: "PERCENT", value: 33.33, priority: 2 },
        { channel: "c1", type: "PERCENT", value: 33.33, priority: 3 },
      ],
      remainderMode: "PRIORITY",
    });
    expect(three.allocated).toBe(10);
    expect(three.allocations.map((a) => a.quantity)).toEqual([4, 3, 3]);
  });

  it("divisão fixa, limite máximo, cota mínima e prioridade comercial", () => {
    const rules: ChannelRule[] = [
      { channel: "mercadolivre", type: "FIXED", value: 6, priority: 2 },
      { channel: "nuvemshop", type: "PERCENT", value: 100, max: 3, min: 2, priority: 1 },
    ];
    const r = allocate(5, { rules, remainderMode: "PRIORITY" });
    // Nuvemshop tem prioridade: mínimo 2, alvo limitado a 3; ML recebe o que sobra (2 de 6).
    expect(qty(r, "nuvemshop")).toBe(3);
    expect(qty(r, "mercadolivre")).toBe(2);
    expect(r.allocations.find((a) => a.channel === "mercadolivre")!.reason).toMatch(/Limitado/);
  });

  it("cota zero e novo canal: canal novo começa com zero e não tira nada dos outros", () => {
    const r = allocate(9, {
      rules: [
        { channel: "mercadolivre", type: "PERCENT", value: 100, priority: 1 },
        { channel: "nuvemshop", type: "ZERO", priority: 2 },
        { channel: "loja_nova", type: "ZERO", priority: 3 },
      ],
      remainderMode: "PRIORITY",
    });
    expect(qty(r, "mercadolivre")).toBe(9);
    expect(qty(r, "nuvemshop")).toBe(0);
    expect(qty(r, "loja_nova")).toBe(0);
  });

  it("canal desativado fica com zero", () => {
    const r = allocate(8, { rules: ML_NS_5050, remainderMode: "PRIORITY" }, new Set(["nuvemshop"]));
    expect(qty(r, "nuvemshop")).toBe(0);
    expect(qty(r, "mercadolivre")).toBe(4);
  });

  it("regras inválidas são recusadas (percentual > 100, canal repetido, mínimo > máximo)", () => {
    expect(() => allocate(5, { rules: [{ channel: "mercadolivre", type: "PERCENT", value: 150, priority: 1 }], remainderMode: "PRIORITY" })).toThrow();
    expect(() => allocate(5, { rules: [ML_NS_5050[0], ML_NS_5050[0]], remainderMode: "PRIORITY" })).toThrow(/repetido/);
    expect(() => allocate(5, { rules: [{ channel: "mercadolivre", type: "FIXED", value: 1, min: 3, max: 2, priority: 1 }], remainderMode: "PRIORITY" })).toThrow();
    const w = allocate(10, {
      rules: [
        { channel: "mercadolivre", type: "PERCENT", value: 80, priority: 1 },
        { channel: "nuvemshop", type: "PERCENT", value: 80, priority: 2 },
      ],
      remainderMode: "PRIORITY",
    });
    expect(w.warnings[0]).toMatch(/160%/);
    expect(w.allocated).toBe(10);
  });
});

describe("plano de cotas (exposição confirmada × desejada)", () => {
  const exp = (ml: number | null, ns = 0, opts: Partial<ChannelExposure> = {}): ChannelExposure[] => [
    { channel: "mercadolivre", confirmed: ml, reachable: true, simulated: false, ...opts },
    { channel: "nuvemshop", confirmed: ns, reachable: true, simulated: false },
  ];

  it("redistribuição: nunca aumenta o destino antes de a origem reduzir", () => {
    // ML anuncia 8, política nova 4/4: ML reduz para 4, Nuvemshop espera (não há folga ainda).
    const p = planQuotas(8, { rules: ML_NS_5050, remainderMode: "PRIORITY" }, exp(8, 0));
    const ml = p.items.find((i) => i.channel === "mercadolivre")!;
    const ns = p.items.find((i) => i.channel === "nuvemshop")!;
    expect(ml.desired).toBe(4);
    expect(ns.policyQuota).toBe(4);
    expect(ns.desired).toBe(0);
    expect(ns.reason).toMatch(/aguarda a redução/);
    expect(worstCaseExposure(p)).toBeLessThanOrEqual(8);
    // Depois da redução confirmada no ML, a folga libera a Nuvemshop.
    const after = planQuotas(8, { rules: ML_NS_5050, remainderMode: "PRIORITY" }, exp(4, 0));
    expect(after.items.find((i) => i.channel === "nuvemshop")!.desired).toBe(4);
  });

  it("dados degradados: só redução", () => {
    const p = planQuotas(10, { rules: [{ channel: "mercadolivre", type: "PERCENT", value: 100, priority: 1 }], remainderMode: "PRIORITY" }, exp(3), { allowIncrease: false });
    expect(p.items[0].desired).toBe(3);
    const d = planQuotas(2, { rules: [{ channel: "mercadolivre", type: "PERCENT", value: 100, priority: 1 }], remainderMode: "PRIORITY" }, exp(3), { allowIncrease: false });
    expect(d.items[0].desired).toBe(2);
  });

  it("exposição desconhecida em um canal bloqueia aumentos nos outros", () => {
    const p = planQuotas(8, { rules: ML_NS_5050, remainderMode: "PRIORITY" }, exp(null, 0));
    expect(p.items.find((i) => i.channel === "nuvemshop")!.desired).toBe(0);
    expect(p.items.find((i) => i.channel === "mercadolivre")!.status).toBe("UNCONFIRMED");
  });

  it("canal indisponível: a cota nova fica pendente (não é tratada como aplicada)", () => {
    const p = planQuotas(5, { rules: [{ channel: "mercadolivre", type: "PERCENT", value: 100, priority: 1 }], remainderMode: "PRIORITY" }, [{ channel: "mercadolivre", confirmed: 9, reachable: false, simulated: false }]);
    expect(p.items[0]).toMatchObject({ desired: 5, confirmed: 9, status: "PENDING_REMOTE", pending: 4 });
    expect(p.items[0].reason).toMatch(/indisponível/);
    expect(p.overExposedBy).toBe(4);
  });
});

describe("distribuição dentro do canal: vários anúncios, variações e kits", () => {
  it("produto em dois anúncios independentes: EXCLUSIVE bloqueia, SPLIT_EVEN divide ⌊n/2⌋", () => {
    const pools = [
      { key: "item:MLB1", components: [{ productId: 1, quantity: 1 }], maxQuantity: null },
      { key: "item:MLB2:777", components: [{ productId: 1, quantity: 1 }], maxQuantity: null },
    ];
    const quota = new Map([[1, 5]]);
    expect(distributeWithinChannel(quota, pools, () => "EXCLUSIVE").map((t) => t.reasonCode)).toEqual(["ALLOCATION_REQUIRED", "ALLOCATION_REQUIRED"]);
    expect(distributeWithinChannel(quota, pools, () => "SPLIT_EVEN").map((t) => t.target)).toEqual([2, 2]);
  });

  it("kit: mínimo entre componentes de ⌊cota ÷ quantidade por venda⌋, limitado por max_quantity", () => {
    const kit = { key: "item:KIT", components: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }], maxQuantity: 3 };
    expect(distributeWithinChannel(new Map([[1, 9], [2, 10]]), [kit], () => "EXCLUSIVE")[0].target).toBe(3);
    expect(distributeWithinChannel(new Map([[1, 5], [2, 10]]), [kit], () => "EXCLUSIVE")[0].target).toBe(2);
    expect(distributeWithinChannel(new Map([[1, 5], [2, null]]), [kit], () => "EXCLUSIVE")[0].reasonCode).toBe("QUOTA_UNKNOWN");
  });
});

describe("posição segura", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const fresh = { status: "KNOWN" as const, quantity: "10", fetchedAt: new Date(now.getTime() - 5 * 60_000) };

  it("desconta pendentes (arredondando para cima) e a reserva; reflete na ADS não desconta de novo", () => {
    const p = computePosition({
      snapshot: fresh,
      reservations: [
        { quantity: "1.5", state: "PENDING_ERP" },
        { quantity: "2", state: "REQUIRES_RECONCILIATION" },
        { quantity: "3", state: "REFLECTED_IN_ERP" },
        { quantity: "4", state: "RELEASED" },
      ],
      safetyReserve: 1,
      now,
      maxSnapshotAgeMinutes: 60,
    });
    expect(p.pendingCommitments).toBe(3.5);
    expect(p.safeSellable).toBe(10 - 4 - 1);
    expect(p.reflectedCommitments).toBe(3);
    // Reconciliação pendente: degradado (só redução).
    expect(p.reliability).toBe("DEGRADED");
    expect(p.allowIncrease).toBe(false);
  });

  it("falha na ADS e saldo ausente: desconhecido, nunca zero", () => {
    const e = computePosition({ snapshot: { status: "ERROR", quantity: null, fetchedAt: now }, reservations: [], safetyReserve: 0, now, maxSnapshotAgeMinutes: 60 });
    expect(e).toMatchObject({ safeSellable: null, reliability: "UNKNOWN", allowIncrease: false });
    const u = computePosition({ snapshot: { status: "UNKNOWN", quantity: null, fetchedAt: null }, reservations: [], safetyReserve: 0, now, maxSnapshotAgeMinutes: 60 });
    expect(u.safeSellable).toBeNull();
  });

  it("saldo velho: degradado; depósito não mapeado: bloqueado", () => {
    const old = computePosition({ snapshot: { ...fresh, fetchedAt: new Date(now.getTime() - 3 * 3_600_000) }, reservations: [], safetyReserve: 0, now, maxSnapshotAgeMinutes: 60 });
    expect(old.reliability).toBe("DEGRADED");
    expect(old.safeSellable).toBe(10);
    const b = computePosition({ snapshot: fresh, reservations: [], safetyReserve: 0, now, maxSnapshotAgeMinutes: 60, blockers: ["Nenhuma filial mapeada"] });
    expect(b).toMatchObject({ reliability: "BLOCKED", safeSellable: null });
  });

  it("reserva maior que o saldo: zero (nunca negativo)", () => {
    const p = computePosition({ snapshot: { ...fresh, quantity: "2" }, reservations: [{ quantity: 5, state: "PENDING_ERP" }], safetyReserve: 3, now, maxSnapshotAgeMinutes: 60 });
    expect(p.safeSellable).toBe(0);
  });
});

describe("compromissos (estado como função dos fatos)", () => {
  const def = { adsDeductsOnOrderCreated: false };
  const st = (events: ReservationEvent[], policy = def, prev: ReservationState | null = null) => deriveState(applyEvents(EMPTY_FACTS, events), policy, prev).state;

  it("venda registrada → PENDING_ERP; pedido criado na ADS NÃO é baixa (padrão)", () => {
    expect(st([{ type: "ORDER_RECEIVED" }])).toBe("PENDING_ERP");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_CREATED", at: "2026-11-16T10:00:00Z" }])).toBe("PENDING_ERP");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_CREATED", at: "2026-11-16T10:00:00Z" }], { adsDeductsOnOrderCreated: true })).toBe("REFLECTED_IN_ERP");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_CREATED" }, { type: "ADS_STOCK_CONFIRMED" }])).toBe("REFLECTED_IN_ERP");
  });

  it("cancelamento antes da ADS libera; depois do envio exige reconciliação; depois da baixa não desconta de novo", () => {
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ORDER_CANCELLED" }])).toBe("RELEASED");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_CREATED" }, { type: "ORDER_CANCELLED" }])).toBe("REQUIRES_RECONCILIATION");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_STOCK_CONFIRMED" }, { type: "ORDER_CANCELLED" }])).toBe("REFLECTED_IN_ERP");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_CREATED" }, { type: "ORDER_CANCELLED" }, { type: "ADS_ORDER_CANCELLED" }])).toBe("RELEASED");
  });

  it("devolução: libera só o que nunca foi baixado; o resto depende da ADS", () => {
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ORDER_RETURNED" }])).toBe("RELEASED");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_STOCK_CONFIRMED" }, { type: "ORDER_RETURNED" }])).toBe("REFLECTED_IN_ERP");
  });

  it("envio incerto e pendência antiga: REQUIRES_RECONCILIATION (ainda descontado)", () => {
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_UNCERTAIN", at: "2026-11-16T10:00:00Z" }])).toBe("REQUIRES_RECONCILIATION");
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "STALE_PENDING" }])).toBe("REQUIRES_RECONCILIATION");
    // Incerto resolvido depois (SENT mais novo) volta a PENDING_ERP.
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_UNCERTAIN", at: "2026-11-16T10:00:00Z" }, { type: "ADS_ORDER_CREATED", at: "2026-11-16T10:05:00Z" }])).toBe("PENDING_ERP");
  });

  it("eventos fora de ordem dão o mesmo resultado", () => {
    expect(st([{ type: "ORDER_CANCELLED" }, { type: "ORDER_RECEIVED" }])).toBe("RELEASED");
    // Leitura antiga (SENT às 10h) chegando depois da incerta das 11h não substitui.
    expect(st([{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_UNCERTAIN", at: "2026-11-16T11:00:00Z" }, { type: "ADS_ORDER_CREATED", at: "2026-11-16T10:00:00Z" }])).toBe("REQUIRES_RECONCILIATION");
  });

  it("idempotente: repetir eventos não muda os fatos; REFLECTED não regride", () => {
    const events: ReservationEvent[] = [{ type: "ORDER_RECEIVED" }, { type: "ADS_ORDER_CREATED", at: "2026-11-16T10:00:00Z" }];
    const once = applyEvents(EMPTY_FACTS, events);
    expect(applyEvents(once, events)).toEqual(once);
    expect(deriveState(once, def, "REFLECTED_IN_ERP").state).toBe("REFLECTED_IN_ERP");
    expect(deriveState(applyEvents(EMPTY_FACTS, [{ type: "ORDER_RECEIVED" }]), def, "RELEASED").state).toBe("RELEASED");
  });

  it("propriedade: qualquer permutação dos mesmos eventos produz o mesmo estado", () => {
    const rnd = seeded(7);
    const pool: ReservationEvent[] = [
      { type: "ORDER_RECEIVED" },
      { type: "ORDER_CANCELLED" },
      { type: "ADS_ORDER_CREATED", at: "2026-11-16T10:00:00Z" },
      { type: "ADS_STOCK_CONFIRMED" },
      { type: "STALE_PENDING" },
      { type: "ORDER_RETURNED" },
      { type: "ADS_ORDER_CANCELLED" },
    ];
    for (let i = 0; i < 300; i++) {
      const subset = pool.filter(() => rnd() < 0.5);
      const a = st(subset);
      const shuffled = [...subset].sort(() => rnd() - 0.5);
      expect(st(shuffled)).toBe(a);
      expect(st([...subset, ...subset])).toBe(a);
    }
  });
});

describe("protocolo de transferência de cota", () => {
  const req = (o: Partial<TransferRequest> = {}): TransferRequest => ({ fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 2, sourceQuota: 4, destinationQuota: 4, safeSellable: 8, reliability: "RELIABLE", ...o });

  it("sucesso: reduz a origem, confirma, só então aumenta o destino", async () => {
    const ex = new SimulatedTransferExecutor();
    const r = await runTransferProtocol(req(), ex);
    expect(r.state).toBe("COMPLETED");
    expect(ex.calls).toEqual([
      { op: "decrease", channel: "mercadolivre", target: 2 },
      { op: "increase", channel: "nuvemshop", target: 6 },
    ]);
    expect(r.steps.map((s) => s.state)).toEqual(["REQUESTED", "SOURCE_DECREASE_PREPARED", "SOURCE_DECREASE_CONFIRMED", "DESTINATION_INCREASE_PREPARED", "COMPLETED"]);
    expect(Math.max(...r.steps.map((s) => s.worstCaseExposure))).toBeLessThanOrEqual(8);
  });

  it("falha na redução: bloqueia sem tocar no destino", async () => {
    const ex = new SimulatedTransferExecutor({ sourceDecrease: "failed" });
    const r = await runTransferProtocol(req(), ex);
    expect(r.state).toBe("BLOCKED");
    expect(ex.calls.map((c) => c.op)).toEqual(["decrease"]);
  });

  it("redução incerta: exige reconciliação antes de liberar", async () => {
    const ex = new SimulatedTransferExecutor({ sourceDecrease: "uncertain" });
    const r = await runTransferProtocol(req(), ex);
    expect(r.state).toBe("REQUIRES_RECONCILIATION");
    expect(ex.calls.map((c) => c.op)).toEqual(["decrease"]);
  });

  it("aumento incerto no destino: reconciliação; quantidade acima da cota: recusada", async () => {
    expect((await runTransferProtocol(req(), new SimulatedTransferExecutor({ destinationIncrease: "uncertain" }))).state).toBe("REQUIRES_RECONCILIATION");
    expect((await runTransferProtocol(req({ quantity: 5 }), new SimulatedTransferExecutor())).state).toBe("REJECTED");
    expect((await runTransferProtocol(req({ reliability: "UNKNOWN", safeSellable: null }), new SimulatedTransferExecutor())).state).toBe("REJECTED");
  });

  it("executor real: o portão de escrita recusa e a transferência fica BLOCKED", async () => {
    const r = await runTransferProtocol(req(), new GatedRemoteTransferExecutor());
    expect(r.state).toBe("BLOCKED");
    expect(r.error).toMatch(/Escrita remota bloqueada/);
  });
});

describe("modo do Inventory Core", () => {
  it("padrão desativado; shadow ativa; valores desconhecidos (ex.: active) ficam desativados", () => {
    expect(inventoryCoreMode({}).mode).toBe("disabled");
    expect(inventoryCoreMode({ INVENTORY_CORE_MODE: "shadow" }).mode).toBe("shadow");
    const active = inventoryCoreMode({ INVENTORY_CORE_MODE: "active" });
    expect(active.mode).toBe("disabled");
    expect(active.reason).toMatch(/não é suportado/);
    expect(() => assertInventoryEnabled({})).toThrow(InventoryCoreDisabledError);
  });

  it("escrita remota é sempre recusada, em qualquer modo", () => {
    expect(() => assertRemoteWriteAllowed("qualquer")).toThrow(InventoryWriteBlockedError);
    expect(inventoryCoreMode({ INVENTORY_CORE_MODE: "shadow" }).remoteWritesEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Testes de propriedade (gerador determinístico).
// ---------------------------------------------------------------------------

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("propriedades: o total alocado nunca excede o saldo seguro", () => {
  const CH = ["mercadolivre", "nuvemshop", "loja_a", "loja_b"];

  function randomRules(rnd: () => number): ChannelRule[] {
    const n = 1 + Math.floor(rnd() * CH.length);
    return CH.slice(0, n).map((channel, i) => {
      const t = rnd();
      const type = t < 0.5 ? "PERCENT" : t < 0.85 ? "FIXED" : "ZERO";
      const max = rnd() < 0.3 ? Math.floor(rnd() * 20) : null;
      const min = rnd() < 0.3 ? Math.floor(rnd() * (max ?? 10)) : null;
      return { channel, type, value: type === "PERCENT" ? Math.round(rnd() * 10000) / 100 : type === "FIXED" ? Math.floor(rnd() * 30) : undefined, max, min, priority: Math.floor(rnd() * 5) + i * 0 } as ChannelRule;
    });
  }

  it("5.000 combinações de saldo, reservas, segurança, cotas e exposição", () => {
    const rnd = seeded(20261116);
    for (let i = 0; i < 5_000; i++) {
      const ads = rnd() < 0.1 ? null : Math.floor(rnd() * 200) - 5;
      const reservations = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
        quantity: String(Math.round(rnd() * 1000) / 100 + 0.01),
        state: (["PENDING_ERP", "REFLECTED_IN_ERP", "RELEASED", "REQUIRES_RECONCILIATION"] as const)[Math.floor(rnd() * 4)],
      }));
      const pos = computePosition({
        snapshot: ads === null ? { status: rnd() < 0.5 ? "ERROR" : "UNKNOWN", quantity: null, fetchedAt: null } : { status: "KNOWN", quantity: String(ads), fetchedAt: new Date() },
        reservations,
        safetyReserve: Math.floor(rnd() * 5),
        maxSnapshotAgeMinutes: 60,
      });
      if (pos.safeSellable !== null) {
        const pending = reservations.filter((r) => r.state === "PENDING_ERP" || r.state === "REQUIRES_RECONCILIATION").reduce((a, r) => a + Number(r.quantity), 0);
        expect(pos.safeSellable).toBeGreaterThanOrEqual(0);
        expect(pos.safeSellable).toBeLessThanOrEqual(Math.max(0, Math.floor(ads!) - Math.ceil(pending - 1e-9) - pos.safetyReserve));
      }
      let rules: ChannelRule[];
      try {
        rules = randomRules(rnd);
        allocate(0, { rules, remainderMode: "PRIORITY" });
      } catch {
        continue; // combinação inválida (ex.: percentuais somando > 100% são aceitos; min > max não)
      }
      const remainderMode = rnd() < 0.5 ? "PRIORITY" : "UNALLOCATED";
      const r = allocate(pos.safeSellable, { rules, remainderMode });
      if (pos.safeSellable === null) {
        expect(r.status).toBe("BLOCKED");
        continue;
      }
      for (const a of r.allocations) {
        expect(Number.isInteger(a.quantity)).toBe(true);
        expect(a.quantity!).toBeGreaterThanOrEqual(0);
      }
      expect(r.allocated).toBeLessThanOrEqual(pos.safeSellable);
      // Exposição: nunca piora além do disponível seguro quando ela já cabia nele.
      const exposures = rules.map((x) => ({ channel: x.channel, confirmed: rnd() < 0.1 ? null : Math.floor(rnd() * 15), reachable: rnd() < 0.9, simulated: false }));
      const plan = planQuotas(pos.safeSellable, { rules, remainderMode }, exposures, { allowIncrease: pos.allowIncrease || rnd() < 0.5 });
      const exposedNow = exposures.reduce((a, e) => a + (e.confirmed ?? 0), 0);
      expect(plan.items.reduce((a, it) => a + (it.desired ?? 0), 0)).toBeLessThanOrEqual(Math.max(pos.safeSellable, exposedNow));
      if (exposedNow <= pos.safeSellable) expect(worstCaseExposure(plan)).toBeLessThanOrEqual(pos.safeSellable);
      else expect(worstCaseExposure(plan)).toBeLessThanOrEqual(exposedNow);
      for (const it of plan.items) if (it.desired !== null) expect(it.desired).toBeGreaterThanOrEqual(0);
    }
  });

  it("a mesma unidade nunca entra em duas cotas: estoque 1 com N canais 100% cada", () => {
    for (let n = 1; n <= 4; n++) {
      const rules = CH.slice(0, n).map((channel, i) => ({ channel, type: "PERCENT" as const, value: 100, priority: i }));
      const r = allocate(1, { rules, remainderMode: "PRIORITY" });
      expect(r.allocated).toBe(1);
      expect(r.allocations.filter((a) => a.quantity === 1)).toHaveLength(1);
    }
  });
});

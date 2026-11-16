/**
 * Motor de cotas exclusivas por canal (puro: sem banco, sem rede).
 *
 * A cota é um LIMITE DE EXPOSIÇÃO COMERCIAL (quanto cada canal pode anunciar), não uma reserva física no
 * ERP. As cotas são exclusivas: a mesma unidade nunca entra em duas cotas, e a soma nunca passa da
 * disponibilidade segura. Unidades são inteiras; arredondamento é sempre para baixo e a sobra é
 * entregue, uma unidade por vez, ao canal de maior prioridade que perdeu fração (remainder PRIORITY) ou
 * fica sem alocar (UNALLOCATED). Com estoque pequeno a divisão não é forçada: 1 unidade vai para no
 * máximo um canal, nunca "1 em todos".
 */

export const KNOWN_CHANNELS = ["mercadolivre", "nuvemshop"] as const;
export type ChannelId = string;

export type RuleType = "PERCENT" | "FIXED" | "ZERO";
export type RemainderMode = "PRIORITY" | "UNALLOCATED";

export interface ChannelRule {
  channel: ChannelId;
  type: RuleType;
  /** PERCENT: 0–100; FIXED: unidades. Ignorado em ZERO. */
  value?: number;
  /** Teto de unidades para o canal. */
  max?: number | null;
  /** Cota mínima opcional (respeitada por prioridade, nunca acima do disponível). */
  min?: number | null;
  /** Menor número = maior prioridade comercial. */
  priority: number;
}

export interface AllocationPolicy {
  safetyReserve: number | null;
  remainderMode: RemainderMode;
  rules: ChannelRule[];
}

export interface ChannelAllocation {
  channel: ChannelId;
  /** null = bloqueado (disponibilidade desconhecida). */
  quantity: number | null;
  /** Alvo antes da limitação pela disponibilidade (informativo). */
  target: number | null;
  reason: string | null;
}

export interface AllocationResult {
  status: "ALLOCATED" | "BLOCKED";
  available: number | null;
  allocations: ChannelAllocation[];
  allocated: number;
  unallocated: number;
  warnings: string[];
}

export class AllocationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationInvariantError";
  }
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Valida e normaliza as regras (duplicidade, faixas). Lança em regra inválida. */
export function validateRules(rules: ChannelRule[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  let percent = 0;
  for (const r of rules) {
    if (!/^[a-z0-9_]{2,30}$/.test(r.channel)) throw new AllocationInvariantError(`Canal inválido: ${r.channel}`);
    if (seen.has(r.channel)) throw new AllocationInvariantError(`Canal repetido na política: ${r.channel}`);
    seen.add(r.channel);
    if (!isInt(r.priority)) throw new AllocationInvariantError(`Prioridade inválida para ${r.channel}`);
    if (r.max !== undefined && r.max !== null && (!isInt(r.max) || r.max < 0)) throw new AllocationInvariantError(`Limite máximo inválido para ${r.channel}`);
    if (r.min !== undefined && r.min !== null && (!isInt(r.min) || r.min < 0)) throw new AllocationInvariantError(`Cota mínima inválida para ${r.channel}`);
    if (r.min != null && r.max != null && r.min > r.max) throw new AllocationInvariantError(`Cota mínima maior que o máximo em ${r.channel}`);
    if (r.type === "PERCENT") {
      if (typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0 || r.value > 100) throw new AllocationInvariantError(`Percentual inválido para ${r.channel}`);
      percent += r.value;
    } else if (r.type === "FIXED") {
      if (!isInt(r.value) || r.value < 0) throw new AllocationInvariantError(`Quantidade fixa inválida para ${r.channel}`);
    } else if (r.type !== "ZERO") throw new AllocationInvariantError(`Tipo de regra inválido para ${r.channel}`);
  }
  if (percent > 100) warnings.push(`Percentuais somam ${percent}%: os canais de menor prioridade recebem o que sobrar`);
  return warnings;
}

/**
 * Distribui `available` unidades inteiras entre os canais.
 * @param disabled canais que não podem receber cota agora (desativados) — ficam com 0.
 */
export function allocate(available: number | null, policy: Pick<AllocationPolicy, "rules" | "remainderMode">, disabled: ReadonlySet<ChannelId> = new Set()): AllocationResult {
  const warnings = validateRules(policy.rules);
  const ordered = [...policy.rules].sort((a, b) => a.priority - b.priority || a.channel.localeCompare(b.channel));
  if (available === null || !Number.isFinite(available)) {
    return {
      status: "BLOCKED",
      available: null,
      allocations: ordered.map((r) => ({ channel: r.channel, quantity: null, target: null, reason: "Disponibilidade desconhecida: nenhuma cota nova" })),
      allocated: 0,
      unallocated: 0,
      warnings,
    };
  }
  const total = Math.max(0, Math.floor(available));
  const alloc = new Map<ChannelId, number>(ordered.map((r) => [r.channel, 0]));
  const reasons = new Map<ChannelId, string | null>(ordered.map((r) => [r.channel, null]));
  const active = ordered.filter((r) => {
    if (r.type === "ZERO") reasons.set(r.channel, "Cota zero pela política");
    else if (disabled.has(r.channel)) reasons.set(r.channel, "Canal desativado");
    return r.type !== "ZERO" && !disabled.has(r.channel);
  });
  const cap = (r: ChannelRule) => (r.max ?? Infinity);
  const exact = (r: ChannelRule) => (r.type === "PERCENT" ? (total * (r.value ?? 0)) / 100 : (r.value ?? 0));
  const target = (r: ChannelRule) => Math.min(Math.max(Math.floor(exact(r)), r.min ?? 0), cap(r));
  let remaining = total;
  const give = (r: ChannelRule, upTo: number) => {
    const g = Math.max(0, Math.min(upTo - alloc.get(r.channel)!, remaining));
    alloc.set(r.channel, alloc.get(r.channel)! + g);
    remaining -= g;
  };
  // 1. Mínimos, por prioridade.
  for (const r of active) give(r, Math.min(r.min ?? 0, cap(r)));
  // 2. Alvos (percentual arredondado para baixo ou quantidade fixa), por prioridade.
  for (const r of active) give(r, target(r));
  // 3. Sobra do arredondamento: uma unidade por canal percentual que perdeu fração, por prioridade.
  if (policy.remainderMode === "PRIORITY") {
    for (const r of active) {
      if (remaining <= 0) break;
      if (r.type !== "PERCENT") continue;
      const ceil = Math.min(Math.ceil(exact(r)), cap(r));
      if (alloc.get(r.channel)! < ceil) give(r, alloc.get(r.channel)! + 1);
    }
  }
  const allocations = ordered.map((r) => {
    const q = alloc.get(r.channel)!;
    const t = r.type === "ZERO" || disabled.has(r.channel) ? 0 : target(r);
    let reason = reasons.get(r.channel) ?? null;
    if (!reason && q < t) reason = "Limitado pela disponibilidade segura (prioridade menor)";
    if (!reason && r.max != null && q === r.max && exact(r) > r.max) reason = "Limitado pelo máximo do canal";
    return { channel: r.channel, quantity: q, target: t, reason };
  });
  const allocated = allocations.reduce((a, c) => a + (c.quantity ?? 0), 0);
  const result: AllocationResult = { status: "ALLOCATED", available: total, allocations, allocated, unallocated: total - allocated, warnings };
  assertAllocationInvariants(result);
  return result;
}

/** Invariantes 1 e 2/5: nenhuma cota negativa ou fracionária; a soma nunca excede o disponível seguro. */
export function assertAllocationInvariants(r: AllocationResult): void {
  if (r.status === "BLOCKED") {
    if (r.allocations.some((a) => a.quantity !== null)) throw new AllocationInvariantError("Alocação bloqueada não pode ter quantidades");
    return;
  }
  let sum = 0;
  for (const a of r.allocations) {
    if (a.quantity === null || !isInt(a.quantity) || a.quantity < 0) throw new AllocationInvariantError(`Cota inválida para ${a.channel}: ${a.quantity}`);
    sum += a.quantity;
  }
  if (r.available === null || sum > r.available) throw new AllocationInvariantError(`Soma das cotas (${sum}) excede o disponível seguro (${r.available})`);
}

// ---------------------------------------------------------------------------
// Plano de cotas considerando o que já está exposto nos canais.
// ---------------------------------------------------------------------------

export interface ChannelExposure {
  channel: ChannelId;
  /**
   * Quantidade anunciada confirmada por leitura remota (unidades físicas). null = desconhecida.
   * Canal ainda não integrado: 0 (nada anunciado).
   */
  confirmed: number | null;
  /** O canal pode receber atualização agora? (indisponível = a cota nova fica pendente). */
  reachable: boolean;
  /** Canal só existe como simulação (ex.: Nuvemshop na fase 0). */
  simulated: boolean;
}

export type QuotaStatus = "IN_SYNC" | "PENDING_REMOTE" | "UNCONFIRMED" | "BLOCKED" | "SIMULATED";

export interface QuotaPlanItem {
  channel: ChannelId;
  /** Cota da política (antes da proteção de exposição). */
  policyQuota: number | null;
  /** Cota desejada final: segura mesmo que os outros canais ainda não tenham reduzido. */
  desired: number | null;
  confirmed: number | null;
  /** Diferença ainda não aplicada/confirmada remotamente (desired − confirmed, quando há). */
  pending: number | null;
  status: QuotaStatus;
  reason: string | null;
}

export interface QuotaPlan {
  available: number | null;
  allocation: AllocationResult;
  items: QuotaPlanItem[];
  /** Exposição atual (soma do confirmado) acima do disponível seguro. */
  overExposedBy: number;
}

/**
 * Plano de cotas seguro contra a ordem das atualizações:
 *  - reduções podem ser propostas sempre;
 *  - aumentos só usam a folga ainda NÃO exposta em nenhum canal (o que está anunciado continua exposto
 *    até a redução ser confirmada) — nunca se aumenta o destino antes de o origem reduzir;
 *  - sem permissão de aumento (dados degradados) a cota fica limitada ao que já está confirmado;
 *  - exposição desconhecida em algum canal impede aumentos em todos.
 */
export function planQuotas(
  available: number | null,
  policy: Pick<AllocationPolicy, "rules" | "remainderMode">,
  exposures: ChannelExposure[],
  opts: { allowIncrease: boolean; disabled?: ReadonlySet<ChannelId> } = { allowIncrease: true },
): QuotaPlan {
  const allocation = allocate(available, policy, opts.disabled);
  const byChannel = new Map(exposures.map((e) => [e.channel, e]));
  const exposureUnknown = exposures.some((e) => e.confirmed === null && !e.simulated);
  const exposedNow = exposures.reduce((a, e) => a + (e.confirmed ?? 0), 0);
  const items: QuotaPlanItem[] = [];
  if (allocation.status === "BLOCKED" || available === null) {
    for (const a of allocation.allocations) {
      const e = byChannel.get(a.channel);
      items.push({ channel: a.channel, policyQuota: null, desired: null, confirmed: e?.confirmed ?? null, pending: null, status: "BLOCKED", reason: a.reason });
    }
    return { available: null, allocation, items, overExposedBy: 0 };
  }
  const safe = allocation.available!;
  // Folga: o que não está exposto em canal nenhum (cada canal continua exposto pelo confirmado até reduzir).
  let headroom = Math.max(0, safe - exposedNow);
  const ordered = [...allocation.allocations].sort((a, b) => {
    const pa = policy.rules.find((r) => r.channel === a.channel)?.priority ?? 0;
    const pb = policy.rules.find((r) => r.channel === b.channel)?.priority ?? 0;
    return pa - pb || a.channel.localeCompare(b.channel);
  });
  for (const a of ordered) {
    const e = byChannel.get(a.channel) ?? { channel: a.channel, confirmed: 0, reachable: false, simulated: true };
    const quota = a.quantity!;
    const confirmed = e.confirmed;
    let desired = quota;
    let reason = a.reason;
    if (confirmed !== null && quota > confirmed) {
      // Aumento.
      if (!opts.allowIncrease || exposureUnknown) {
        desired = confirmed;
        reason = exposureUnknown ? "Exposição desconhecida em outro canal: aumento bloqueado" : "Dados sem confiabilidade suficiente: só redução";
      } else {
        const inc = Math.min(quota - confirmed, headroom);
        headroom -= inc;
        desired = confirmed + inc;
        if (desired < quota) reason = "Aumento limitado: aguarda a redução confirmada em outro canal";
      }
    } else if (confirmed === null && !e.simulated) {
      // Exposição atual desconhecida: tratada como aumento a partir de zero — limitada à folga ainda não exposta,
      // para continuar segura qualquer que seja a quantidade real anunciada.
      const inc = Math.min(quota, headroom);
      headroom -= inc;
      desired = inc;
      reason = inc < quota ? "Quantidade anunciada desconhecida: cota limitada à folga não exposta" : (reason ?? "Quantidade anunciada desconhecida");
    }
    const pending = confirmed === null ? null : Math.abs(desired - confirmed);
    let status: QuotaStatus;
    if (e.simulated) status = "SIMULATED";
    else if (confirmed === null) status = "UNCONFIRMED";
    else if (desired === confirmed) status = "IN_SYNC";
    else status = "PENDING_REMOTE";
    if (!e.reachable && status === "PENDING_REMOTE") reason = reason ?? "Canal indisponível: a nova cota não é considerada aplicada";
    items.push({ channel: a.channel, policyQuota: quota, desired, confirmed, pending, status, reason });
  }
  return { available: safe, allocation, items, overExposedBy: Math.max(0, exposedNow - safe) };
}

/**
 * Exposição máxima durante a transição (pior caso: cada canal pode estar no confirmado ou no desejado).
 * Invariante: se a exposição atual cabe no disponível seguro, o plano nunca a faz passar dele.
 */
export function worstCaseExposure(plan: QuotaPlan): number {
  return plan.items.reduce((a, i) => a + Math.max(i.desired ?? 0, i.confirmed ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Distribuição dentro de um canal: vários anúncios / kits / variações do mesmo produto.
// ---------------------------------------------------------------------------

export interface ListingComponent {
  productId: number;
  /** Unidades do produto consumidas por venda do anúncio (kit/pacote). */
  quantity: number;
}

export interface ListingPoolInput {
  key: string;
  components: ListingComponent[];
  maxQuantity: number | null;
}

export interface ListingTarget {
  key: string;
  target: number | null;
  reasonCode: string | null;
}

/**
 * Converte a cota do canal (em unidades físicas por produto) em quantidade por estoque de anúncio:
 * um produto que abastece vários estoques independentes só é dividido com SPLIT_EVEN (⌊cota ÷ n⌋);
 * em EXCLUSIVE fica bloqueado (nunca copia a cota para vários anúncios). Kits: mínimo entre os
 * componentes de ⌊parcela ÷ quantidade por venda⌋. Mesma regra do sincronizador atual.
 */
export function distributeWithinChannel(
  quotaByProduct: ReadonlyMap<number, number | null>,
  pools: ListingPoolInput[],
  splitModeOf: (productId: number) => "EXCLUSIVE" | "SPLIT_EVEN",
): ListingTarget[] {
  const consumers = new Map<number, number>();
  for (const p of pools) for (const c of p.components) consumers.set(c.productId, (consumers.get(c.productId) ?? 0) + 1);
  return pools.map((p) => {
    let target = Infinity;
    for (const c of p.components) {
      const quota = quotaByProduct.get(c.productId);
      if (quota === null || quota === undefined) return { key: p.key, target: null, reasonCode: "QUOTA_UNKNOWN" };
      const n = consumers.get(c.productId) ?? 1;
      if (n > 1 && splitModeOf(c.productId) !== "SPLIT_EVEN") return { key: p.key, target: null, reasonCode: "ALLOCATION_REQUIRED" };
      const share = n > 1 ? Math.floor(quota / n) : quota;
      if (!isInt(c.quantity) || c.quantity <= 0) return { key: p.key, target: null, reasonCode: "INVALID_COMPOSITION" };
      target = Math.min(target, Math.floor(share / c.quantity));
    }
    if (!Number.isFinite(target)) return { key: p.key, target: null, reasonCode: "NO_COMPONENTS" };
    if (p.maxQuantity !== null) target = Math.min(target, p.maxQuantity);
    return { key: p.key, target: Math.max(0, target), reasonCode: null };
  });
}

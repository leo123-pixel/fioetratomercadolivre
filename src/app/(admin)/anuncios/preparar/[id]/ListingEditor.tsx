"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { useAutoListingSync } from "@/app/(admin)/useAutoListingSync";
import { draftDisplayStatus, formatDateTime, formatMoney, formatNumber, formatPercent, listingStatusLabel, PUBLICATION_JOB_LABEL } from "@/lib/format";

// ---------------------------------------------------------------------------- tipos

interface AttrVal {
  id: string;
  value_id?: string | null;
  value_name?: string | null;
  values?: { id?: string | null; name?: string | null }[];
}

interface Issue {
  code: string;
  message: string;
  severity: "error" | "warning";
  source: string;
  field?: string;
}

interface DraftData {
  id: number;
  productId: number;
  adsProductId: number;
  status: string;
  version: number;
  title: string | null;
  familyName: string | null;
  description: string | null;
  selectedPriceTable: string | null;
  selectedBranchId: string | null;
  referencePrice: string | null;
  listingPrice: string | null;
  listingQuantity: number | null;
  marketplaceCategoryId: string | null;
  categoryName: string | null;
  marketplaceAttributes: AttrVal[];
  listingTypeId: string | null;
  itemCondition: string | null;
  saleTerms: AttrVal[];
  catalogProductId: string | null;
  catalogListing: boolean;
  validatedVersion: number | null;
  validationResult: { issues?: Issue[]; remote?: string; checkedAt?: string; version?: number } | null;
  lastError: string | null;
  marketplaceItemId: string | null;
  permalink: string | null;
  listingStatus: string | null;
  stockTotal: string | null;
  stockBranches: number;
  updatedAt: string;
}

interface MeliAttribute {
  id: string;
  name: string;
  value_type: string;
  tags?: Record<string, boolean>;
  values?: { id: string; name: string }[];
  allowed_units?: { id: string; name: string }[];
  default_unit?: string;
  value_max_length?: number;
  attribute_group_name?: string;
  hint?: string;
  tooltip?: string;
  relevance?: number;
}

interface Suggestion {
  id: string;
  name: string;
  value_name?: string;
  value_id?: string;
  source: string;
  reason: string;
}

interface Capabilities {
  connected: boolean;
  meliUserId: string | null;
  nickname: string | null;
  publicationModel: "USER_PRODUCTS" | "CLASSIC" | null;
  userProductSeller: boolean;
  canWrite: boolean;
  scope: string | null;
  tags: string[];
  error: string | null;
  fetchedAt: string | null;
}

const LOCKED = ["VALIDATING", "PUBLISHING", "PUBLISHED", "UNKNOWN"];
const CONDITION_LABEL: Record<string, string> = { new: "Novo", used: "Usado", not_specified: "Não especificado" };

function toInputMoney(v: string | null): string {
  if (!v) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : v;
}

function hasValue(a?: AttrVal): boolean {
  return Boolean(a && (a.value_id || a.value_name?.trim() || a.values?.some((v) => v.id || v.name?.trim())));
}

// ---------------------------------------------------------------------------- editor

export function ListingEditor(props: {
  initialDraft: DraftData;
  product: { id: number; adsProductId: number; nameOriginal: string; ean: string | null; manufacturerCode: string | null; presentation: string | null; supplierName: string | null; brand: string | null; inactive: boolean };
  prices: { code: string; description: string | null; branch: string; price: string | null; discount: string | null; inactive: boolean }[];
  stocks: { branch: string; quantity: string }[];
  defaultTable: string | null;
  capabilities: Capabilities;
  imageCount: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftData>(props.initialDraft);
  const [caps, setCaps] = useState<Capabilities>(props.capabilities);
  const model = caps.publicationModel ?? "CLASSIC";
  const locked = LOCKED.includes(draft.status);

  // Campos do formulário
  const [title, setTitle] = useState(draft.title ?? "");
  const [familyName, setFamilyName] = useState(draft.familyName ?? "");
  const [description, setDescription] = useState(draft.description ?? "");
  const [priceKey, setPriceKey] = useState(draft.selectedPriceTable ? `${draft.selectedPriceTable}|${draft.selectedBranchId ?? ""}` : "");
  const [listingPrice, setListingPrice] = useState(toInputMoney(draft.listingPrice));
  const [quantity, setQuantity] = useState(draft.listingQuantity?.toString() ?? "");
  const [category, setCategory] = useState<{ id: string; name: string } | null>(draft.marketplaceCategoryId ? { id: draft.marketplaceCategoryId, name: draft.categoryName ?? draft.marketplaceCategoryId } : null);
  const [attrs, setAttrs] = useState<Record<string, AttrVal>>(Object.fromEntries((draft.marketplaceAttributes ?? []).filter((a) => a.id !== "SELLER_SKU").map((a) => [a.id, a])));
  const [listingType, setListingType] = useState(draft.listingTypeId ?? "");
  const [condition, setCondition] = useState(draft.itemCondition ?? "new");
  const [warrantyType, setWarrantyType] = useState(draft.saleTerms?.find((t) => t.id === "WARRANTY_TYPE")?.value_name ?? "");
  const [warrantyTime, setWarrantyTime] = useState(draft.saleTerms?.find((t) => t.id === "WARRANTY_TIME")?.value_name ?? "");
  const [catalogProductId, setCatalogProductId] = useState(draft.catalogProductId);
  const [catalogListing, setCatalogListing] = useState(draft.catalogListing);
  const [dirty, setDirty] = useState(false);
  const touch = useCallback(() => setDirty(true), []);

  // Dados da categoria
  const [categoryInfo, setCategoryInfo] = useState<{ settings: Record<string, unknown>; path: { id: string; name: string }[]; children: number } | null>(null);
  const [meliAttrs, setMeliAttrs] = useState<MeliAttribute[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [listingTypes, setListingTypes] = useState<{ id: string; name: string }[]>([]);
  const [conditional, setConditional] = useState<Set<string>>(new Set());
  const [techGroups, setTechGroups] = useState<{ label: string; ids: string[] }[] | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);
  const [review, setReview] = useState<ReviewData | null>(null);

  const issues: Issue[] = draft.validationResult?.issues ?? [];
  const status = draftDisplayStatus(draft.status, draft.listingStatus);
  useAutoListingSync(draft.status === "PUBLISHED" && Boolean(draft.marketplaceItemId));
  const maxTitle = typeof categoryInfo?.settings.max_title_length === "number" ? (categoryInfo.settings.max_title_length as number) : 60;

  // ------------------------------------------------------------ carregamento da categoria
  useEffect(() => {
    if (!category) {
      setMeliAttrs([]);
      setCategoryInfo(null);
      return;
    }
    let cancel = false;
    (async () => {
      const [c, a, t, s] = await Promise.all([
        api<{ category: { settings: Record<string, unknown>; path_from_root: { id: string; name: string }[]; children_categories: unknown[] } }>(`/api/mercadolivre/categories/${category.id}`),
        api<{ attributes: MeliAttribute[]; suggestions: Suggestion[] }>(`/api/mercadolivre/categories/${category.id}/attributes?draftId=${draft.id}`),
        api<{ listingTypes: { id: string; name: string }[] }>(`/api/mercadolivre/listing-types?categoryId=${category.id}`),
        api<{ technicalSpecs: unknown }>(`/api/mercadolivre/categories/${category.id}/technical-specs`),
      ]);
      if (cancel) return;
      if (c.ok) setCategoryInfo({ settings: c.data.category.settings, path: c.data.category.path_from_root, children: c.data.category.children_categories.length });
      if (a.ok) {
        setMeliAttrs(a.data.attributes);
        setSuggestions(a.data.suggestions);
      } else setFeedback({ kind: "error", text: `Atributos: ${errorText(a)}` });
      setListingTypes(t.ok ? t.data.listingTypes : []);
      setTechGroups(s.ok ? parseTechGroups(s.data.technicalSpecs) : null);
    })();
    return () => {
      cancel = true;
    };
  }, [category, draft.id]);

  // ------------------------------------------------------------ obrigatórios condicionais (debounce)
  const attrList = useMemo(() => Object.values(attrs).filter(hasValue), [attrs]);
  useEffect(() => {
    if (!category || locked) return;
    const t = setTimeout(async () => {
      const r = await api<{ required: string[] }>(`/api/mercadolivre/categories/${category.id}/conditional`, { body: { attributes: attrList } });
      if (r.ok) setConditional(new Set(r.data.required));
    }, 900);
    return () => clearTimeout(t);
  }, [attrList, category, locked]);

  // ------------------------------------------------------------ acompanhamento durante a publicação
  const reload = useCallback(async () => {
    const r = await api<{ draft: DraftData }>(`/api/listing-drafts/${draft.id}`);
    if (r.ok) setDraft(r.data.draft);
  }, [draft.id]);
  useEffect(() => {
    if (!["PUBLISHING", "UNKNOWN", "VALIDATING"].includes(draft.status)) return;
    const timer = setInterval(async () => {
      await api("/api/marketplace/publication-jobs?limit=1"); // retoma o worker se necessário
      await reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [draft.status, reload]);

  // ------------------------------------------------------------ ações
  function patchBody(): Record<string, unknown> {
    const [table, branch] = priceKey ? priceKey.split("|") : [null, null];
    const saleTerms: AttrVal[] = [];
    if (warrantyType.trim()) saleTerms.push({ id: "WARRANTY_TYPE", value_name: warrantyType.trim() });
    if (warrantyTime.trim()) saleTerms.push({ id: "WARRANTY_TIME", value_name: warrantyTime.trim() });
    return {
      title: title.trim() || null,
      familyName: familyName.trim() || null,
      description: description.trim() || null,
      selectedPriceTable: table || null,
      selectedBranchId: branch || null,
      listingPrice: listingPrice.trim() || null,
      listingQuantity: quantity.trim() === "" ? null : Number(quantity),
      marketplaceCategoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      marketplaceAttributes: Object.values(attrs).filter(hasValue),
      listingTypeId: listingType || null,
      itemCondition: condition || null,
      saleTerms,
      catalogProductId: catalogListing ? catalogProductId : null,
      catalogListing: Boolean(catalogListing && catalogProductId),
    };
  }

  /** Anúncio anterior encerrado/excluído no ML: reabre o rascunho (nova versão) sem publicar nada. */
  async function reopenForRepublish() {
    if (!window.confirm("O sistema vai confirmar no Mercado Livre que o anúncio anterior foi encerrado ou excluído e reabrir este rascunho para edição. Nada será publicado agora. Continuar?")) return;
    setBusy("republish");
    setFeedback(null);
    try {
      const r = await api<{ previousItemId: string; previousStatus: string }>(`/api/listing-drafts/${draft.id}/republish`, { body: {} });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  async function save(quiet = false): Promise<boolean> {
    setBusy("save");
    if (!quiet) setFeedback(null);
    try {
      const r = await api<{ draft: DraftData }>(`/api/listing-drafts/${draft.id}`, { method: "PATCH", body: patchBody() });
      if (!r.ok) {
        setFeedback({ kind: "error", text: errorText(r) });
        return false;
      }
      setDraft(r.data.draft);
      setDirty(false);
      if (!quiet) setFeedback({ kind: "success", text: `Rascunho salvo (versão ${r.data.draft.version}). Nada foi publicado.` });
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function validate() {
    if (dirty && !(await save(true))) return;
    setBusy("validate");
    setFeedback(null);
    try {
      const r = await api<{ validation: { status: string; issues: Issue[]; remote: string } }>(`/api/listing-drafts/${draft.id}/validate`, { body: {} });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      await reload();
      const v = r.data.validation;
      const errors = v.issues.filter((i) => i.severity === "error").length;
      setFeedback(
        v.status === "VALIDATED"
          ? { kind: "success", text: "Anúncio validado, inclusive pela validação oficial do Mercado Livre. Revise e confirme para publicar." }
          : v.status === "READY"
            ? { kind: "warn", text: "Regras internas ok, mas a validação oficial do Mercado Livre não foi concluída. Tente validar novamente." }
            : { kind: "error", text: `${errors} pendência(s) impedem a publicação. Veja a lista abaixo.` },
      );
    } finally {
      setBusy(null);
    }
  }

  async function openReview() {
    if (dirty) return setFeedback({ kind: "warn", text: "Salve e valide as alterações antes de revisar a publicação." });
    setBusy("review");
    try {
      const r = await api<ReviewData>(`/api/listing-drafts/${draft.id}/review`);
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setReview(r.data);
    } finally {
      setBusy(null);
    }
  }

  async function refreshCaps() {
    const r = await api<{ capabilities: Capabilities }>("/api/mercadolivre/capabilities?refresh=1");
    if (r.ok) setCaps(r.data.capabilities);
    else setFeedback({ kind: "error", text: errorText(r) });
  }

  function setAttr(id: string, v: AttrVal | null) {
    setAttrs((prev) => {
      const next = { ...prev };
      if (!v || !hasValue(v)) delete next[id];
      else next[id] = v;
      return next;
    });
    touch();
  }

  const priceOptions = props.prices.filter((p) => !p.inactive && p.price !== null);
  const selectedPrice = priceOptions.find((p) => `${p.code}|${p.branch}` === priceKey) ?? null;
  const stockTotal = props.stocks.reduce((a, s) => a + Number(s.quantity), 0);

  const blockingByField = (field: string) => issues.filter((i) => i.field === field && i.severity === "error");

  return (
    <>
      {/* ------------------------------------------------------ cabeçalho / estado */}
      <section className="card">
        <div className="status-row">
          <div className="toolbar">
            <span className={`chip ${status.tone}`}>{status.text}</span>
            <span className="muted">
              Versão {draft.version}
              {draft.validatedVersion ? ` · validada: v${draft.validatedVersion}` : ""} · salvo {formatDateTime(draft.updatedAt)}
            </span>
            {dirty && <span className="chip warn">alterações não salvas</span>}
          </div>
          {draft.marketplaceItemId && (
            <div className="toolbar">
              <strong>{draft.marketplaceItemId}</strong>
              {draft.listingStatus && (
                <span className={`chip ${listingStatusLabel(draft.listingStatus).tone}`}>{listingStatusLabel(draft.listingStatus).text}</span>
              )}
              {draft.status === "PUBLISHED" && (draft.listingStatus === "closed" || draft.listingStatus === "deleted") && (
                <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null} onClick={reopenForRepublish}>
                  {busy === "republish" ? "Consultando o Mercado Livre…" : "Preparar nova publicação"}
                </button>
              )}
              {draft.permalink && (
                <a className="btn btn-secondary btn-sm" href={draft.permalink} target="_blank" rel="noopener noreferrer">
                  Abrir no Mercado Livre
                </a>
              )}
            </div>
          )}
        </div>
        <dl className="details">
          <div>
            <dt>Conta de destino</dt>
            <dd>{caps.connected ? `${caps.nickname ?? "—"} (${caps.meliUserId})` : "Não conectada"}</dd>
          </div>
          <div>
            <dt>Modelo de publicação</dt>
            <dd>
              {caps.publicationModel === "USER_PRODUCTS" ? "User Products (family_name)" : caps.publicationModel === "CLASSIC" ? "Clássico (title)" : "Não detectado"}{" "}
              <button className="btn btn-secondary btn-sm" type="button" onClick={refreshCaps} style={{ marginLeft: 6 }}>
                Reconsultar
              </button>
            </dd>
          </div>
          <div>
            <dt>Permissão de escrita</dt>
            <dd>{caps.canWrite ? "Sim (write)" : "Não"}</dd>
          </div>
          <div>
            <dt>Referência interna (SELLER_SKU)</dt>
            <dd>
              <code>ADS-{props.product.adsProductId}</code>
            </dd>
          </div>
        </dl>
        {caps.error && <div className="alert warn" style={{ marginTop: 12 }}>Capacidades da conta: {caps.error}</div>}
        {draft.status === "UNKNOWN" && (
          <div className="alert warn" style={{ marginTop: 12 }}>
            Resultado da publicação ainda não confirmado. O sistema está conferindo no Mercado Livre pelo SELLER_SKU e <strong>não reenviará</strong> o anúncio
            automaticamente. Veja o histórico abaixo.
          </div>
        )}
        {draft.status === "FAILED" && draft.lastError && <div className="alert error" style={{ marginTop: 12 }}>Última falha: {draft.lastError}</div>}
      </section>

      {/* ------------------------------------------------------ identificação */}
      <section className="card">
        <h2>Identificação</h2>
        <dl className="details">
          <div>
            <dt>Produto ADS</dt>
            <dd>
              <a href={`/produtos/${props.product.id}`}>#{props.product.adsProductId}</a> · {props.product.nameOriginal}
            </dd>
          </div>
          <div>
            <dt>EAN</dt>
            <dd>{props.product.ean ?? "—"}</dd>
          </div>
          <div>
            <dt>Código do fabricante</dt>
            <dd>{props.product.manufacturerCode ?? "—"}</dd>
          </div>
          <div>
            <dt>Marca (ADS)</dt>
            <dd>{props.product.brand ?? <span className="muted">vazia na ADS — preencha no atributo Marca</span>}</dd>
          </div>
          <div>
            <dt>Fornecedor</dt>
            <dd>{props.product.supplierName ?? "—"}</dd>
          </div>
          <div>
            <dt>Apresentação</dt>
            <dd>{props.product.presentation ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {/* ------------------------------------------------------ categoria */}
      <CategoryPicker
        draftId={draft.id}
        disabled={locked}
        value={category}
        path={categoryInfo?.path ?? []}
        isLeaf={categoryInfo ? categoryInfo.children === 0 : null}
        issues={blockingByField("category")}
        onChange={(c) => {
          setCategory(c);
          touch();
        }}
      />

      {/* ------------------------------------------------------ atributos */}
      {category && (
        <AttributesForm
          attributes={meliAttrs}
          values={attrs}
          suggestions={suggestions}
          conditional={conditional}
          techGroups={techGroups}
          disabled={locked}
          issues={issues.filter((i) => i.field?.startsWith("attr:"))}
          onChange={setAttr}
        />
      )}

      {/* ------------------------------------------------------ catálogo */}
      <CatalogPanel
        draftId={draft.id}
        disabled={locked}
        selected={catalogProductId}
        catalogListing={catalogListing}
        onSelect={(id, listing) => {
          setCatalogProductId(id);
          setCatalogListing(listing);
          touch();
        }}
      />

      {/* ------------------------------------------------------ comercial */}
      <section className="card">
        <h2>Informações comerciais</h2>
        <div className="form-grid">
          <div>
            <label htmlFor="price-table">Tabela de preço</label>
            <select id="price-table" disabled={locked} value={priceKey} onChange={(e) => (setPriceKey(e.target.value), touch())}>
              <option value="">— sem referência —</option>
              {priceOptions.map((p) => (
                <option key={`${p.code}|${p.branch}`} value={`${p.code}|${p.branch}`}>
                  {p.code} · filial {p.branch} · {formatMoney(p.price)}
                  {p.description ? ` (${p.description})` : ""}
                  {p.code === props.defaultTable ? " — padrão" : ""}
                </option>
              ))}
            </select>
            <p className="hint">Somente preços ativos. Nenhum desconto, comissão ou margem é aplicado automaticamente.</p>
          </div>
          <div>
            <label>Preço de referência</label>
            <p style={{ margin: "8px 0 0", fontWeight: 600 }}>
              {selectedPrice ? `${formatMoney(selectedPrice.price)} — tabela ${selectedPrice.code}${selectedPrice.description ? ` (${selectedPrice.description})` : ""}` : "—"}
            </p>
            <p className="hint">Desconto cadastrado na ADS: {selectedPrice ? formatPercent(selectedPrice.discount) : "—"} (informativo)</p>
          </div>
          <div>
            <label htmlFor="listing-price">Preço final de publicação (R$)</label>
            <input id="listing-price" type="text" inputMode="decimal" disabled={locked} value={listingPrice} placeholder="0,00" onChange={(e) => (setListingPrice(e.target.value), touch())} />
            <p className="hint">
              Valor enviado ao Mercado Livre, confirmado por você.{" "}
              {selectedPrice && !locked && (
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => (setListingPrice(toInputMoney(selectedPrice.price)), touch())}>
                  Copiar referência
                </button>
              )}
            </p>
            <FieldIssues issues={blockingByField("listingPrice")} />
          </div>
          <div>
            <label htmlFor="qty">Quantidade para o anúncio</label>
            <input id="qty" type="number" min={1} step={1} disabled={locked} value={quantity} onChange={(e) => (setQuantity(e.target.value), touch())} />
            <p className="hint">
              Disponível na ADS: {props.stocks.length ? `${formatNumber(stockTotal)} (${props.stocks.map((s) => `filial ${s.branch}: ${formatNumber(s.quantity)}`).join(", ")})` : "desconhecido"}
            </p>
            <FieldIssues issues={blockingByField("listingQuantity")} />
          </div>
          <div>
            <label htmlFor="listing-type">Tipo de anúncio</label>
            <select id="listing-type" disabled={locked || !listingTypes.length} value={listingType} onChange={(e) => (setListingType(e.target.value), touch())}>
              <option value="">{category ? (listingTypes.length ? "Escolha…" : "Indisponível (conta/categoria)") : "Escolha a categoria primeiro"}</option>
              {listingTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.id})
                </option>
              ))}
            </select>
            <FieldIssues issues={blockingByField("listingTypeId")} />
          </div>
          <div>
            <label htmlFor="condition">Condição do produto</label>
            <select id="condition" disabled={locked} value={condition} onChange={(e) => (setCondition(e.target.value), touch())}>
              {((categoryInfo?.settings.item_conditions as string[] | undefined) ?? ["new", "used", "not_specified"]).map((c) => (
                <option key={c} value={c}>
                  {CONDITION_LABEL[c] ?? c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="w-type">Garantia — tipo (opcional)</label>
            <input id="w-type" type="text" list="warranty-types" disabled={locked} value={warrantyType} onChange={(e) => (setWarrantyType(e.target.value), touch())} />
            <datalist id="warranty-types">
              <option value="Garantia do vendedor" />
              <option value="Garantia de fábrica" />
              <option value="Sem garantia" />
            </datalist>
          </div>
          <div>
            <label htmlFor="w-time">Garantia — prazo (opcional)</label>
            <input id="w-time" type="text" placeholder="ex.: 90 dias" disabled={locked} value={warrantyTime} onChange={(e) => (setWarrantyTime(e.target.value), touch())} />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ conteúdo */}
      <section className="card">
        <h2>Conteúdo</h2>
        <div className="form-grid">
          {model === "USER_PRODUCTS" ? (
            <div className="full">
              <label htmlFor="family">Nome da família (family_name) *</label>
              <input id="family" type="text" maxLength={120} disabled={locked} value={familyName} onChange={(e) => (setFamilyName(e.target.value), touch())} />
              <p className={familyName.trim().length > maxTitle ? "hint warn" : "hint"}>
                {familyName.trim().length}/{maxTitle}. Conta no modelo User Products: o campo <code>title</code> não é enviado; o Mercado Livre gera o título a partir da
                família e dos atributos.
              </p>
              <FieldIssues issues={blockingByField("familyName")} />
            </div>
          ) : (
            <div className="full">
              <label htmlFor="title">Título *</label>
              <input id="title" type="text" maxLength={120} disabled={locked} value={title} onChange={(e) => (setTitle(e.target.value), touch())} />
              <p className={title.trim().length > maxTitle ? "hint warn" : "hint"}>
                {title.trim().length}/{maxTitle} caracteres (limite da categoria).
              </p>
              <FieldIssues issues={blockingByField("title")} />
            </div>
          )}
          <div className="full">
            <DescriptionEditor
              value={description}
              disabled={locked}
              adsText={[props.product.nameOriginal, props.product.presentation ? `Apresentação: ${props.product.presentation}` : null].filter(Boolean).join("\n")}
              specs={Object.values(attrs)
                .filter(hasValue)
                .map((a) => {
                  const meta = meliAttrs.find((m) => m.id === a.id);
                  const val = a.value_name ?? meta?.values?.find((v) => v.id === a.value_id)?.name ?? a.values?.map((v) => v.name ?? meta?.values?.find((x) => x.id === v.id)?.name).join(", ");
                  return meta && val && !["GTIN", "SELLER_SKU", "EMPTY_GTIN_REASON"].includes(a.id) ? `${meta.name}: ${val}` : null;
                })
                .filter((x): x is string => Boolean(x))}
              onChange={(v) => (setDescription(v), touch())}
            />
            <FieldIssues issues={blockingByField("description")} />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ imagens */}
      {props.children}

      {/* ------------------------------------------------------ validação */}
      <section className="card" aria-labelledby="validacao">
        <h2 id="validacao">Validação</h2>
        {!draft.validationResult ? (
          <p className="muted">Ainda não validado. A validação combina regras internas, requisitos da categoria, atributos, imagens, conta e a validação oficial do Mercado Livre.</p>
        ) : (
          <>
            <p className="muted">
              Última validação: {formatDateTime(draft.validationResult.checkedAt ?? null)} (versão {draft.validationResult.version}) · validação oficial:{" "}
              {{ ok: "aprovada", ok_warnings: "aprovada com avisos", failed: "recusada", unavailable: "indisponível", skipped: "não executada (há pendências internas)" }[draft.validationResult.remote ?? "skipped"] ??
                draft.validationResult.remote}
              {draft.validationResult.version !== draft.version && <strong> — desatualizada: o rascunho mudou depois.</strong>}
            </p>
            {issues.length === 0 ? (
              <div className="alert success">Nenhuma pendência.</div>
            ) : (
              <ul className="problems">
                {issues.map((i, n) => (
                  <li key={n} className={i.severity === "error" ? "" : "muted"}>
                    <span className={`chip ${i.severity === "error" ? "danger" : "warn"}`}>{i.severity === "error" ? "erro" : "aviso"}</span> <code>{i.code}</code> {i.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}

      <div className="card actions sticky-actions" style={{ marginTop: 0 }}>
        <button className="btn btn-primary" type="button" disabled={locked || busy !== null} onClick={() => save()}>
          {busy === "save" ? "Salvando…" : "Salvar rascunho"}
        </button>
        <button className="btn btn-secondary" type="button" disabled={locked || busy !== null} onClick={validate}>
          {busy === "validate" ? "Validando…" : "Validar anúncio"}
        </button>
        <button className="btn btn-secondary" type="button" disabled={draft.status !== "VALIDATED" || dirty || busy !== null} onClick={openReview}>
          Revisar publicação…
        </button>
        <span className="muted">Salvar e validar não publicam. A publicação só ocorre após revisão e confirmação explícita.</span>
      </div>

      <History draftId={draft.id} status={draft.status} onChange={reload} />

      {review && (
        <ReviewDialog
          data={review}
          draftId={draft.id}
          onClose={() => setReview(null)}
          onPublished={async (msg) => {
            setReview(null);
            setFeedback({ kind: "success", text: msg });
            await reload();
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function FieldIssues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <p className="hint warn" style={{ color: "var(--danger-fg)" }}>
      {issues.map((i) => i.message).join(" ")}
    </p>
  );
}

// ---------------------------------------------------------------------------- categoria

function CategoryPicker(props: {
  draftId: number;
  disabled: boolean;
  value: { id: string; name: string } | null;
  path: { id: string; name: string }[];
  isLeaf: boolean | null;
  issues: Issue[];
  onChange: (c: { id: string; name: string } | null) => void;
}) {
  const [suggestions, setSuggestions] = useState<{ categoryId: string; categoryName: string; domainName: string | null }[] | null>(null);
  const [q, setQ] = useState("");
  const [tree, setTree] = useState<{ parent: { id: string; name: string } | null; path: { id: string; name: string }[]; children: { id: string; name: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function suggest(text?: string) {
    setError(null);
    const r = await api<{ suggestions: { categoryId: string; categoryName: string; domainName: string | null }[] }>(
      text ? `/api/mercadolivre/categories/suggest?q=${encodeURIComponent(text)}` : `/api/mercadolivre/categories/suggest?draftId=${props.draftId}`,
    );
    if (r.ok) setSuggestions(r.data.suggestions);
    else setError(errorText(r));
  }

  async function browse(parent?: string) {
    setError(null);
    const r = await api<NonNullable<typeof tree>>(`/api/mercadolivre/categories${parent ? `?parent=${parent}` : ""}`);
    if (r.ok) setTree(r.data);
    else setError(errorText(r));
  }

  return (
    <section className="card" aria-labelledby="categoria">
      <h2 id="categoria">Categoria do Mercado Livre</h2>
      {props.value ? (
        <p>
          <strong>{props.value.name}</strong> <code>{props.value.id}</code>
          {props.path.length > 0 && <span className="muted"> — {props.path.map((p) => p.name).join(" › ")}</span>}
          {props.isLeaf === false && <span className="chip warn" style={{ marginLeft: 6 }}>possui subcategorias: escolha uma final</span>}
        </p>
      ) : (
        <p className="muted">Nenhuma categoria escolhida. A divisão interna da ADS não é usada como categoria do Mercado Livre.</p>
      )}
      <FieldIssues issues={props.issues} />
      {!props.disabled && (
        <>
          <div className="toolbar">
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => suggest()}>
              Sugerir pelo nome do produto
            </button>
            <input type="search" placeholder="Pesquisar categoria (ex.: oxidante cabelo)" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
            <button className="btn btn-secondary btn-sm" type="button" disabled={q.trim().length < 2} onClick={() => suggest(q.trim())}>
              Pesquisar
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => browse(props.value?.id)}>
              Navegar pela árvore
            </button>
          </div>
          {error && <div className="alert error" style={{ marginTop: 8 }}>{error}</div>}
          {suggestions && (
            <div style={{ marginTop: 10 }}>
              <p className="hint">Sugestões do preditor oficial — a escolha é sua:</p>
              {suggestions.length === 0 && <p className="muted">Nenhuma sugestão.</p>}
              <div className="toolbar">
                {suggestions.map((s) => (
                  <button key={s.categoryId} className="btn btn-secondary btn-sm" type="button" onClick={() => props.onChange({ id: s.categoryId, name: s.categoryName })}>
                    {s.categoryName} <code style={{ marginLeft: 4 }}>{s.categoryId}</code>
                    {s.domainName ? <span className="muted"> · {s.domainName}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          )}
          {tree && (
            <div style={{ marginTop: 10 }}>
              <p className="hint">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => browse()}>
                  Raiz
                </button>{" "}
                {tree.path.map((p) => (
                  <button key={p.id} className="btn btn-secondary btn-sm" type="button" onClick={() => browse(p.id)} style={{ marginRight: 4 }}>
                    {p.name}
                  </button>
                ))}
              </p>
              {tree.parent && (
                <button className="btn btn-primary btn-sm" type="button" onClick={() => props.onChange({ id: tree.parent!.id, name: tree.parent!.name })}>
                  Usar “{tree.parent.name}”
                </button>
              )}
              <div className="toolbar" style={{ marginTop: 8 }}>
                {tree.children.map((c) => (
                  <button key={c.id} className="btn btn-secondary btn-sm" type="button" onClick={() => browse(c.id)}>
                    {c.name} ›
                  </button>
                ))}
                {tree.children.length === 0 && tree.parent && <span className="muted">Categoria final (sem subcategorias).</span>}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- atributos

function parseTechGroups(spec: unknown): { label: string; ids: string[] }[] | null {
  const groups = (spec as { groups?: unknown })?.groups;
  if (!Array.isArray(groups)) return null;
  const out = groups
    .map((g) => {
      const o = g as { label?: unknown; components?: unknown };
      const ids: string[] = [];
      if (Array.isArray(o.components)) {
        for (const c of o.components) {
          const attrs = (c as { attributes?: unknown })?.attributes;
          if (Array.isArray(attrs)) for (const a of attrs) if (typeof (a as { id?: unknown })?.id === "string") ids.push((a as { id: string }).id);
        }
      }
      return { label: typeof o.label === "string" ? o.label : "Ficha técnica", ids };
    })
    .filter((g) => g.ids.length);
  return out.length ? out : null;
}

function AttributesForm(props: {
  attributes: MeliAttribute[];
  values: Record<string, AttrVal>;
  suggestions: Suggestion[];
  conditional: Set<string>;
  techGroups: { label: string; ids: string[] }[] | null;
  disabled: boolean;
  issues: Issue[];
  onChange: (id: string, v: AttrVal | null) => void;
}) {
  const [showOptional, setShowOptional] = useState(false);
  const isRequired = (a: MeliAttribute) => Boolean((a.tags?.required && !a.tags?.hidden) || props.conditional.has(a.id));
  const visible = props.attributes.filter((a) => !a.tags?.read_only && a.id !== "SELLER_SKU" && (!a.tags?.hidden || props.conditional.has(a.id) || props.values[a.id]));
  const required = visible.filter(isRequired);
  const optional = visible.filter((a) => !isRequired(a));
  const issueFor = (id: string) => props.issues.filter((i) => i.field === `attr:${id}`);
  const pendingSuggestions = props.suggestions.filter((s) => !hasValue(props.values[s.id]));

  const groups = useMemo(() => {
    const map = new Map<string, MeliAttribute[]>();
    const order = new Map<string, number>();
    props.techGroups?.forEach((g, i) => g.ids.forEach((id) => order.set(id, i)));
    for (const a of optional) {
      const label = order.has(a.id) ? props.techGroups![order.get(a.id)!].label : a.attribute_group_name ?? "Outros";
      map.set(label, [...(map.get(label) ?? []), a]);
    }
    return [...map.entries()];
  }, [optional, props.techGroups]);

  return (
    <section className="card" aria-labelledby="atributos">
      <div className="status-row">
        <h2 id="atributos">Atributos e especificações técnicas</h2>
        <span className="muted">
          {required.length} obrigatório(s) · {props.attributes.length} no total{props.techGroups ? " · ficha técnica da categoria disponível" : ""}
        </span>
      </div>
      {pendingSuggestions.length > 0 && !props.disabled && (
        <div className="alert warn">
          <strong>Sugestões confiáveis (aplique se estiverem corretas):</strong>
          <ul className="problems">
            {pendingSuggestions.map((s) => (
              <li key={s.id}>
                {s.name}: <strong>{s.value_name ?? s.value_id}</strong> <span className="muted">({s.reason})</span>{" "}
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => props.onChange(s.id, { id: s.id, value_id: s.value_id ?? null, value_name: s.value_name ?? null })}>
                  Aplicar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.attributes.length === 0 && <p className="muted">Carregando atributos da categoria…</p>}
      <div className="form-grid">
        {required.map((a) => (
          <AttributeField key={a.id} attr={a} required value={props.values[a.id]} disabled={props.disabled} issues={issueFor(a.id)} onChange={props.onChange} />
        ))}
      </div>
      {optional.length > 0 && (
        <p style={{ marginTop: 14 }}>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowOptional((v) => !v)}>
            {showOptional ? "Ocultar" : "Mostrar"} {optional.length} atributo(s) opcional(is)
          </button>
        </p>
      )}
      {showOptional &&
        groups.map(([label, list]) => (
          <div key={label} style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 8px" }}>{label}</h3>
            <div className="form-grid">
              {list.map((a) => (
                <AttributeField key={a.id} attr={a} required={false} value={props.values[a.id]} disabled={props.disabled} issues={issueFor(a.id)} onChange={props.onChange} />
              ))}
            </div>
          </div>
        ))}
    </section>
  );
}

function AttributeField(props: { attr: MeliAttribute; required: boolean; value?: AttrVal; disabled: boolean; issues: Issue[]; onChange: (id: string, v: AttrVal | null) => void }) {
  const a = props.attr;
  const v = props.value;
  const id = `attr-${a.id}`;
  const label = (
    <label htmlFor={id} title={a.tooltip ?? a.hint ?? a.id}>
      {a.name}
      {props.required ? " *" : ""} <span className="muted" style={{ fontWeight: 400, fontSize: "0.75rem" }}>{a.id}</span>
    </label>
  );
  const set = (next: Partial<AttrVal> | null) => props.onChange(a.id, next ? { id: a.id, ...next } : null);

  let control: React.ReactNode;
  if ((a.value_type === "list" || a.value_type === "boolean") && a.values?.length && a.tags?.multivalued) {
    const selected = new Set((v?.values ?? []).map((x) => x.id));
    control = (
      <select id={id} multiple disabled={props.disabled} value={[...selected].filter(Boolean) as string[]} onChange={(e) => set({ values: [...e.target.selectedOptions].map((o) => ({ id: o.value })) })} style={{ minHeight: 90 }}>
        {a.values.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    );
  } else if ((a.value_type === "list" || a.value_type === "boolean") && a.values?.length) {
    control = (
      <select id={id} disabled={props.disabled} value={v?.value_id ?? ""} onChange={(e) => set(e.target.value ? { value_id: e.target.value, value_name: a.values!.find((x) => x.id === e.target.value)?.name ?? null } : null)}>
        <option value="">—</option>
        {a.values.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    );
  } else if (a.value_type === "number_unit") {
    const m = v?.value_name?.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
    const num = m?.[1] ?? "";
    const unit = m?.[2] || a.default_unit || a.allowed_units?.[0]?.id || "";
    control = (
      <div className="toolbar" style={{ flexWrap: "nowrap" }}>
        <input id={id} type="text" inputMode="decimal" disabled={props.disabled} value={num} onChange={(e) => set(e.target.value.trim() ? { value_name: `${e.target.value.trim()} ${unit}` } : null)} />
        <select aria-label={`Unidade de ${a.name}`} disabled={props.disabled} value={unit} onChange={(e) => num && set({ value_name: `${num} ${e.target.value}` })} style={{ width: 110 }}>
          {(a.allowed_units ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
    );
  } else {
    const listId = a.values?.length ? `${id}-values` : undefined;
    control = (
      <>
        <input
          id={id}
          type="text"
          inputMode={a.value_type === "number" ? "decimal" : undefined}
          list={listId}
          maxLength={a.value_max_length ?? 255}
          disabled={props.disabled}
          value={v?.value_name ?? ""}
          onChange={(e) => {
            const text = e.target.value;
            const match = a.values?.find((x) => x.name.toLowerCase() === text.trim().toLowerCase());
            set(text.trim() ? { value_name: text, value_id: match?.id ?? null } : null);
          }}
        />
        {listId && (
          <datalist id={listId}>
            {a.values!.map((x) => (
              <option key={x.id} value={x.name} />
            ))}
          </datalist>
        )}
      </>
    );
  }
  return (
    <div>
      {label}
      {control}
      {a.hint && <p className="hint">{a.hint}</p>}
      <FieldIssues issues={props.issues} />
    </div>
  );
}

// ---------------------------------------------------------------------------- catálogo

function CatalogPanel(props: { draftId: number; disabled: boolean; selected: string | null; catalogListing: boolean; onSelect: (id: string | null, listing: boolean) => void }) {
  const [result, setResult] = useState<{ by: string | null; matches: { id: string; name: string; domainId: string | null; brand: string | null; model: string | null; gtins: string[]; status: string | null; attributes: { id: string; name: string; valueName: string | null }[] }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<NonNullable<typeof result>>(`/api/mercadolivre/catalog/matches?draftId=${props.draftId}`);
      if (r.ok) setResult(r.data);
      else setError(errorText(r));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="catalogo">
      <h2 id="catalogo">Catálogo do Mercado Livre</h2>
      <p className="muted">
        Opcional. Procura um produto de catálogo pelo GTIN (ou pelo nome). Nada é vinculado automaticamente: a publicação tradicional é o padrão; a publicação de catálogo só
        ocorre se você marcar abaixo.
      </p>
      {props.selected && props.catalogListing && (
        <div className="alert warn">
          Publicação de catálogo selecionada: <code>{props.selected}</code>{" "}
          {!props.disabled && (
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => props.onSelect(null, false)}>
              Desvincular
            </button>
          )}
        </div>
      )}
      {!props.disabled && (
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={search}>
          {busy ? "Consultando…" : "Buscar correspondência no catálogo"}
        </button>
      )}
      {error && <div className="alert error" style={{ marginTop: 8 }}>{error}</div>}
      {result && (
        <div style={{ marginTop: 10 }}>
          {result.matches.length === 0 ? (
            <p className="muted">Nenhum produto de catálogo encontrado{result.by === "gtin" ? " para o GTIN" : ""}. Publique como anúncio tradicional.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Produto de catálogo</th>
                    <th>Marca / modelo</th>
                    <th>GTIN</th>
                    <th>Domínio</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.name} <code>{m.id}</code>
                        <details className="raw">
                          <summary>atributos</summary>
                          <pre>{m.attributes.map((x) => `${x.name}: ${x.valueName ?? "—"}`).join("\n")}</pre>
                        </details>
                      </td>
                      <td>
                        {m.brand ?? "—"} / {m.model ?? "—"}
                      </td>
                      <td>{m.gtins.join(", ") || "—"}</td>
                      <td>{m.domainId ?? "—"}</td>
                      <td>
                        {!props.disabled && (
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => props.onSelect(m.id, true)}>
                            Publicar como catálogo
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">Busca por {result.by === "gtin" ? "GTIN" : result.by === "q" ? "nome" : "—"}. Confira se é exatamente o mesmo produto antes de vincular.</p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- descrição

function DescriptionEditor(props: { value: string; disabled: boolean; adsText: string; specs: string[]; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => props.onChange(props.value.trim() ? `${props.value.trimEnd()}\n\n${text}` : text);
  return (
    <div>
      <label htmlFor="desc">Descrição comercial (texto simples)</label>
      {!props.disabled && (
        <div className="toolbar" style={{ marginBottom: 6 }}>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => insert(props.adsText)}>
            Inserir descrição da ADS
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={!props.specs.length} onClick={() => insert(`Características:\n${props.specs.map((s) => `- ${s}`).join("\n")}`)}>
            Inserir ficha técnica ({props.specs.length})
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPreview((v) => !v)}>
            {preview ? "Editar" : "Pré-visualizar"}
          </button>
        </div>
      )}
      {preview ? (
        <div className="card" style={{ whiteSpace: "pre-wrap", background: "var(--bg)", marginBottom: 0 }}>
          {props.value || <span className="muted">(vazia)</span>}
        </div>
      ) : (
        <textarea ref={area} id="desc" disabled={props.disabled} value={props.value} maxLength={50_000} onChange={(e) => props.onChange(e.target.value)} style={{ minHeight: 180 }} />
      )}
      <p className="hint">
        {props.value.length} caracteres. Não inclua benefícios, composição, certificações ou informações regulatórias que não estejam confirmados. Sem HTML, links ou contatos.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------- revisão e confirmação

interface ReviewData {
  review: {
    draftVersion: number;
    product: { adsProductId: number; name: string };
    model: string;
    titleField: string;
    title: string | null;
    categoryId: string | null;
    categoryName: string | null;
    price: string | null;
    currency: string;
    quantity: number | null;
    listingTypeId: string | null;
    condition: string | null;
    catalogProductId: string | null;
    sellerSku: string;
    images: { id: number; url: string; primary: boolean }[];
    attributes: AttrVal[];
    account: { meliUserId: string | null; nickname: string | null };
    payload: unknown;
  };
  fingerprint: string;
  publishable: boolean;
  reason: string | null;
}

function ReviewDialog(props: { data: ReviewData; draftId: number; onClose: () => void; onPublished: (msg: string) => void }) {
  const r = props.data.review;
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ job: { id: string }; replayed: boolean }>(`/api/listing-drafts/${props.draftId}/publish`, {
        body: { confirm: true, draftVersion: r.draftVersion, fingerprint: props.data.fingerprint },
      });
      if (!res.ok) return setError(errorText(res));
      props.onPublished(
        res.data.replayed
          ? "Esta publicação já havia sido solicitada; acompanhando o mesmo pedido (sem duplicar)."
          : "Publicação solicitada. O envio ao Mercado Livre está em andamento; o resultado aparecerá aqui quando a API responder.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="review-title" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}>
      <div className="card" style={{ maxWidth: 720, width: "100%", maxHeight: "90vh", overflow: "auto", marginBottom: 0 }}>
        <h2 id="review-title">Confirmar publicação no Mercado Livre</h2>
        {!props.data.publishable && <div className="alert error">{props.data.reason}</div>}
        <dl className="details">
          <div>
            <dt>Produto</dt>
            <dd>
              #{r.product.adsProductId} · {r.product.name}
            </dd>
          </div>
          <div>
            <dt>{r.titleField === "family_name" ? "Nome da família" : "Título"}</dt>
            <dd>{r.title ?? "—"}</dd>
          </div>
          <div>
            <dt>Categoria</dt>
            <dd>
              {r.categoryName ?? "—"} <code>{r.categoryId}</code>
            </dd>
          </div>
          <div>
            <dt>Preço final</dt>
            <dd>{formatMoney(r.price)}</dd>
          </div>
          <div>
            <dt>Quantidade</dt>
            <dd>{r.quantity ?? "—"}</dd>
          </div>
          <div>
            <dt>Tipo de anúncio / condição</dt>
            <dd>
              {r.listingTypeId ?? "—"} / {CONDITION_LABEL[r.condition ?? ""] ?? r.condition}
            </dd>
          </div>
          <div>
            <dt>Conta de destino</dt>
            <dd>
              <strong>{r.account.nickname ?? "—"}</strong> ({r.account.meliUserId ?? "—"})
            </dd>
          </div>
          <div>
            <dt>Modelo / SELLER_SKU</dt>
            <dd>
              {r.model} / <code>{r.sellerSku}</code>
            </dd>
          </div>
          {r.catalogProductId && (
            <div>
              <dt>Catálogo</dt>
              <dd>
                <code>{r.catalogProductId}</code>
              </dd>
            </div>
          )}
        </dl>
        <div className="gallery" style={{ marginTop: 12, gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))" }}>
          {r.images.map((i) => (
            <figure key={i.id} className={i.primary ? "primary" : undefined}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={i.url} alt="" />
            </figure>
          ))}
        </div>
        <details className="raw" style={{ marginTop: 12 }}>
          <summary>Dados que serão enviados (payload)</summary>
          <pre>{JSON.stringify(r.payload, null, 2)}</pre>
        </details>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14, fontWeight: 500 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 4 }} />
          Confirmo a criação deste anúncio na conta {r.account.nickname ?? r.account.meliUserId} com os dados acima (versão {r.draftVersion}).
        </label>
        {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
        <div className="actions">
          <button className="btn btn-primary" type="button" disabled={!confirmed || !props.data.publishable || busy} onClick={publish}>
            {busy ? "Enviando…" : "Publicar no Mercado Livre"}
          </button>
          <button className="btn btn-secondary" type="button" onClick={props.onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- histórico

interface JobRow {
  id: string;
  status: string;
  draftVersion: number;
  attemptCount: number;
  reconcileCount: number;
  marketplaceItemId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
}

function History(props: { draftId: number; status: string; onChange: () => Promise<void> }) {
  const [data, setData] = useState<{ events: { id: string; eventType: string; previousStatus: string | null; newStatus: string | null; createdAt: string; details: unknown }[]; jobs: JobRow[] } | null>(null);
  const [attempts, setAttempts] = useState<Record<string, { operation: string; httpStatus: number | null; errorCode: string | null; errorMessage: string | null; createdAt: string; sanitizedResponse: unknown }[]>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<NonNullable<typeof data>>(`/api/listing-drafts/${props.draftId}/history`);
    if (r.ok) setData(r.data);
  }, [props.draftId]);
  useEffect(() => {
    void load();
  }, [load, props.status]);

  async function showAttempts(jobId: string) {
    const r = await api<{ attempts: (typeof attempts)[string] }>(`/api/marketplace/publication-jobs/${jobId}/attempts`);
    if (r.ok) setAttempts((prev) => ({ ...prev, [jobId]: r.data.attempts }));
  }

  async function act(job: JobRow, action: "recheck" | "not_created" | "cancel") {
    if (action === "not_created" && !window.confirm("Confirma que conferiu no Mercado Livre e o anúncio NÃO foi criado? O rascunho poderá ser validado e publicado de novo.")) return;
    setBusy(true);
    setMsg(null);
    try {
      const r =
        action === "cancel"
          ? await api(`/api/marketplace/publication-jobs/${job.id}/cancel`, { body: {} })
          : await api<{ job: JobRow }>(`/api/marketplace/publication-jobs/${job.id}/reconcile`, { body: action === "recheck" ? { resolution: "recheck" } : { resolution: "not_created", confirm: true } });
      setMsg(r.ok ? "Atualizado." : errorText(r));
      await load();
      await props.onChange();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  return (
    <section className="card" aria-labelledby="historico">
      <h2 id="historico">Histórico e auditoria</h2>
      {msg && <div className="alert warn">{msg}</div>}
      {data.jobs.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Publicação</th>
                <th>Situação</th>
                <th>Versão</th>
                <th>Tentativas</th>
                <th>Anúncio</th>
                <th>Erro</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => {
                const s = PUBLICATION_JOB_LABEL[j.status] ?? { text: j.status, tone: "" };
                return (
                  <tr key={j.id}>
                    <td>
                      {formatDateTime(j.createdAt)}
                      <small className="muted" style={{ display: "block" }}>
                        {j.requestedBy}
                      </small>
                    </td>
                    <td>
                      <span className={`chip ${s.tone}`}>{s.text}</span>
                    </td>
                    <td>v{j.draftVersion}</td>
                    <td>
                      {j.attemptCount} envio(s) · {j.reconcileCount} conferência(s)
                    </td>
                    <td>{j.marketplaceItemId ?? "—"}</td>
                    <td style={{ maxWidth: 320 }}>{j.errorMessage ?? "—"}</td>
                    <td>
                      <div className="toolbar">
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => showAttempts(j.id)}>
                          Tentativas
                        </button>
                        {j.status === "QUEUED" && (
                          <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => act(j, "cancel")}>
                            Cancelar
                          </button>
                        )}
                        {j.status === "UNKNOWN" && (
                          <>
                            <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => act(j, "recheck")}>
                              Conferir no ML agora
                            </button>
                            {j.reconcileCount >= 1 && (
                              <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => act(j, "not_created")}>
                                Confirmo que não foi criado
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {attempts[j.id] && (
                        <ul className="problems">
                          {attempts[j.id].map((a, i) => (
                            <li key={i}>
                              {formatDateTime(a.createdAt)} · <code>{a.operation}</code> · HTTP {a.httpStatus ?? "—"} {a.errorCode ? `· ${a.errorCode}` : ""}{" "}
                              {a.errorMessage ? `· ${a.errorMessage}` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ul className="problems">
        {data.events.map((e) => (
          <li key={e.id}>
            {formatDateTime(e.createdAt)} · <code>{e.eventType}</code>
            {e.previousStatus || e.newStatus ? ` · ${e.previousStatus ?? "—"} → ${e.newStatus ?? "—"}` : ""}
          </li>
        ))}
        {data.events.length === 0 && <li className="muted">Sem eventos.</li>}
      </ul>
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";

interface Option {
  code: string;
  label: string;
  inactive?: boolean;
  extra?: Record<string, unknown>;
}

interface Options {
  environment: { host: string; environment: string; writeAllowed: boolean };
  cnpjDistribuidora: string;
  operacoes: Option[];
  origens: Option[];
  formasDePagamento: Option[];
  prazos: (Option & { parcelas: number; dias: number[] })[];
  representantes: Option[];
  classes: Option[];
  setores: Option[];
  setoresComplete: boolean;
  tabelas: Option[];
  errors: Record<string, string>;
}

interface Settings {
  operacaoId: string;
  canalId: string;
  formaDePagamentoId: string;
  prazoId: string;
  representanteId: string | null;
  tabela: string;
  categoriaItem: string;
  freightMode: "none" | "buyer_paid";
  discountMode: "none" | "coupon";
  itemPriceMode: "sale_price" | "ads_table";
  dueDateBase: "payment_approved" | "order_date";
  customerSetorId: string | null;
  customerClasseId: string | null;
  customerDefaultPhone: string | null;
  customerDefaultEmail: string | null;
}

const EMPTY: Settings = {
  operacaoId: "",
  canalId: "",
  formaDePagamentoId: "",
  prazoId: "",
  representanteId: null,
  tabela: "",
  categoriaItem: "",
  freightMode: "none",
  discountMode: "none",
  itemPriceMode: "sale_price",
  dueDateBase: "payment_approved",
  customerSetorId: null,
  customerClasseId: null,
  customerDefaultPhone: null,
  customerDefaultEmail: null,
};

function Select(props: { label: string; value: string | null; options: Option[]; onChange: (v: string) => void; optional?: boolean; hint?: string; error?: string }) {
  return (
    <div className="field">
      <label>{props.label}</label>
      <select value={props.value ?? ""} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{props.optional ? "— nenhum —" : "— selecione —"}</option>
        {props.options.map((o) => (
          <option key={o.code} value={o.code} disabled={o.inactive}>
            {o.code} · {o.label}
            {o.inactive ? " (inativo)" : ""}
          </option>
        ))}
      </select>
      {props.hint && <small className="hint">{props.hint}</small>}
      {props.error && <small className="hint" style={{ color: "var(--danger-fg)" }}>{props.error}</small>}
    </div>
  );
}

export function CommercialSettingsForm() {
  const [options, setOptions] = useState<Options | null>(null);
  const [form, setForm] = useState<Settings>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await api<{ settings: Settings | null; options: Options }>("/api/ads/order-settings");
      if (!r.ok) return setLoadError(errorText(r));
      setOptions(r.data.options);
      if (r.data.settings) setForm(r.data.settings);
    })();
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setMsg(null);
    setErrors({});
    const r = await api<{ settings: Settings }>("/api/ads/order-settings", { method: "PUT", body: { ...form, representanteId: form.representanteId || null, customerSetorId: form.customerSetorId || null, customerClasseId: form.customerClasseId || null, customerDefaultPhone: form.customerDefaultPhone?.replace(/\D/g, "") || null, customerDefaultEmail: form.customerDefaultEmail?.trim() || null } });
    setBusy(false);
    if (!r.ok) {
      setErrors(Object.fromEntries((r.data.issues ?? []).map((i) => [i.path, i.message])));
      return setMsg({ kind: "error", text: errorText(r) });
    }
    setMsg({ kind: "success", text: "Configuração salva e validada contra a ADS." });
  }

  if (loadError) return <div className="alert error">Não foi possível consultar a ADS: {loadError}</div>;
  if (!options) return <div className="card">Consultando códigos na ADS…</div>;
  const prazo = options.prazos.find((p) => p.code === form.prazoId);

  return (
    <>
      <div className={`alert ${options.environment.writeAllowed ? "warn" : "error"}`}>
        ADS: <strong>{options.environment.host}</strong> ({options.environment.environment}) · CNPJ distribuidora {options.cnpjDistribuidora} ·{" "}
        {options.environment.writeAllowed ? "envio de pedidos permitido (homologação)" : "envio de pedidos BLOQUEADO neste ambiente"}
      </div>
      {Object.keys(options.errors).length > 0 && (
        <div className="alert error">
          Falha ao consultar: {Object.entries(options.errors).map(([k, v]) => `${k} (${v})`).join(", ")}
        </div>
      )}
      <section className="card">
        <h2>Pedido</h2>
        <div className="form-grid">
          <Select label="Operação comercial" value={form.operacaoId} options={options.operacoes} onChange={(v) => set("operacaoId", v)} error={errors.operacaoId} />
          <Select label="Origem do pedido (canal)" value={form.canalId} options={options.origens} onChange={(v) => set("canalId", v)} error={errors.canalId} />
          <Select label="Forma de pagamento" value={form.formaDePagamentoId} options={options.formasDePagamento} onChange={(v) => set("formaDePagamentoId", v)} error={errors.formaDePagamentoId} />
          <Select
            label="Prazo"
            value={form.prazoId}
            options={options.prazos}
            onChange={(v) => set("prazoId", v)}
            error={errors.prazoId}
            hint={prazo ? `${prazo.parcelas || 1} parcela(s): ${prazo.dias.length ? prazo.dias.join(", ") : "0"} dia(s)` : undefined}
          />
          <Select label="Representante (se exigido)" value={form.representanteId} options={options.representantes} onChange={(v) => set("representanteId", v || null)} optional error={errors.representanteId} />
          <Select label="Tabela de preço (1 caractere)" value={form.tabela} options={options.tabelas} onChange={(v) => set("tabela", v)} error={errors.tabela} />
          <div className="field">
            <label>Categoria do item (1 caractere)</label>
            <input value={form.categoriaItem} maxLength={1} onChange={(e) => set("categoriaItem", e.target.value.toUpperCase())} />
            <small className="hint">Campo exigido pela API de pedidos sem descrição no contrato: confirme o valor com a Tecdisa.</small>
            {errors.categoriaItem && <small className="hint" style={{ color: "var(--danger-fg)" }}>{errors.categoriaItem}</small>}
          </div>
        </div>
      </section>
      <section className="card">
        <h2>Frete, descontos e conciliação</h2>
        <div className="form-grid">
          <div className="field">
            <label>Frete</label>
            <select value={form.freightMode} onChange={(e) => set("freightMode", e.target.value as Settings["freightMode"])}>
              <option value="none">Não informar (frete pago pelo vendedor / Mercado Envios)</option>
              <option value="buyer_paid">Valor de frete pago pelo comprador</option>
            </select>
          </div>
          <div className="field">
            <label>Desconto do pedido</label>
            <select value={form.discountMode} onChange={(e) => set("discountMode", e.target.value as Settings["discountMode"])}>
              <option value="none">Não informar</option>
              <option value="coupon">Cupom aplicado no pedido do ML</option>
            </select>
          </div>
          <div className="field">
            <label>Preço de tabela dos itens</label>
            <select value={form.itemPriceMode} onChange={(e) => set("itemPriceMode", e.target.value as Settings["itemPriceMode"])}>
              <option value="sale_price">Preço vendido no ML (desconto 0%)</option>
              <option value="ads_table">Preço da tabela ADS (desconto = diferença)</option>
            </select>
          </div>
          <div className="field">
            <label>Base dos vencimentos</label>
            <select value={form.dueDateBase} onChange={(e) => set("dueDateBase", e.target.value as Settings["dueDateBase"])}>
              <option value="payment_approved">Data de aprovação do pagamento</option>
              <option value="order_date">Data da venda</option>
            </select>
          </div>
        </div>
        <p className="muted">O preço unitário enviado é sempre o efetivamente vendido no Mercado Livre; o total é validado contra o pedido antes do envio.</p>
      </section>
      <section className="card">
        <h2>Cadastro de cliente novo (homologação)</h2>
        <div className="form-grid">
          {options.setores.length > 0 ? (
            <Select
              label="Setor (setorId)"
              value={form.customerSetorId}
              options={options.setores}
              onChange={(v) => set("customerSetorId", v || null)}
              optional
              error={errors.customerSetorId}
              hint={`Setores em uso pelos clientes desta ADS (${options.environment.environment})${options.setoresComplete ? "" : " — lista parcial"}. A API não tem consulta própria de setores.`}
            />
          ) : (
            <div className="field">
              <label>Setor (setorId)</label>
              <input value={form.customerSetorId ?? ""} maxLength={10} onChange={(e) => set("customerSetorId", e.target.value || null)} />
              <small className="hint">Nenhum setor encontrado nos clientes desta ADS: informe um código existente neste ambiente.</small>
              {errors.customerSetorId && <small className="hint" style={{ color: "var(--danger-fg)" }}>{errors.customerSetorId}</small>}
            </div>
          )}
          <Select label="Classe (classeId)" value={form.customerClasseId} options={options.classes} onChange={(v) => set("customerClasseId", v || null)} optional error={errors.customerClasseId} />
          <div className="field">
            <label>Telefone padrão da loja</label>
            <input value={form.customerDefaultPhone ?? ""} inputMode="tel" maxLength={15} placeholder="DDD + número" onChange={(e) => set("customerDefaultPhone", e.target.value || null)} />
            <small className="hint">A ADS exige telefone e o Mercado Livre não informa o do comprador: use o telefone de contato da loja. Fica registrado no cadastro.</small>
            {errors.customerDefaultPhone && <small className="hint" style={{ color: "var(--danger-fg)" }}>{errors.customerDefaultPhone}</small>}
          </div>
          <div className="field">
            <label>E-mail padrão da loja (opcional)</label>
            <input type="email" value={form.customerDefaultEmail ?? ""} maxLength={120} onChange={(e) => set("customerDefaultEmail", e.target.value || null)} />
            <small className="hint">Usado se a ADS exigir e-mail (o ML também não informa o do comprador).</small>
            {errors.customerDefaultEmail && <small className="hint" style={{ color: "var(--danger-fg)" }}>{errors.customerDefaultEmail}</small>}
          </div>
        </div>
      </section>
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      <button className="btn btn-primary" type="button" disabled={busy} onClick={save}>
        {busy ? "Validando na ADS…" : "Salvar configuração"}
      </button>
    </>
  );
}

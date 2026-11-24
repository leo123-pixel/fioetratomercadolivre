# Pedidos Nuvemshop → ADS

Envio **manual**, um pedido por vez, com as mesmas travas do envio Mercado Livre → ADS. Nada vai para a ADS por
webhook ou rotina automática.

## Antes do primeiro envio

1. **Configuração comercial da Nuvemshop**: Configurações › Pedidos ADS › aba **Nuvemshop**
   (`/configuracoes/pedidos-ads?canal=nuvemshop`). É separada da do Mercado Livre e por ambiente. Sem configuração,
   o formulário vem preenchido com a do ML e a tabela **F**. Revise principalmente a **origem do pedido (canal)**, a
   **operação** e a **forma de pagamento** da loja, e salve (os códigos são validados na ADS).
   - Frete "pago pelo comprador" + desconto "descontos do pedido" → total ADS = total pago na loja (conferido).
2. **Vínculos**: cada variante vendida precisa de vínculo CONFIRMADO com um produto ADS (Nuvemshop › Vinculação ADS).
   Kit (composição) bloqueia o envio: lance no ADSNET.

## Na tela do pedido (Nuvemshop › Pedidos → ADS › pedido)

1. **Reler pedido na Nuvemshop**: lê valores (subtotal, descontos, frete, total, data do pagamento), preço de cada
   linha e os dados do comprador (CPF/CNPJ, nome, endereço de cobrança, telefone, e-mail). Já consulta o cliente na ADS.
   - Frete do comprador: na API 2025-03 o pedido não traz esse valor; ele vem do `consumer_cost` dos fulfillment
     orders (`aggregates=fulfillment_orders`). Sem isso, usa a identidade documentada total = subtotal − desconto +
     frete. O campo `discount` já é o desconto total (cupom e meio de pagamento estão dentro dele).
   - A Nuvemshop recusa `shipping_cost_customer` no filtro `fields` (500/404): não acrescente campos ao filtro sem
     testar.
2. **Cliente ADS**: encontrado pelo CPF/CNPJ (o mesmo cadastro usado pelo ML). Se não existir, o cadastro é preparado
   com o telefone do comprador (o telefone padrão da loja só entra se a Nuvemshop não informar) e exige digitar
   CADASTRAR. A ADS cria clientes da API como inativos: ative no ADSNET.
3. **Validação**: bloqueia pagamento não confirmado (`payment_status` ≠ `paid`), pedido cancelado, item sem vínculo,
   kit, soma dos itens ≠ subtotal, total ADS ≠ total pago (com frete + desconto configurados), prazo inexistente,
   e pedido cuja baixa já foi confirmada à mão ("Baixa ADS confirmada").
4. **Prévia** do payload (documento mascarado) e **envio** digitando ENVIAR (homologação) ou ENVIAR PRODUCAO.
   Produção exige `ADS_PRODUCTION_WRITE_ENABLED=true`.

Identificação na ADS: `idExterno` = `N` + id do pedido Nuvemshop; `pedidoCliente` = número do pedido na loja (#);
`observacao` = "Nuvemshop #número".

## Garantias

- Antes do POST consulta `GET /pedidos/{idExterno}`: se já existe, só registra (sem duplicar).
- Timeout/5xx = resultado incerto (UNKNOWN): nunca reenvia sozinho; "Conciliar pelo idExterno" resolve.
- 4xx = FAILED com a resposta registrada; pode enviar de novo depois de corrigir.
- O payload enviado é o mesmo que o operador conferiu (hash).
- Estoque: cada mudança do envio vira fato no Inventory Core (canal nuvemshop). Pela política padrão, pedido criado
  na ADS **não** comprova a baixa — o compromisso segue descontado até a situação do pedido na ADS estar em
  `adsReflectedStatuses` (ex.: "Faturado", via "Consultar resultado na ADS") ou a política
  `adsDeductsOnOrderCreated` estar ligada. Nunca há baixa dupla.

## Dados pessoais

Os dados do comprador só são lidos quando o operador clica em "Reler pedido na Nuvemshop" e ficam em
`nuvemshop_order_billing`. `customers/redact` apaga os dos pedidos indicados; `store/redact` apaga todos da loja;
`customers/data_request` registra no log quantos pedidos têm dados guardados (atendimento manual). O histórico de
envios guarda o documento mascarado.

## Tabelas (migração 20261124000000_nuvemshop_ads_orders)

- `nuvemshop_orders`: novas colunas de valores (subtotal, discount, discount_coupon, discount_gateway,
  shipping_cost_customer, total, currency, gateway, paid_at).
- `nuvemshop_order_billing`, `nuvemshop_ads_submissions`, `nuvemshop_ads_attempts` (separadas das tabelas do ML).

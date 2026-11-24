import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/page-guard";
import { NuvemshopTabs } from "../../NuvemshopTabs";
import { PageProblem } from "../../../PageProblem";
import { NsAdsPanel } from "./NsAdsPanel";

export const dynamic = "force-dynamic";

export default async function NuvemshopPedidoPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if ((await requireAdminPage(`/nuvemshop/pedidos/${orderId}`)) === "config") return <PageProblem kind="config" />;
  if (!/^\d{1,20}$/.test(orderId)) notFound();
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › <a href="/nuvemshop/pedidos">Pedidos → ADS</a> › {orderId}
      </p>
      <div className="page-head">
        <h1>Pedido Nuvemshop → ADS</h1>
        <span className="muted">Conferência e envio manual</span>
      </div>
      <NuvemshopTabs current="orders" />
      <NsAdsPanel orderId={orderId} />
    </>
  );
}

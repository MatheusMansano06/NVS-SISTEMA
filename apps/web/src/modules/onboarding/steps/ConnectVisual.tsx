/** Ilustração da conexão NVS Tech ⇄ Mercado Livre (pontos fluindo entre as marcas). */
export function ConnectVisual() {
  return (
    <div className="connect" aria-hidden="true">
      <span className="connect-node connect-nvs">
        <img src="/nvs-logo.webp" alt="" />
      </span>
      <span className="connect-wire">
        <i /><i /><i />
      </span>
      <span className="connect-node connect-ml">
        <img src="/marketplaces/mercado-livre.svg" alt="" />
      </span>
    </div>
  );
}

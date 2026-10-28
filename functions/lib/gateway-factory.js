/**
 * Factory para carregar gateways de pagamento
 *
 * Permite registrar e carregar diferentes implementações de gateway
 * Facilita a troca dinâmica entre provedores
 */

const credentials = require("../credentials");

// Registro de gateways disponíveis
const gateways = new Map();

/**
 * Registra uma implementação de gateway
 */
function registerGateway(name, GatewayClass) {
  gateways.set(name.toLowerCase(), GatewayClass);
  console.log(`[GatewayFactory] ✓ Gateway registrado: ${name}`);
}

/**
 * Carrega a instância do gateway configurado
 */
function getGateway() {
  const gatewayName = (credentials.PAYMENT_GATEWAY || "").toLowerCase();

  if (!gatewayName || gatewayName === "not_configured") {
    throw new Error(
      "❌ PAYMENT_GATEWAY não configurado. " +
      "Configure a variável de ambiente PAYMENT_GATEWAY com o nome do gateway a usar."
    );
  }

  const GatewayClass = gateways.get(gatewayName);
  if (!GatewayClass) {
    throw new Error(
      `❌ Gateway '${gatewayName}' não encontrado. ` +
      `Gateways disponíveis: ${Array.from(gateways.keys()).join(", ")}`
    );
  }

  return new GatewayClass({
    apiKey: credentials.GATEWAY_API_KEY,
    apiSecret: credentials.GATEWAY_API_SECRET,
    webhookSecret: credentials.GATEWAY_WEBHOOK_SECRET,
  });
}

/**
 * Lista gateways disponíveis
 */
function listGateways() {
  return Array.from(gateways.keys());
}

// Registra gateways disponíveis
registerGateway("gorillapay", require("../gateways/gorillapay"));

module.exports = {
  registerGateway,
  getGateway,
  listGateways,
};

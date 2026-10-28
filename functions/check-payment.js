const { getGateway } = require("./lib/gateway-factory");
const credentials = require("./credentials");

const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN || credentials.UTMIFY_TOKEN;

async function sendUtmifyPaid(txData, transactionId, gatewayName) {
  try {
    // `transactions.amount` é gravado em REAIS por functions/pix.js
    const amountCents = Math.round(Number(txData.amount || 67.7) * 100);
    const gatewayFeeCents = Math.round(amountCents * 0.02);
    const payload = {
      orderId: transactionId,
      platform: gatewayName || "PaymentGateway",
      paymentMethod: "pix",
      status: "paid",
      createdAt: (txData.created_at || new Date().toISOString()).replace("T", " ").slice(0, 19),
      approvedDate: new Date().toISOString().replace("T"," ").slice(0,19),
      customer: {
        name: txData.customer_name || null,
        email: txData.customer_email || null,
        phone: txData.customer_phone || null,
        document: txData.customer_cpf || null,
        country: "BR",
        ip: "177.0.0.1"
      },
      products: [{
        id: "loja-shopify-br-001",
        name: "SHOPIFY LOJA 03",
        quantity: 1,
        priceInCents: amountCents,
      }],
      trackingParameters: {
        utm_source: txData.utm_source || null,
        utm_campaign: txData.utm_campaign || null,
        utm_medium: txData.utm_medium || null,
      },
      commission: {
        totalPriceInCents: amountCents,
        gatewayFeeInCents: gatewayFeeCents,
        userCommissionInCents: amountCents - gatewayFeeCents,
        currency: "BRL"
      },
    };
    
    await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${UTMIFY_TOKEN}` },
      body: JSON.stringify(payload)
    });
  } catch(err) {
    console.error("[UTMify]", err);
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: ""
    };
  }

  // Carrega o gateway
  let gateway;
  try {
    gateway = getGateway();
  } catch (err) {
    console.error("[CheckPayment] Erro ao carregar gateway:", err.message);
    return jsonResponse(500, {
      success: false,
      error: "Gateway não configurado",
      debug: err.message
    });
  }

  let transactionId = event.queryStringParameters?.id || event.queryStringParameters?.transactionId;
  if (event.httpMethod === "POST") {
    try {
      const b = event.body ? JSON.parse(event.body) : {};
      transactionId = b?.transactionId || b?.id || transactionId;
    } catch {}
  }
  if (!transactionId) {
    return jsonResponse(400, { success: false, error: "Informe o transactionId" });
  }

  let gatewayResponse;
  try {
    gatewayResponse = await gateway.checkTransactionStatus(transactionId);
  } catch (err) {
    console.error("[CheckPayment] Erro ao consultar gateway:", err.message);
    return jsonResponse(502, {
      success: false,
      error: "Falha ao consultar status: " + String(err),
      debug: err.message
    });
  }

  const paid = gatewayResponse.paid || false;
  const status = gatewayResponse.status || "pending";

  // Sem banco, o aviso de "pago" é montado com o que o próprio gateway
  // devolveu na consulta — não há mais registro local para ler.
  //
  // ATENÇÃO: também não há como saber se este PIX já foi avisado antes. O
  // funil consulta esta rota em laço enquanto a tela de pagamento está aberta,
  // então um PIX pago dispara o evento a cada consulta. A deduplicação, agora,
  // é por `orderId` do lado da UTMify.
  if (paid) {
    try {
      const cliente = gatewayResponse.customer || {};
      await sendUtmifyPaid(
        {
          amount: gatewayResponse.amount ?? null,
          created_at: gatewayResponse.createdAt || null,
          customer_name: cliente.name || null,
          customer_email: cliente.email || null,
          customer_phone: cliente.phone || null,
          customer_cpf: cliente.document || cliente.cpf || null,
        },
        transactionId,
        gateway.name
      );
    } catch (err) {
      console.error("[UTMify] Erro ao avisar pagamento (continuando):", err.message);
    }
  }

  return jsonResponse(200, {
    success: true,
    transactionId,
    status,
    paid
  });
};

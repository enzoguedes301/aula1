const { getGateway } = require("./lib/gateway-factory");
const credentials = require("./credentials");

const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN || credentials.UTMIFY_TOKEN;

// Cache UTMify
const utmifyCache = new Map();
const CACHE_TTL = 60000;

async function sendUtmify(transactionId, status, customer, amountCents, createdAt, utms, gatewayName) {
  if (utmifyCache.has(transactionId)) {
    console.log("[UTMify] Skipping duplicate for:", transactionId);
    return;
  }

  utmifyCache.set(transactionId, true);
  setTimeout(() => utmifyCache.delete(transactionId), CACHE_TTL);

  try {
    const gatewayFeeCents = Math.round(amountCents * 0.02);
    const netCents = amountCents - gatewayFeeCents;
    const payload = {
      orderId: transactionId,
      platform: gatewayName || "PaymentGateway",
      paymentMethod: "pix",
      status,
      createdAt: createdAt || new Date().toISOString().replace("T"," ").slice(0,19),
      approvedDate: status === "paid" ? new Date().toISOString().replace("T"," ").slice(0,19) : null,
      customer: {
        name: customer.name || null,
        email: customer.email || null,
        phone: customer.phone || null,
        document: customer.cpf || null,
        country: "BR",
        ip: "177.0.0.1",
      },
      products: [{
        id: "loja-shopify-br-001",
        name: "SHOPIFY LOJA 03",
        quantity: 1,
        priceInCents: amountCents,
      }],
      trackingParameters: {
        utm_source: utms?.utm_source || null,
        utm_campaign: utms?.utm_campaign || null,
        utm_medium: utms?.utm_medium || null,
        utm_content: utms?.utm_content || null,
        utm_term: utms?.utm_term || null,
      },
      commission: {
        totalPriceInCents: amountCents,
        gatewayFeeInCents: gatewayFeeCents,
        userCommissionInCents: netCents,
        currency: "BRL",
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${UTMIFY_TOKEN}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    console.log("[UTMify] ✓ Enviado para:", transactionId);
  } catch (err) {
    console.error("[UTMify] Erro (não bloqueia):", err.message);
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
    body: JSON.stringify(body),
  };
}

function gerarCpfValido() {
  // Gera um CPF válido aleatório
  let cpf = '';
  
  // Gera os primeiros 9 dígitos aleatoriamente
  for (let i = 0; i < 9; i++) {
    cpf += Math.floor(Math.random() * 10);
  }
  
  // Calcula o primeiro dígito verificador
  let soma = 0;
  let multiplicador = 10;
  for (let i = 0; i < 9; i++) {
    soma += parseInt(cpf[i]) * multiplicador;
    multiplicador--;
  }
  let resto = soma % 11;
  let primeiroDigito = resto < 2 ? 0 : 11 - resto;
  
  // Calcula o segundo dígito verificador
  cpf += primeiroDigito;
  soma = 0;
  multiplicador = 11;
  for (let i = 0; i < 10; i++) {
    soma += parseInt(cpf[i]) * multiplicador;
    multiplicador--;
  }
  resto = soma % 11;
  let segundoDigito = resto < 2 ? 0 : 11 - resto;
  
  cpf += segundoDigito;
  return cpf;
}

function fmtPhone(phone) {
  if (!phone) return "11999999999";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) return digits;
  if (digits.length === 10) return digits;
  return digits;
}

exports.handler = async (event) => {
  console.log("[PIX] ===== FUNÇÃO INICIADA =====");

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: "",
    };
  }

  // Carrega o gateway configurado
  let gateway;
  try {
    gateway = getGateway();
    console.log(`[PIX] ✓ Gateway carregado: ${gateway.name}`);
  } catch (err) {
    console.error("❌ [PIX] Erro ao carregar gateway:", err.message);
    return jsonResponse(500, {
      success: false,
      error: "Gateway de pagamento não configurado",
      debug: err.message
    });
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }

  const randId = Math.random().toString(36).slice(2, 10);

  // Calcula o amount baseado na requisição
  let amountReais = 67.70; // Valor padrão
  const rawAmount = body.amount ?? body.valor ?? body.total;
  if (rawAmount) {
    const n = Number(rawAmount);
    if (n >= 70 && n < 90) {
      amountReais = 81.50; // UPSELL
    }
  }
  const amountCents = Math.round(amountReais * 100);

  const customerName = (body.nome || body.name || body.customer_name || `Cliente ${randId}`).toString().trim();
  const customerEmail = (body.email || body.customer_email || `cliente${randId}@gmail.com`).toString().trim();
  const customerPhone = fmtPhone(body.phone || body.customer_phone || "11999999999");
  const cpfRaw = (body.cpf || body.document || body.customer_cpf || "").toString().replace(/\D/g, "");
  const customerCpf = cpfRaw.length === 11 ? cpfRaw : gerarCpfValido();
  const utms = body.utm || {};
  const reference = `order_${randId}`;

  console.log("[PIX] Amount:", amountReais, "Cents:", amountCents);
  console.log("[PIX] Customer:", { name: customerName, email: customerEmail, cpf: customerCpf });

  try {
    // Chama o gateway para criar a transação
    const gatewayResponse = await gateway.createPixTransaction({
      amount: amountReais,
      amountCents,
      customerName,
      customerEmail,
      customerCpf,
      customerPhone,
      externalReference: reference,
    });

    const transactionId = gatewayResponse.transactionId;
    const pixCode = gatewayResponse.pixCode;

    console.log("[PIX] ===== PIX GERADO COM SUCESSO =====");
    console.log("[PIX] Transaction ID:", transactionId);
    console.log("[PIX] PIX Code: ✓ Existe");

    // Este projeto não guarda a transação: quem tem o registro de verdade é o
    // gateway. O que sai daqui é só o aviso para a UTMify, abaixo.

    // Notificar UTMify (não bloqueia)
    await sendUtmify(
      transactionId, "waiting_payment",
      { name: customerName, email: customerEmail, phone: customerPhone, cpf: customerCpf },
      amountCents,
      new Date().toISOString().replace("T", " ").slice(0, 19),
      utms,
      gateway.name
    ).catch(err => console.error("[SendUtmify] Erro:", err.message));

    return jsonResponse(200, {
      success: true,
      pixCode,
      pix_code: pixCode,
      brcode: pixCode,
      payload: pixCode,
      qr_code: pixCode,
      qr_code_image: null,
      transaction_id: transactionId,
      transactionId,
      deposit_id: transactionId,
      status: "pending",
      amount: amountReais,
      gateway: gateway.name,
    });

  } catch (err) {
    console.error("[PIX] Erro ao chamar gateway:", err.message);
    return jsonResponse(502, {
      success: false,
      error: "Falha ao conectar com gateway: " + String(err),
      debug: err.message
    });
  }
};

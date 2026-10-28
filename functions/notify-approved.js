/**
 * AVISO DE APROVAÇÃO — hoje é só um reconhecimento.
 *
 * Marcava a transação como aprovada no banco. Sem persistência não há registro
 * local a atualizar: o status verdadeiro vive no gateway e o funil o descobre
 * consultando /api/check-payment.
 *
 * A rota continua respondendo 200 para não quebrar quem já a chama.
 */

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

exports.handler = async (event) => {
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
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {}

  const transactionId = body.id || body.transaction_id || body.idTransaction || event.queryStringParameters?.id;

  if (transactionId) {
    console.log("[NotifyApproved] Aviso recebido:", transactionId);
  }

  return jsonResponse(200, { success: true });
};

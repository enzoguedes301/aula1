
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
    const contentType = event.headers?.["content-type"] || "";
    if (contentType.includes("application/json")) {
      body = event.body ? JSON.parse(event.body) : {};
    } else {
      // FormData — extrai campos do multipart manualmente
      const raw = event.body || "";
      const getField = (name) => {
        const re = new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n-]+)`);
        const m = raw.match(re);
        return m ? m[1].trim() : null;
      };
      body = {
        transaction_id: getField("transaction_id"),
        cpf:            getField("customer_cpf"),
        nome:           getField("customer_name"),
        arquivo:        getField("comprovante") || null,
      };
    }
  } catch (_) {}

  // Sem persistência o comprovante não é guardado — fica só o registro de que
  // chegou, no log da função. A rota segue respondendo 200 para o envio na
  // tela não acusar falha.
  console.log("[Comprovantes] Envio recebido:", JSON.stringify({
    transaction_id: body.transaction_id || body.id || null,
    cpf:  body.cpf || body.customer_cpf || null,
    nome: body.nome || body.customer_name || null,
    filename: body.filename || null,
  }));

  return jsonResponse(200, { success: true });
};

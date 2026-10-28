/**
 * LOG DE ACESSO — hoje escreve no log da função, não em banco.
 *
 * Gravava uma linha em `access_logs`. Sem persistência, o que sobra é o
 * registro de execução da própria função, que a Netlify retém por alguns dias.
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

  console.log("[LogAccess]", JSON.stringify({
    ip: event.headers["x-forwarded-for"] || event.headers["client-ip"] || null,
    user_agent: event.headers["user-agent"] || null,
    path: body.path || event.queryStringParameters?.path || null,
    referrer: event.headers["referer"] || null,
  }));

  return jsonResponse(200, { success: true });
};

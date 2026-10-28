/**
 * ENDPOINT PÚBLICO DE RASTREIO — o funil bate aqui.
 *
 *   POST /api/track/evento   uma etapa alcançada
 *   POST /api/track/lead     os dados da pessoa
 *
 * REGRA QUE NÃO SE QUEBRA: isto NUNCA derruba o funil. Toda resposta é 204,
 * mesmo em erro. Uma medição que falha é um número a menos no painel; uma
 * medição que lança é uma venda perdida.
 *
 * Não depende de gateway nenhum.
 */

const { marcarEtapa, gravarLead } = require("./lib/tracking-store");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

/** Sempre 204. O navegador não precisa saber se gravou. */
function ok() {
  return { statusCode: 204, headers: CORS, body: "" };
}

/** O IP de quem chamou, atrás do proxy da Netlify/Vercel. */
function ipDoPedido(event) {
  const h = event.headers || {};
  const encadeado = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  return String(encadeado).split(",")[0].trim() || h["client-ip"] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok();
  if (event.httpMethod !== "POST") return ok();

  let corpo = {};
  try {
    corpo = event.body ? JSON.parse(event.body) : {};
  } catch {
    return ok();
  }

  // O que vem depois de /api/track/ decide a ação. Aceita também {tipo:"lead"}
  // no corpo, para o caso de a rota chegar sem sufixo.
  const caminho = String(event.path || "");
  const acao = caminho.includes("/lead")
    ? "lead"
    : caminho.includes("/evento")
    ? "evento"
    : corpo.tipo === "lead"
    ? "lead"
    : "evento";

  try {
    if (acao === "lead") {
      await gravarLead({
        ...corpo,
        ip: ipDoPedido(event),
        userAgent: (event.headers || {})["user-agent"] || null,
        referrer: (event.headers || {})["referer"] || corpo.referrer || null,
      });
    } else {
      await marcarEtapa({
        sessao: corpo.sessao || corpo.session,
        etapa: corpo.etapa || corpo.step,
        funil: corpo.funil || corpo.funnel,
        adId: corpo.ad || corpo.adId || corpo.attrib?.criativo,
      });

      // Um evento que já traz identificação também alimenta o lead: é assim
      // que o painel sabe em que etapa cada pessoa parou.
      if (corpo.cpf || corpo.telefone || corpo.phone || corpo.email) {
        await gravarLead({
          ...corpo,
          ip: ipDoPedido(event),
          userAgent: (event.headers || {})["user-agent"] || null,
        });
      }
    }
  } catch (err) {
    console.error("[Track] Erro engolido:", err.message);
  }

  return ok();
};

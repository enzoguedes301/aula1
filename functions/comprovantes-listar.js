/**
 * LISTA OS COMPROVANTES — para a página /comp.
 *
 * POR QUE ESTE ARQUIVO EXISTE: até 28/10/2026 a página `comp/index.html` lia
 * a tabela direto do navegador, com a `service_role` do Supabase escrita no
 * HTML. Essa chave ignora toda a segurança do banco, e qualquer visitante
 * podia abrir o F12 e copiá-la — a senha na tela não protegia nada, porque a
 * chave já tinha sido baixada junto com a página.
 *
 * Agora a chave fica só aqui, no servidor, e a página pede os dados por esta
 * rota. A senha é conferida aqui também, onde o navegador não a vê.
 */

const { getSupabase } = require("./lib/supabase");
const crypto = require("crypto");

const SENHA = (process.env.COMPROVANTES_SENHA || "").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Comp-Senha, x-comp-senha",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(body),
  };
}

/** Compara em tempo constante, pelo hash, para não vazar o tamanho. */
function confere(recebido, esperado) {
  if (!esperado) return false;
  const a = crypto.createHash("sha256").update(String(recebido)).digest();
  const b = crypto.createHash("sha256").update(String(esperado)).digest();
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  // Sem senha configurada a página não existe, em vez de existir destrancada.
  if (!SENHA) {
    return json(404, { success: false, error: "NOT_FOUND" });
  }

  const enviada = (event.headers || {})["x-comp-senha"] || "";
  if (!confere(enviada, SENHA)) {
    return json(401, { success: false, error: "UNAUTHORIZED" });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("comprovantes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw new Error(error.message);

    return json(200, { success: true, data: data || [] });
  } catch (err) {
    console.error("[Comprovantes] Erro:", err.message);
    return json(500, { success: false, error: "INTERNAL_ERROR", message: err.message });
  }
};

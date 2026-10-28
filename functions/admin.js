/**
 * BACKEND DO PAINEL /admin
 *
 *   GET  /api/admin/leads              todos os leads, com todos os campos
 *   GET  /api/admin/orders             vendas + funil + totais (a tela principal)
 *   GET  /api/admin/config             taxas e despesas
 *   POST /api/admin/config             salva taxas e despesas
 *   GET  /api/admin/funil              contagem por etapa
 *
 * AUTENTICAÇÃO: header `x-admin-token` comparado com ADMIN_TOKEN em tempo
 * constante. Sem ADMIN_TOKEN configurado, tudo responde 404 — o painel
 * simplesmente não existe, em vez de anunciar que existe e está trancado.
 */

const crypto = require("crypto");
const { getSupabase } = require("./lib/supabase");
const { contarFunil, listarLeads, ETAPAS, hoje } = require("./lib/tracking-store");

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, x-admin-token",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(body),
  };
}

/**
 * Compara dois segredos sem vazar o tamanho nem a posição do primeiro byte
 * diferente. Passa pelo SHA-256 para igualar o comprimento antes do timingSafe.
 */
function segredoConfere(recebido, esperado) {
  if (!esperado) return false;
  const a = crypto.createHash("sha256").update(String(recebido)).digest();
  const b = crypto.createHash("sha256").update(String(esperado)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Converte 'periodo' da tela num intervalo de datas. */
function intervalo(periodo) {
  const agora = new Date();
  const emSP = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const diasAtras = (n) => {
    const d = new Date(agora);
    d.setDate(d.getDate() - n);
    return emSP(d);
  };

  switch (periodo) {
    case "ontem":   return { de: diasAtras(1), ate: diasAtras(1) };
    case "7dias":   return { de: diasAtras(6), ate: emSP(agora) };
    case "30dias":  return { de: diasAtras(29), ate: emSP(agora) };
    case "tudo":    return { de: "2000-01-01", ate: emSP(agora) };
    case "hoje":
    default:        return { de: emSP(agora), ate: emSP(agora) };
  }
}

async function lerVendas({ de, ate }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .gte("created_at", `${de}T00:00:00`)
    .lte("created_at", `${ate}T23:59:59.999`)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.error("[Admin] Falha ao ler vendas:", error.message);
    return [];
  }
  return data || [];
}

async function lerConfig() {
  const padrao = { taxaGatewayPct: 2, impostoPct: 0, custoPorVenda: 0, despesas: [] };
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("painel_config")
      .select("value")
      .eq("key", "painel")
      .maybeSingle();
    return { ...padrao, ...(data?.value || {}) };
  } catch {
    return padrao;
  }
}

async function gravarConfig(valor) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("painel_config")
    .upsert({ key: "painel", value: valor, updated_at: new Date().toISOString() },
            { onConflict: "key" });
  if (error) throw new Error(error.message);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  // Sem senha configurada, o painel não existe.
  if (!ADMIN_TOKEN) {
    return json(404, { success: false, error: "NOT_FOUND" });
  }

  const enviado = (event.headers || {})["x-admin-token"] || "";
  if (!segredoConfere(enviado, ADMIN_TOKEN)) {
    return json(401, { success: false, error: "UNAUTHORIZED", message: "Senha incorreta." });
  }

  // Normaliza: /api/admin/leads -> /leads
  const caminho =
    String(event.path || "")
      .replace(/^.*\/admin/, "")
      .replace(/\/+$/, "") || "/";

  const q = event.queryStringParameters || {};

  try {
    // ---------------------------------------------------------------- leads
    if (caminho === "/leads") {
      const leads = await listarLeads(Number(q.limite) || 1000);
      return json(200, { success: true, data: leads, total: leads.length });
    }

    // ------------------------------------------------------------- rastreio
    // Diagnóstico da central: cada peça do rastreio está de pé?
    if (caminho === "/rastreio") {
      const supabase = getSupabase();
      const { de, ate } = intervalo("hoje");

      // Uma leitura real por tabela. `head: true` não propaga o erro de
      // tabela ausente — por isso aqui se pede uma linha de verdade.
      const [rLeads, rEventos, rConfig] = await Promise.all([
        supabase.from("leads").select("lead_key", { count: "exact" }).limit(1),
        supabase.from("funnel_events").select("session", { count: "exact" }).limit(1),
        supabase.from("painel_config").select("key", { count: "exact" }).limit(1),
      ]);

      const tabelasOk = !rLeads.error && !rEventos.error && !rConfig.error;
      const eventos = rEventos.count || 0;

      return json(200, {
        success: true,
        data: {
          tabelasOk,
          trackingOk: eventos > 0,
          leads: rLeads.count || 0,
          eventos,
          etapas: ETAPAS,
          funil: tabelasOk ? await contarFunil({ de, ate }) : {},
          erro: tabelasOk
            ? undefined
            : "Tabelas ausentes. Rode supabase-painel.sql no SQL Editor do Supabase.",
        },
      });
    }

    // ---------------------------------------------------------------- funil
    if (caminho === "/funil") {
      const { de, ate } = intervalo(q.periodo);
      const funil = await contarFunil({ de, ate, funil: q.funil });
      return json(200, { success: true, data: { funil, etapas: ETAPAS, de, ate } });
    }

    // --------------------------------------------------------------- config
    if (caminho === "/config") {
      if (event.httpMethod === "POST") {
        let corpo = {};
        try { corpo = event.body ? JSON.parse(event.body) : {}; } catch {}
        await gravarConfig(corpo);
        return json(200, { success: true, data: corpo });
      }
      return json(200, { success: true, data: await lerConfig() });
    }

    // --------------------------------------------------- orders (tela principal)
    if (caminho === "/orders" || caminho === "/") {
      const { de, ate } = intervalo(q.periodo);

      const [vendas, funil, config, leads] = await Promise.all([
        lerVendas({ de, ate }),
        contarFunil({ de, ate, funil: q.funil }),
        lerConfig(),
        listarLeads(1000),
      ]);

      const pagas = vendas.filter((v) => v.status === "paid");
      const faturamento = pagas.reduce((s, v) => s + Number(v.amount || 0), 0);
      const taxas = faturamento * (Number(config.taxaGatewayPct || 0) / 100);
      const imposto = faturamento * (Number(config.impostoPct || 0) / 100);
      const custos = pagas.length * Number(config.custoPorVenda || 0);
      const despesas = (config.despesas || []).reduce((s, d) => s + Number(d.valor || 0), 0);

      // Quantas pessoas chegaram vs quantas pagaram.
      const chegaram = funil.chegou || 0;
      const conversao = chegaram > 0 ? (pagas.length / chegaram) * 100 : 0;

      return json(200, {
        success: true,
        data: {
          periodo: { de, ate },
          totais: {
            vendas: vendas.length,
            pagas: pagas.length,
            pendentes: vendas.filter((v) => v.status === "pending").length,
            faturamento: Number(faturamento.toFixed(2)),
            liquido: Number((faturamento - taxas - imposto - custos - despesas).toFixed(2)),
            taxas: Number(taxas.toFixed(2)),
            imposto: Number(imposto.toFixed(2)),
            despesas: Number(despesas.toFixed(2)),
            ticketMedio: pagas.length ? Number((faturamento / pagas.length).toFixed(2)) : 0,
            conversao: Number(conversao.toFixed(2)),
          },
          funil,
          etapas: ETAPAS,
          vendas,
          leads,
          config,
        },
      });
    }

    return json(404, { success: false, error: "NOT_FOUND", message: `Rota ${caminho} não existe.` });
  } catch (err) {
    console.error("[Admin] Erro:", err.message);
    return json(500, { success: false, error: "INTERNAL_ERROR", message: err.message });
  }
};

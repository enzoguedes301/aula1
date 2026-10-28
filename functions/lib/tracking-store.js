/**
 * ARMAZENAMENTO DO RASTREIO — onde os leads passaram.
 *
 * Isto não tem nada a ver com gateway de pagamento. O funil bate aqui a cada
 * etapa que a pessoa alcança, e o painel lê daqui. Se a GorillaPay cair, ou se
 * o gateway for trocado amanhã, o rastreio continua de pé.
 *
 * DUAS TABELAS, e a diferença entre elas importa:
 *
 *   funnel_events  uma linha por (dia, etapa, funil, sessão). A chave primária
 *                  composta é o que garante a contagem de pessoas ÚNICAS: a
 *                  mesma aba batendo dez vezes em "checkout" no mesmo dia vira
 *                  uma linha só. Era um SET no Redis do projeto original; aqui
 *                  o banco faz o trabalho.
 *
 *   leads          uma linha por telefone. Guarda contato + de qual anúncio a
 *                  pessoa veio.
 *
 * NADA AQUI PODE DERRUBAR O FUNIL. Toda função engole o próprio erro e devolve
 * false. Medição que quebra a venda é pior do que medição nenhuma.
 */

const { getSupabase } = require("./supabase");

/**
 * As etapas do funil, NA ORDEM em que a pessoa as atravessa. Nome fora desta
 * lista é recusado — é o que impede uma etapa inventada de sujar o painel.
 *
 * Vieram das rotas reais do bundle (/login, /chat, /verificacao, ...).
 */
const ETAPAS = [
  "chegou",      // abriu o site
  "login",       // tela de identificação
  "chat",        // conversa/atendimento
  "verificacao", // verificação de disponibilidade
  "saiba_mais",  // leu os detalhes
  "cadastro",    // concluiu o cadastro
  "pagamento",   // abriu a tela de pagamento
  "pix",         // gerou o código PIX
  "pago",        // pagamento confirmado
];

/** Corta e limpa um texto curto vindo do navegador. */
function texto(v, max = 200) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** O dia de hoje em São Paulo, como 'YYYY-MM-DD'. */
function hoje() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * Registra que uma sessão alcançou uma etapa.
 *
 * Repetir a mesma (sessão, etapa, dia) não duplica: o upsert bate na chave
 * primária composta e ignora. É isso que faz a contagem ser de pessoas, e não
 * de recarregamentos de página.
 */
async function marcarEtapa({ sessao, etapa, funil, adId }) {
  const s = texto(sessao, 80);
  const e = texto(etapa, 40);

  if (!s || !e || !ETAPAS.includes(e)) return false;

  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("funnel_events").upsert(
      {
        day: hoje(),
        step: e,
        funnel: texto(funil, 40) || "",
        session: s,
        ad_id: texto(adId, 120),
      },
      { onConflict: "day,step,funnel,session", ignoreDuplicates: true }
    );

    if (error) {
      console.error("[Tracking] Falha ao gravar etapa:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Tracking] Erro ao gravar etapa:", err.message);
    return false;
  }
}

/** Só os dígitos de um texto. */
function digitos(v) {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

/**
 * Grava ou atualiza um lead com TUDO que o funil souber dele.
 *
 * Identidade: o CPF quando houver (não muda), senão o telefone.
 *
 * Três regras de mesclagem, e cada uma existe por um motivo:
 *
 *   1. Campo novo não apaga campo velho. A pessoa preenche o funil aos poucos;
 *      um passo que só sabe o telefone não pode zerar o nome que o passo
 *      anterior já tinha gravado.
 *   2. A atribuição é gravada UMA vez. Se a pessoa voltar por outro caminho,
 *      o crédito continua com o anúncio que a trouxe primeiro.
 *   3. `raw` acumula. Cada payload recebido é mesclado ao que já havia, então
 *      um campo que este schema ainda não previu não se perde.
 */
async function gravarLead(dados = {}) {
  const cpf = digitos(dados.cpf || dados.documento || dados.document);
  const fone = digitos(dados.telefone || dados.phone || dados.celular || dados.whatsapp);

  // Precisa de ao menos um identificador utilizável.
  const cpfOk = cpf.length === 11;
  const foneOk = fone.length >= 10 && fone.length <= 13;
  if (!cpfOk && !foneOk) return false;

  const chave = cpfOk ? cpf : fone;

  try {
    const supabase = getSupabase();

    const { data: existente } = await supabase
      .from("leads")
      .select("*")
      .eq("lead_key", chave)
      .maybeSingle();

    const registro = {
      lead_key: chave,
      updated_at: new Date().toISOString(),
    };

    // Só escreve o que veio preenchido — nunca apaga o que já existe.
    const campos = {
      cpf: cpfOk ? cpf : null,
      phone: foneOk ? fone : null,
      name: texto(dados.nome || dados.name, 120),
      email: texto(dados.email, 160),
      birth_date: texto(dados.nascimento || dados.birth || dados.data_nascimento, 40),
      mother_name: texto(dados.mae || dados.nome_mae || dados.mother, 120),
      age_range: texto(dados.faixaIdade || dados.idade || dados.age_range, 40),
      gender: texto(dados.sexo || dados.genero || dados.gender, 20),
      cep: texto(dados.cep, 20),
      address: texto(dados.endereco || dados.address, 240),
      city: texto(dados.cidade || dados.city, 120),
      state: texto(dados.estado || dados.uf || dados.state, 40),
      origin: texto(dados.origem || dados.funil || dados.origin, 40),
      session: texto(dados.sessao || dados.session, 80),
      ip: texto(dados.ip, 60),
      user_agent: texto(dados.userAgent || dados.ua, 400),
      referrer: texto(dados.referrer, 400),
      landing_url: texto(dados.url || dados.landingUrl, 400),
    };

    for (const [k, v] of Object.entries(campos)) {
      if (v !== null && v !== "") registro[k] = v;
    }

    // Primeira etapa só na criação; a última sempre avança.
    const etapa = texto(dados.etapa || dados.step, 40);
    if (etapa) {
      registro.last_step = etapa;
      if (!existente?.first_step) registro.first_step = etapa;
    }

    // Primeira atribuição vence.
    if (!existente?.attrib && dados.attrib && typeof dados.attrib === "object") {
      registro.attrib = dados.attrib;
    }

    // `raw` acumula, para nada se perder.
    const bruto = dados.raw && typeof dados.raw === "object" ? dados.raw : dados;
    registro.raw = { ...(existente?.raw || {}), ...bruto };

    const { error } = await supabase
      .from("leads")
      .upsert(registro, { onConflict: "lead_key" });

    if (error) {
      console.error("[Tracking] Falha ao gravar lead:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Tracking] Erro ao gravar lead:", err.message);
    return false;
  }
}

/**
 * Conta quantas sessões únicas passaram por cada etapa, num intervalo de dias.
 * Devolve `{ chegou: 120, checkout: 30, pix: 12, ... }`.
 */
async function contarFunil({ de, ate, funil }) {
  const vazio = Object.fromEntries(ETAPAS.map((e) => [e, 0]));

  try {
    const supabase = getSupabase();
    let q = supabase.from("funnel_events").select("step").gte("day", de).lte("day", ate);
    if (funil) q = q.eq("funnel", funil);

    const { data, error } = await q.limit(100000);
    if (error) {
      console.error("[Tracking] Falha ao contar funil:", error.message);
      return vazio;
    }

    for (const linha of data || []) {
      if (linha.step in vazio) vazio[linha.step] += 1;
    }
    return vazio;
  } catch (err) {
    console.error("[Tracking] Erro ao contar funil:", err.message);
    return vazio;
  }
}

/** Lista os leads mais recentes. */
async function listarLeads(limite = 500) {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(limite, 2000));

    if (error) {
      console.error("[Tracking] Falha ao listar leads:", error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error("[Tracking] Erro ao listar leads:", err.message);
    return [];
  }
}

module.exports = { ETAPAS, marcarEtapa, gravarLead, contarFunil, listarLeads, hoje };

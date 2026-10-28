/**
 * RASTREIO — repasse para os pixels externos. SEM BANCO DE DADOS.
 *
 * Este projeto não guarda lead nem etapa em banco algum. O que o funil bate
 * aqui é repassado para quem mede de verdade (UTMify hoje; Meta e TikTok
 * quando os tokens existirem) e descartado em seguida.
 *
 * CONSEQUÊNCIA, e é deliberada: não há histórico para consultar. As funções de
 * leitura — `contarFunil` e `listarLeads` — devolvem vazio sempre. O painel
 * /admin continua abrindo, mas as listas vêm sem conteúdo e os contadores em
 * zero. Para o painel voltar a mostrar dados é preciso ligar uma fonte de
 * persistência a estas duas funções.
 *
 * NADA AQUI PODE DERRUBAR O FUNIL. Toda função engole o próprio erro e devolve
 * false. Medição que quebra a venda é pior do que medição nenhuma.
 */

/**
 * As etapas do funil, NA ORDEM em que a pessoa as atravessa. Nome fora desta
 * lista é recusado — é o que impede uma etapa inventada de sujar o relatório.
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

/** Só os dígitos de um texto. */
function digitos(v) {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

/** O dia de hoje em São Paulo, como 'YYYY-MM-DD'. */
function hoje() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * Manda um evento para a UTMify.
 *
 * Sem `UTMIFY_TOKEN` a função sai calada — é o comportamento esperado em
 * ambiente de teste, não um erro. O timeout curto existe porque isto roda no
 * caminho da venda: um pixel lento não pode segurar a resposta ao navegador.
 */
async function enviarUtmify(evento, dados) {
  const token = process.env.UTMIFY_TOKEN;
  if (!token) return false;

  try {
    const controller = new AbortController();
    const prazo = setTimeout(() => controller.abort(), 3000);

    const resposta = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": token },
      body: JSON.stringify({ event: evento, ...dados }),
      signal: controller.signal,
    });

    clearTimeout(prazo);

    if (!resposta.ok) {
      console.error("[Tracking] UTMify recusou:", resposta.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Tracking] UTMify falhou:", err.message);
    return false;
  }
}

/**
 * Repassa uma etapa alcançada aos pixels.
 *
 * Sem banco não existe deduplicação: a mesma aba batendo dez vezes em
 * "checkout" dispara dez vezes. Quem conta pessoas únicas, agora, é a
 * ferramenta do outro lado.
 */
async function marcarEtapa({ sessao, etapa, funil, adId }) {
  const s = texto(sessao, 80);
  const e = texto(etapa, 40);

  if (!s || !e || !ETAPAS.includes(e)) return false;

  try {
    await enviarUtmify("funnel_step", {
      step: e,
      funnel: texto(funil, 40) || "",
      session: s,
      ad_id: texto(adId, 120),
      day: hoje(),
    });
    return true;
  } catch (err) {
    console.error("[Tracking] Erro ao repassar etapa:", err.message);
    return false;
  }
}

/**
 * Repassa os dados de um lead aos pixels.
 *
 * Exige um identificador utilizável (CPF de 11 dígitos ou telefone), mesmo
 * critério de antes: evita gastar chamada com payload incompleto.
 *
 * Sem banco não há mesclagem. Cada chamada vai sozinha, com o que o funil
 * sabia naquele instante — montar a ficha completa é trabalho de quem recebe.
 */
async function gravarLead(dados = {}) {
  const cpf = digitos(dados.cpf || dados.documento || dados.document);
  const fone = digitos(dados.telefone || dados.phone || dados.celular || dados.whatsapp);

  const cpfOk = cpf.length === 11;
  const foneOk = fone.length >= 10 && fone.length <= 13;
  if (!cpfOk && !foneOk) return false;

  try {
    await enviarUtmify("lead", {
      lead_key: cpfOk ? cpf : fone,
      cpf: cpfOk ? cpf : null,
      phone: foneOk ? fone : null,
      name: texto(dados.nome || dados.name, 120),
      email: texto(dados.email, 160),
      city: texto(dados.cidade || dados.city, 120),
      state: texto(dados.estado || dados.uf || dados.state, 40),
      origin: texto(dados.origem || dados.funil || dados.origin, 40),
      session: texto(dados.sessao || dados.session, 80),
      step: texto(dados.etapa || dados.step, 40),
      attrib: dados.attrib && typeof dados.attrib === "object" ? dados.attrib : null,
    });
    return true;
  } catch (err) {
    console.error("[Tracking] Erro ao repassar lead:", err.message);
    return false;
  }
}

/**
 * Devolve o funil zerado — não há histórico sem banco.
 *
 * A forma do retorno é a de antes (`{ chegou: 0, login: 0, ... }`) para o
 * painel não precisar saber da diferença.
 */
async function contarFunil() {
  return Object.fromEntries(ETAPAS.map((e) => [e, 0]));
}

/** Devolve lista vazia — não há histórico sem banco. */
async function listarLeads() {
  return [];
}

module.exports = { ETAPAS, marcarEtapa, gravarLead, contarFunil, listarLeads, hoje };

/**
 * ============================================================================
 * A PONTE ENTRE O CHECKOUT E A ZUCKPAY. É o único código de servidor que existe.
 * ============================================================================
 *
 * POR QUE ELE EXISTE, já que o site é só front: a ZuckPay proíbe as credenciais
 * no navegador, e com razão — a MESMA chave que cria a cobrança faz saque
 * (`POST /v3/pix/payment`, até R$ 20.000). Credencial no front é qualquer
 * pessoa abrir o DevTools e esvaziar a conta. Por isso `client_id` e
 * `client_secret` só existem aqui, nas variáveis de ambiente da Vercel.
 *
 * O QUE ELE FAZ, e nada além:
 *
 *   POST /api/orders              soma o preço, cria a cobrança, devolve o PIX
 *   GET  /api/orders/:id          pergunta à ZuckPay se já pagou
 *   GET  /api/orders/:id/access   devolve os links do que foi comprado
 *
 * NÃO HÁ BANCO, e o desenho abaixo depende disso: o que o pedido continha viaja
 * dentro do `external_id_client`, que a ZuckPay guarda e devolve na consulta de
 * status. Sem isso seria preciso um Postgres só para lembrar que alguém marcou
 * o Guia dos Salmos — e um banco a mais é uma coisa a mais que cai no domingo.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';

/* ===========================================================================
 * DAQUI ATE A MARCA "FIM DAS PARTES JUNTADAS" MORAVAM DOIS ARQUIVOS.
 *
 * `api/memoria.ts` e `api/meta.ts` viraram este trecho em 05/09/2026, e nao foi
 * gosto por arquivo grande: separados, eles quebravam A FUNCAO INTEIRA no ar.
 *
 * O QUE ACONTECEU: importar `./memoria.ts` compila e passa no teste local, mas
 * a Vercel transpila cada arquivo para `.js` -- e em tempo de execucao o
 * `memoria.ts` nao existe mais. O build ficava VERDE e toda rota respondia
 * FUNCTION_INVOCATION_FAILED. Sem `.ts` o import passa na Vercel e quebra o
 * teste local, que roda em Node puro. Nao havia extensao que servisse aos dois.
 *
 * Um arquivo so nao tem esse problema, e e o que o NOTAS.md ja dizia que este
 * servidor era. Se for separar de novo, PUBLIQUE E CHAME UMA ROTA antes de
 * comemorar: build verde aqui nao prova nada.
 * =========================================================================== */

/**
 * A MEMÓRIA DAS VENDAS. É a única coisa neste projeto que guarda estado.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELA PRECISOU EXISTIR
 * ---------------------------------------------------------------------------
 *
 * Até 04/09/2026 este projeto não guardava nada, de propósito: o que o pedido
 * continha viajava dentro do `external_id_client`, que a ZuckPay devolve na
 * consulta de status. Isso resolvia "o que entregar" sem banco nenhum.
 *
 * Duas coisas que o dono pediu não cabem nesse desenho:
 *
 *   • O PAINEL. Listar quem comprou exige lembrar de quem comprou.
 *   • O `Purchase` NO SERVIDOR com atribuição. O aviso de pagamento da ZuckPay
 *     não sabe nada de anúncio; o `fbclid` e o `_fbp` existiam só no navegador,
 *     no momento da compra. Alguém tem que guardar a ponte entre os dois.
 *
 * ---------------------------------------------------------------------------
 * UMA VENDA POR ARQUIVO, E NÃO UMA LISTA
 * ---------------------------------------------------------------------------
 *
 * Guardar tudo num arquivo só obrigaria a ler, alterar e reescrever a cada
 * venda — e duas compras no mesmo instante perderiam uma das duas, em silêncio.
 * Com uma chave por pedido não há disputa: cada venda escreve a sua e ninguém
 * pisa em ninguém.
 *
 * ---------------------------------------------------------------------------
 * A LOJA É PRIVADA, E ISSO FOI VERIFICADO
 * ---------------------------------------------------------------------------
 *
 * Aqui dentro tem nome, e-mail e telefone de quem comprou. Medido em
 * 05/09/2026: sem o token a leitura devolve **403**; com ele, 200. Se um dia
 * alguém trocar `access: private` por `public`, a carteira de clientes fica
 * legível para quem tiver a URL — e URLs vazam por log, por referer e por
 * histórico.
 *
 * ---------------------------------------------------------------------------
 * SEM O TOKEN, TUDO AQUI VIRA NADA — E ISSO É DE PROPÓSITO
 * ---------------------------------------------------------------------------
 *
 * NENHUMA VENDA É PERDIDA POR ISSO: a cobrança nasce, o PIX aparece e a entrega
 * funciona igual, porque tudo isso continua saindo do `external_id_client`. O
 * que se perde é o painel e a atribuição.
 *
 * A alternativa seria a função recusar o pedido quando a memória não responde
 * — trocar uma venda por um registro. Nunca.
 */

/* -------------------------------------------------------------------------- */
/* A MEMÓRIA — Redis pela API HTTP, sem nenhuma dependência                    */
/* -------------------------------------------------------------------------- */

/**
 * ============================================================================
 * POR QUE SAIU DO VERCEL BLOB (06/09/2026)
 * ============================================================================
 *
 * O armazenamento foi SUSPENSO no meio da operação — `Billing State: Inactive`
 * na conta —, e a suspensão não avisa: `list()` continuava respondendo e todo
 * download voltava `403 Your store is blocked`. O painel mostrou "0 vendas"
 * como se fosse um dia fraco, o checkout continuou cobrando, e venda paga
 * deixou de virar registro, entrega e `Purchase`.
 *
 * A troca é por uma camada com plano gratuito de verdade: 256 MB e 500 mil
 * comandos por mês, sem cartão. Esta operação usava 15 KB e 806 registros.
 *
 * ============================================================================
 * SEM PACOTE NENHUM, e isso é decisão e não preguiça
 * ============================================================================
 *
 * A API é HTTP: manda-se `["SET","chave","valor"]` num POST e pronto. O
 * `@vercel/blob` era a ÚNICA dependência de execução deste projeto, e ela sai
 * agora sem entrar outra no lugar. Menos superfície para quebrar num deploy, e
 * a função continua sendo um arquivo que qualquer um lê inteiro.
 *
 * ============================================================================
 * O DESENHO FICOU MELHOR, e não só mais barato
 * ============================================================================
 *
 * O modelo antigo contava PESSOAS contando ARQUIVOS: cada sessão em cada etapa
 * virava um arquivo vazio, e o total de uma etapa era o número de arquivos com
 * aquele prefixo — o que exigia paginar listagens de mil em mil.
 *
 * Um conjunto do Redis faz exatamente isso, mas de graça e sem paginar:
 * `SADD` da mesma sessão duas vezes continua sendo UMA pessoa (é o que o
 * caminho repetido do arquivo fazia), e `SCARD` devolve o total em uma
 * operação. Eram sete listagens paginadas por dia de funil; agora são sete
 * contagens diretas.
 *
 *   vendas:<id>             o pedido, em JSON
 *   vendas:idx              o conjunto dos ids — é ele que substitui o `list()`
 *   metricas:<dia>:<etapa>  o conjunto das sessões que passaram pela etapa
 *   config:painel           taxas e despesas
 */
/*
 * O BANCO MORA NA VPS DO DONO DESDE 13/10/2026 (`BANCO_URL` / `BANCO_TOKEN`).
 * O Upstash grátis acabou no meio de uma campanha (500 mil operações por mês);
 * o Redis de /opt/banco-celestial fala a mesma língua REST e não tem limite.
 *
 * O PAR NOVO SÓ VALE INTEIRO. Com um dos dois faltando, a função segue no par
 * antigo (`UPSTASH_*`): endereço novo com senha velha derrubaria o checkout
 * inteiro, e variável que não entrou na Vercel é o erro mais fácil de cometer.
 * `trim()` nos dois: valor colado por pipe no Windows chega com quebra de linha.
 */
const BANCO_URL = (process.env.BANCO_URL ?? '').trim().replace(/\/+$/, '');
const BANCO_TOKEN = (process.env.BANCO_TOKEN ?? '').trim();
const BANCO_NOVO = /^https:\/\//.test(BANCO_URL) && BANCO_TOKEN.length >= 20;
const REDIS_URL = BANCO_NOVO ? BANCO_URL : (process.env.UPSTASH_REDIS_REST_URL ?? '').trim().replace(/\/+$/, '');
const REDIS_TOKEN = BANCO_NOVO ? BANCO_TOKEN : (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim();
const memoriaLigada = Boolean(REDIS_URL && REDIS_TOKEN);

/**
 * O MOTIVO DA ÚLTIMA FALHA FICA GUARDADO.
 *
 * A diferença entre "não há venda" e "não consegui ler as vendas" é a diferença
 * entre um dia fraco e uma operação cega — e as duas apareciam na tela do mesmo
 * jeito: painel vazio, sem uma linha de erro. Foi assim que a suspensão do
 * armazenamento passou despercebida. O painel agora lê isto e grita.
 */
let ultimaFalhaDaMemoria = '';

/**
 * Uma ida ao Redis. Devolve `null` quando falha — nunca estoura para cima,
 * porque medição e registro não podem derrubar a venda.
 *
 * `cache: 'no-store'` porque aqui se decide se o `Purchase` já foi mandado, e
 * ler versão velha manda de novo.
 */
async function redis(comando: unknown[]): Promise<unknown> {
  if (!memoriaLigada) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(comando),
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    const corpo = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!r.ok || corpo.error) {
      ultimaFalhaDaMemoria = `${comando[0]}: HTTP ${r.status} ${corpo.error ?? ''}`.trim();
      console.error('[memoria]', ultimaFalhaDaMemoria);
      return null;
    }
    ultimaFalhaDaMemoria = '';
    return corpo.result ?? null;
  } catch (falha) {
    ultimaFalhaDaMemoria = `${comando[0]}: ${(falha as Error)?.message ?? 'sem detalhe'}`;
    console.error('[memoria]', ultimaFalhaDaMemoria);
    return null;
  }
}

/** Vários comandos numa requisição só. Menos viagem, mesmo custo de cota. */
async function redisPipeline(comandos: unknown[][]): Promise<unknown[]> {
  if (!memoriaLigada || comandos.length === 0) return [];
  try {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(comandos),
      cache: 'no-store',
      signal: AbortSignal.timeout(9000),
    });
    const corpo = (await r.json().catch(() => [])) as Array<{ result?: unknown; error?: string }>;
    if (!r.ok || !Array.isArray(corpo)) {
      ultimaFalhaDaMemoria = `pipeline: HTTP ${r.status}`;
      console.error('[memoria]', ultimaFalhaDaMemoria);
      return [];
    }
    ultimaFalhaDaMemoria = '';
    return corpo.map((x) => x?.result ?? null);
  } catch (falha) {
    ultimaFalhaDaMemoria = `pipeline: ${(falha as Error)?.message ?? 'sem detalhe'}`;
    console.error('[memoria]', ultimaFalhaDaMemoria);
    return [];
  }
}

interface Venda {
  id: string;
  nome: string;
  email: string;
  telefone: string;
  itens: string[];
  valor: number;
  status: string;
  criadoEm: string;
  pagoEm?: string | null;
  /**
   * QUEM LIQUIDOU O PIX de fato, quando a ZuckPay informa.
   *
   * NÃO É O GATEWAY. A ZuckPay é intermediária: atrás dela existe um
   * adquirente/PSP, que é quem fala com o Banco Central e de quem o dinheiro
   * realmente vem. Gravar "adquirente: ZuckPay" seria repetir o nome do
   * gateway e dar a impressão de que se sabe uma coisa que não se sabe.
   *
   * NEM SEMPRE VEM NA RESPOSTA, e é por isso que o campo é opcional e a tela
   * só mostra quando existe. Ausência é "não informado", nunca erro.
   *
   * É gravado em dois momentos porque o nome costuma aparecer só DEPOIS do
   * pagamento: na criação do PIX (quando vem) e na confirmação — pela consulta
   * de status e pelo webhook, os dois caminhos que descobrem que a venda foi
   * paga. Uma vez gravado, não é apagado por uma resposta que veio sem ele.
   */
  adquirente?: string | null;
  /**
   * O QUE SOBROU DEPOIS DA TAXA — `amount_liquid`, dito pela própria ZuckPay.
   *
   * NÃO É CONTA NOSSA, e é isso que o torna útil: é o número que a ZuckPay diz
   * ter liquidado, o mesmo que aparece no extrato dela. `valor` é o que a
   * cliente pagou; este é o que entrou. A diferença entre os dois é a taxa
   * real daquela venda, sem ninguém precisar saber a porcentagem.
   *
   * POR QUE ISSO IMPORTA AQUI: o "faturamento líquido" do painel depende de
   * uma taxa e um imposto que alguém tem de digitar em Taxas, e que estão
   * vazios desde que o painel existe — por isso o cartão mostra N/A e o lucro
   * mostra "configure". Com este campo o líquido REAL de cada venda existe sem
   * configuração nenhuma, e não pode divergir do extrato, porque vem de lá.
   *
   * Só existe depois do pagamento: na criação do PIX não há liquidação, e o
   * campo é nulo. Uma resposta posterior sem ele não apaga o que já foi
   * gravado, pela mesma razão do `adquirente`.
   */
  valorLiquido?: number | null;
  /** De qual anúncio veio. Ver src/lib/atribuicao.ts, do lado do navegador. */
  attrib?: Record<string, string>;
  /** Marca que o Purchase já foi mandado ao Meta, para não mandar duas vezes. */
  metaEnviadoEm?: string | null;
  /**
   * QUEM PAGOU NO CARTÃO NÃO RECEBE OFERTA DE UPSELL. Decisão do dono,
   * 19/09/2026, no dia em que o webhook da Kiwify entrou.
   *
   * O motivo é de operação, não de gosto: o upsell deste funil nasceu para ser
   * cobrado por PIX, na sequência da mesma tela, com o pagamento confirmando em
   * segundos. Quem pagou no cartão saiu do site, comprou na Kiwify e volta
   * apenas pelo WhatsApp — oferecer upsell ali é vender por um caminho que
   * ninguém montou: cobrança em outro lugar, confirmação que não chega aqui, e
   * uma promessa de entrega que este servidor não sabe cumprir.
   *
   * HOJE O CAMPO NÃO MUDA NADA, e é de propósito que ele existe assim: a
   * mensagem de entrega (`mensagemDeEntrega`) não tem oferta nenhuma, então não
   * há o que impedir. Ele está aqui para o dia em que houver — e esse dia vem,
   * porque upsell no WhatsApp é a próxima coisa óbvia a tentar. Quem escrever
   * essa mensagem lê este comentário antes: a venda de cartão vem com
   * `semUpsell: true` e a fila entrega esse sinal junto (`/whatsapp/fila`).
   *
   * Ausente e `false` significam a MESMA coisa — venda de PIX, upsell liberado.
   */
  semUpsell?: boolean;
  /**
   * POR ONDE O DINHEIRO ENTROU. Ausente = PIX, que é o caminho de origem deste
   * funil e a esmagadora maioria — marcar as duas faria toda venda antiga de
   * PIX parecer "sem forma de pagamento" no painel.
   */
  pagamento?: 'pix' | 'cartao' | 'boleto';
  /** Só no pedido de BOLETO: o CPF que a pessoa digitou, para o dono emitir o boleto à mão. */
  cpf?: string;
  /** Por que o cartão foi negado. Só existe em venda recusada, vinda da Kiwify. */
  cartaoRecusa?: string | null;
  /** Em quantas vezes a pessoa parcelou. 44% de recusa e 12x andam juntos. */
  parcelas?: number | null;
  /**
   * PAGA POR FORA DO GATEWAY, e por que alguém decidiu isso.
   *
   * Existe porque acontece: em 08/09/2026 o PIX da Mara venceu duas vezes, o
   * dono passou uma chave pessoal pelo WhatsApp e ela pagou R$ 74 por lá. A
   * venda é real — tem comprovante — mas a ZuckPay nunca soube dela, então
   * nada aqui descobriria sozinho: nem a entrega, nem o `Purchase`, nem o
   * faturamento do painel.
   *
   * O campo guarda o MOTIVO em texto livre, e ele não é enfeite: é a única
   * diferença visível entre "entrou dinheiro por outro caminho" e "alguém
   * marcou como paga uma venda que não foi paga". Numa conciliação de conta,
   * seis meses depois, é isto que responde a pergunta.
   */
  pagoForaDoGateway?: string | null;
  /** Quando a varredura perguntou ao gateway por este pedido pela última vez. */
  conferidoEm?: string | null;
  /**
   * DE QUAL GATEWAY ESTE PEDIDO NASCEU. Ausente = ZuckPay, que é de onde vêm
   * todas as vendas anteriores a 25/09/2026 — marcar as antigas na mão seria
   * reescrever o histórico para caber num campo novo.
   *
   * NÃO É ENFEITE DE RELATÓRIO: é o campo que decide se este servidor PODE
   * perguntar o status ao gateway. Pedido `aven` não pode (ver o bloco da
   * AvenPay, acima) — nem na tela do QR, nem na varredura. Quem apagar esta
   * distinção reintroduz o polling e derruba o IP da função.
   */
  gateway?: 'zuckpay' | 'aven' | 'spypag' | 'pagouai' | 'pingupag' | 'beehive';
  /** De qual funil a venda nasceu. AUSENTE É QUIZ: é de onde vieram todas as
   *  vendas anteriores a 03/10/2026, quando o campo nasceu. */
  funil?: 'pedido' | 'novo' | 'sinais';
  /**
   * QUANTOS SEGUNDOS O CÓDIGO VALE, contados de `criadoEm`. Ausente = 1200.
   * Existe porque o código da SpyPag vence em 5 minutos: com o padrão de 20, a
   * tela recarregada mostraria um relógio de 15 minutos num código já morto.
   */
  pixValidadeS?: number;
  /**
   * O NAVEGADOR E O IP DE QUEM COMPROU, gravados no momento do pedido.
   *
   * Não é curiosidade: são dois dos sinais que o Meta usa para casar a venda
   * com o clique. Quando o cookie falha — aba anônima, navegador que bloqueia
   * terceiros, iOS com rastreamento restrito — são eles que salvam a
   * atribuição. Sem nada disso o evento entra no Gerenciador e não é creditado
   * a anúncio nenhum, que é o mesmo que não existir.
   *
   * Têm de ser capturados AQUI, na criação do pedido: quando o pagamento
   * confirma, quem fala com o servidor é a ZuckPay, e o IP é o dela.
   *
   * Ficam só no arquivo privado da venda e vão só para o Meta, junto do
   * `Purchase` que a pessoa gerou ao comprar.
   */
  ua?: string;
  ip?: string;
  /** Quando o produto saiu pelo WhatsApp. Nulo = ainda na fila do robô. */
  whatsappEnviadoEm?: string | null;
  /**
   * Quando o lembrete de PIX em aberto foi mandado. UMA VEZ por pedido, nunca
   * mais: quem não pagou e recebeu duas cobranças não vira cliente, vira
   * denúncia.
   */
  whatsappLembreteEm?: string | null;
  /**
   * QUANDO O ROBÔ RECEBEU QUEM ESCOLHEU BOLETO (13/10/2026, pedido do dono).
   *
   * O boleto não é emitido por máquina: a pessoa é levada ao WhatsApp com uma
   * mensagem pronta, o dono emite na Kiwify à mão e envia. O que o robô faz é
   * o primeiro atendimento — cumprimenta pelo nome e PERGUNTA O MELHOR DIA
   * para ela pagar, que é a informação que falta para o dono emitir na hora
   * certa (boleto emitido cedo demais vence antes de ela receber o dinheiro).
   *
   * UMA VEZ POR PEDIDO, como o lembrete: a saudação repetida transforma o
   * primeiro contato de uma pessoa que JÁ decidiu comprar num aviso de robô.
   */
  whatsappBoletoEm?: string | null;
  /**
   * O GATEWAY AVISOU QUE PAGOU, E A CONSULTA AINDA NÃO CONFIRMOU (11/10/2026).
   *
   * Medido na ZuckPay: o aviso `payment_approved` chega no mesmo segundo do
   * pagamento, e a consulta de status ainda responde pendente — só minutos
   * depois responde pago. Todas as cinco vendas daquele dia passaram batido
   * pelo aviso e só foram marcadas numa conferência posterior (11 min a 2h46
   * de atraso), e o evento de compra do TikTok saiu com esse atraso.
   *
   * Este carimbo NÃO marca a venda como paga — o aviso não é assinado, e o
   * número do pedido aparece no navegador de quem compra. Ele só diz "este
   * pedido merece ser perguntado de novo ao gateway", que é o que
   * `/admin/conferir-pendentes?so=avisados` faz, a cada poucos minutos.
   */
  avisoPagoEm?: string | null;
  /** Marca antiga de uma venda só (12/10/2026). O campo de verdade é `pagoForaDoGateway`. */
  pagoPorFora?: boolean;
  /**
   * O copia-e-cola do PIX, para o lembrete poder carregar o código.
   *
   * Sem ele o lembrete diz "volte ao site", e volta a ser mais um passo entre
   * a pessoa e o pagamento. Com ele, ela paga de dentro do WhatsApp.
   *
   * Fica no mesmo arquivo privado da venda. Não é segredo — estava na tela
   * dela há minutos —, mas também não vai para lugar nenhum além do dono dele.
   */
  pixCopiaECola?: string | null;
  /** Quantas vezes o envio falhou. Na terceira, o pedido sai da fila. */
  whatsappTentativas?: number;
  /**
   * ATÉ QUANDO NÃO TENTAR DE NOVO. Espaçamento entre tentativas.
   *
   * Sem isto, "três tentativas" não são três: o robô volta a cada 20 s, então
   * as três acontecem em UM MINUTO, contra a mesma condição, e o pedido morre
   * antes de qualquer coisa ter chance de voltar ao normal.
   */
  whatsappAdiadoAte?: string | null;
  /** O último motivo da falha, para o dono saber por que não chegou. */
  whatsappErro?: string | null;
}

/** A chave de cada venda. Determinística: é ela que evita a disputa. */
/* -------------------------------------------------------------------------- */
/* Proteções da borda (auditoria de 15/09/2026)                                */
/* -------------------------------------------------------------------------- */

/**
 * O IP DA PESSOA, sem confiar no que o cliente escreveu.
 *
 * `x-forwarded-for` é montado pela cadeia toda e o PRIMEIRO pedaço pode ser
 * forjado por quem chama (basta mandar o cabeçalho já preenchido). A Vercel
 * grava o IP real em `x-real-ip` e `x-vercel-forwarded-for`, que o cliente
 * não sobrescreve. Isto vale para o casamento no Meta/TikTok e para o limite
 * por IP abaixo — um limite por IP forjável não limita nada.
 */
function ipDe(req: { headers: Record<string, unknown> }): string {
  const direto = String(req.headers['x-real-ip'] ?? '').trim();
  if (direto) return direto;
  const daVercel = String(req.headers['x-vercel-forwarded-for'] ?? '').split(',')[0].trim();
  if (daVercel) return daVercel;
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
}

/**
 * LIMITE POR CHAVE (IP), NO REDIS — E FALHA ABERTA.
 *
 * `INCR` + `EXPIRE` só na primeira batida da janela: uma ida a mais ao Redis
 * por chamada, não duas. Se o Redis estiver fora, `redis()` devolve null, a
 * conta vira 0 e NADA é bloqueado: proteção contra abuso nunca pode ser o
 * motivo de uma venda real não sair. O teto é largo de propósito — operadora
 * de celular põe milhares de pessoas atrás do mesmo IP (CGNAT), e um teto
 * apertado barraria comprador de verdade na hora de pico.
 */
async function passouDoLimite(chave: string, teto: number, janelaS: number): Promise<boolean> {
  if (!memoriaLigada) return false;
  const k = `limite:${chave.replace(/[^\w.:-]/g, '')}`;
  const n = Number((await redis(['INCR', k])) ?? 0);
  if (n === 1) await redis(['EXPIRE', k, String(janelaS)]);
  return Number.isFinite(n) && n > teto;
}

/**
 * COMPARAÇÃO DE SEGREDO EM TEMPO CONSTANTE.
 *
 * `===` em string para na primeira letra diferente, e o tempo de resposta
 * conta quantas letras acertou — é lento de explorar pela internet, mas é de
 * graça fechar: hash dos dois lados (mesmo tamanho sempre) e XOR byte a byte
 * sem sair cedo. Segredo vazio nunca confere.
 */
function segredoConfere(informado: string, esperado: string): boolean {
  if (!esperado) return false;
  const a = createHash('sha256').update(String(informado)).digest();
  const b = createHash('sha256').update(esperado).digest();
  let diferenca = 0;
  for (let i = 0; i < a.length; i += 1) diferenca |= a[i] ^ b[i];
  return diferenca === 0;
}

const chaveDaVenda = (id: string) => `vendas:${String(id).replace(/[^\w.-]/g, '')}`;

async function gravarVenda(v: Venda): Promise<void> {
  if (!memoriaLigada) return;
  /*
   * O ÍNDICE É ATUALIZADO JUNTO, na mesma viagem. Se o `SADD` ficasse para
   * depois e a função fosse congelada no meio — o que acontece em função sem
   * servidor assim que a resposta sai —, a venda existiria sem aparecer em
   * lugar nenhum: gravada, invisível e sem entrega.
   */
  await redisPipeline([
    ['SET', chaveDaVenda(v.id), JSON.stringify(v)],
    ['SADD', 'vendas:idx', String(v.id)],
  ]);
}

async function lerVenda(id: string): Promise<Venda | null> {
  const bruto = await redis(['GET', chaveDaVenda(id)]);
  if (typeof bruto !== 'string' || !bruto) return null;
  try {
    return JSON.parse(bruto) as Venda;
  } catch {
    return null;
  }
}

async function apagarVenda(id: string): Promise<boolean> {
  if (!memoriaLigada) return false;
  const r = await redisPipeline([
    ['DEL', chaveDaVenda(id)],
    ['SREM', 'vendas:idx', String(id)],
  ]);
  return r.length > 0;
}

/**
 * Aplica campos numa venda. `base` evita a SEGUNDA leitura.
 *
 * A LEITURA A MAIS JA CUSTOU UM REGISTRO, em 06/09/2026. O `Purchase` foi
 * ACEITO pelo Meta (`events_received: 1` no log) e o `metaEnviadoEm` nunca foi
 * gravado: quem chamou aqui ja tinha a venda em maos, esta funcao releu do
 * armazenamento, a releitura voltou vazia por um instante, e o `return null`
 * engoliu a atualizacao sem uma linha de log.
 *
 * O efeito e pior do que perder um carimbo: sem a marca, a proxima consulta
 * manda o `Purchase` de novo. So nao virou venda dobrada no Gerenciador porque
 * o `event_id` e o numero do pedido e o Meta descarta o repetido -- uma rede de
 * seguranca que estava sendo usada como se fosse o plano.
 *
 * Quem ja leu a venda passa em `base` e nao le duas vezes. Quem nao leu, le
 * aqui -- e agora RECLAMA quando nao acha, em vez de sumir.
 */
async function atualizarVenda(
  id: string,
  campos: Partial<Venda>,
  base?: Venda,
): Promise<Venda | null> {
  const atual = base ?? (await lerVenda(id));
  if (!atual) {
    console.error('[memoria] nao achei a venda para atualizar:', id, Object.keys(campos).join(','));
    return null;
  }
  const novo = { ...atual, ...campos };
  await gravarVenda(novo);
  /*
   * O AVISO DE VENDA PAGA SAI DAQUI, e não de cada rota de gateway.
   *
   * São cinco avisos de pagamento diferentes, mais a marcação à mão pelo
   * painel: todos passam por esta função. Avisar na TRANSIÇÃO (não estava
   * paga, ficou paga) é o que impede o celular de tocar de novo a cada reenvio
   * do gateway — e eles reenviam.
   */
  if (novo.status === 'completed' && atual.status !== 'completed') {
    await avisarNoCelular('paga', novo);
  }
  return novo;
}

/*
 * ============================================================================
 * OS LEADS — quem deixou o WhatsApp ANTES de comprar (funil `/novo`, 10/10/2026)
 * ============================================================================
 *
 * Até aqui só existia contato de quem GERAVA O PIX: em outubro, 4.062 pessoas
 * começaram o quiz e 72 deixaram contato. O funil novo pergunta "para qual
 * WhatsApp enviamos a sua oração?" logo antes da VSL, e quem responde vira lead.
 *
 * O QUE SE GUARDA: nome, WhatsApp, faixa de idade, de onde veio (o mesmo
 * `attrib` das vendas) e quando. NÃO SE GUARDA resposta de quiz — a área
 * escolhida, o dinheiro, a família: isso continua só no navegador da pessoa
 * (regra 10 do NOTAS.md). O lead é contato, não ficha.
 *
 * UM REGISTRO POR TELEFONE (`lead:<telefone>`): quem preenche duas vezes
 * atualiza o mesmo, e não vira dois na lista nem recebe duas mensagens.
 *
 * QUEM RESPONDEU PEDIU PARA RECEBER — a pergunta é "para onde enviamos". Mandar
 * mensagem para quem só visitou seria o caminho mais curto para o número ser
 * denunciado e banido; por isso só entra aqui quem digitou o próprio WhatsApp.
 * O disparo em si continua atrás da trava do robô (ver servico-whatsapp/).
 */
interface Lead {
  telefone: string;
  nome: string;
  idade?: string;
  funil?: string;
  attrib?: Record<string, string>;
  /**
   * QUANDO ESTE LEAD ABRIU O CHECKOUT. É a linha que separa quem pode receber
   * mensagem de quem não pode — regra do dono (10/10/2026): "a mensagem só pode
   * ser enviada depois que o lead chegou no checkout". Ausente = nunca chegou,
   * e para esse o robô não manda nada. Ver `grupoDoLead`.
   */
  checkoutEm?: string;
  criadoEm: string;
  atualizadoEm: string;
}

/**
 * EM QUAL GRUPO DE MENSAGEM O LEAD ESTÁ — a régua que o dono definiu:
 *
 *   antes      deixou o WhatsApp e saiu antes do checkout   -> NENHUMA mensagem
 *   checkout   abriu o checkout e não gerou o PIX           -> mensagem 1
 *   pix        gerou o PIX e não pagou                      -> mensagem 2
 *   comprou    pagou                                        -> entrega (e upsell)
 *
 * O grupo é CALCULADO na leitura, cruzando o telefone com as vendas: gravado
 * no lead ele ficaria velho no instante em que o PIX fosse pago, e a pessoa
 * que acabou de comprar receberia a cobrança de quem não pagou.
 */
type GrupoDoLead = 'antes' | 'checkout' | 'pix' | 'comprou';
function grupoDoLead(l: Lead, feito: { gerouPix: boolean; pagou: boolean } | undefined): GrupoDoLead {
  if (feito?.pagou) return 'comprou';
  if (feito?.gerouPix) return 'pix';
  return l.checkoutEm ? 'checkout' : 'antes';
}

const FAIXAS_DE_IDADE = new Set(['ate-29', '30-45', '46-60', '61+']);
const chaveDoLead = (telefone: string) => `lead:${telefone.replace(/\D+/g, '')}`;

async function gravarLead(corpo: Record<string, unknown>): Promise<boolean> {
  if (!memoriaLigada) return false;
  const telefone = telefoneSemDdi(String(corpo.telefone ?? ''));
  /* DDD + número: 10 ou 11 dígitos. Fora disso não é WhatsApp que se alcance. */
  if (telefone.length < 10 || telefone.length > 11) return false;
  const nome = [...String(corpo.nome ?? '')].filter((c) => c !== '<' && c !== '>' && c.charCodeAt(0) >= 32).join('').trim().slice(0, 80);
  const idade = FAIXAS_DE_IDADE.has(String(corpo.idade ?? '')) ? String(corpo.idade) : undefined;
  const attrib =
    corpo.attrib && typeof corpo.attrib === 'object'
      ? Object.fromEntries(
          Object.entries(corpo.attrib as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string' && v)
            .slice(0, 16)
            .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 300)]),
        )
      : undefined;
  const agora = new Date().toISOString();
  const bruto = await redis(['GET', chaveDoLead(telefone)]);
  let anterior: Partial<Lead> = {};
  if (typeof bruto === 'string' && bruto) {
    try {
      anterior = JSON.parse(bruto) as Partial<Lead>;
    } catch {
      anterior = {};
    }
  }
  const lead: Lead = {
    telefone,
    nome: nome || anterior.nome || '',
    idade: idade ?? anterior.idade,
    funil: lerFunil(corpo.funil),
    /* A PRIMEIRA origem fica: é ela que diz qual anúncio trouxe a pessoa. */
    attrib: anterior.attrib ?? attrib,
    /* A PRIMEIRA vez que abriu o checkout fica: é dela que o robô vai contar o
       tempo para mandar a mensagem. */
    checkoutEm: anterior.checkoutEm ?? (corpo.checkout === true ? agora : undefined),
    criadoEm: anterior.criadoEm || agora,
    atualizadoEm: agora,
  };
  await redisPipeline([
    ['SET', chaveDoLead(telefone), JSON.stringify(lead)],
    ['SADD', 'leads:idx', telefone],
  ]);
  return true;
}

async function listarLeads(): Promise<Lead[]> {
  if (!memoriaLigada) return [];
  const telefones = (await redis(['SMEMBERS', 'leads:idx'])) as string[] | null;
  if (!Array.isArray(telefones) || telefones.length === 0) return [];
  const escolhidos = telefones.slice(0, TETO_DE_VENDAS_LIDAS);
  const lotes: string[][] = [];
  for (let i = 0; i < escolhidos.length; i += 200) lotes.push(escolhidos.slice(i, i + 200));
  const respostas = await redisPipeline(lotes.map((lote) => ['MGET', ...lote.map((tel) => chaveDoLead(tel))]));
  const leads: Lead[] = [];
  for (const r of respostas) {
    if (!Array.isArray(r)) continue;
    for (const b of r as Array<string | null>) {
      if (typeof b !== 'string' || !b) continue;
      try {
        const l = JSON.parse(b) as Lead;
        if (l && l.telefone) leads.push(l);
      } catch {
        /* registro torto não derruba a lista */
      }
    }
  }
  leads.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  return leads;
}

/*
 * ============================================================================
 * O AVISO NO CELULAR DO DONO (10/10/2026) — Pushcut, ou qualquer URL que receba
 * um POST com `{ title, text }`
 * ============================================================================
 *
 * A URL MORA NO REDIS (`config:notificacoes`), pelo painel, e é tratada como
 * segredo: ela carrega a chave de quem pode mandar notificação para o aparelho.
 * A leitura do painel devolve só o domínio e o fim dela.
 *
 * NUNCA DERRUBA NADA. Aviso é conforto; a venda não espera por ele. Teto de
 * 2,5 s, erro engolido, e o que falhou vai para o log — nada mais.
 *
 * O TEXTO É O QUE CABE NUMA TELA BLOQUEADA: primeiro nome, valor, gateway e de
 * onde veio. Nada de e-mail, telefone ou CPF — notificação aparece para quem
 * estiver olhando o celular.
 */
interface ConfigNotificacoes {
  url: string;
  pixGerado: boolean;
  vendaPaga: boolean;
  atualizadoEm: string;
}

const CHAVE_NOTIFICACOES = 'config:notificacoes';
let cacheDasNotificacoes: { valor: ConfigNotificacoes; ate: number } | null = null;

async function lerNotificacoes(fresco = false): Promise<ConfigNotificacoes> {
  if (!fresco && cacheDasNotificacoes && cacheDasNotificacoes.ate > Date.now()) return cacheDasNotificacoes.valor;
  let valor: ConfigNotificacoes = { url: '', pixGerado: true, vendaPaga: true, atualizadoEm: '' };
  const bruto = await redis(['GET', CHAVE_NOTIFICACOES]);
  if (typeof bruto === 'string' && bruto) {
    try {
      const s = JSON.parse(bruto) as Partial<ConfigNotificacoes>;
      valor = {
        url: typeof s.url === 'string' ? s.url : '',
        pixGerado: s.pixGerado !== false,
        vendaPaga: s.vendaPaga !== false,
        atualizadoEm: String(s.atualizadoEm ?? ''),
      };
    } catch {
      /* JSON torto é o mesmo que não configurado. */
    }
  }
  cacheDasNotificacoes = { valor, ate: Date.now() + 30_000 };
  return valor;
}

async function gravarNotificacoes(c: ConfigNotificacoes): Promise<boolean> {
  if (!memoriaLigada) return false;
  const gravou = (await redis(['SET', CHAVE_NOTIFICACOES, JSON.stringify(c)])) !== null;
  if (gravou) cacheDasNotificacoes = { valor: c, ate: Date.now() + 30_000 };
  return gravou;
}

/** O POST em si. Devolve se o destino aceitou — é o que o botão "Enviar teste" mostra. */
async function mandarNotificacao(url: string, titulo: string, texto: string): Promise<{ ok: boolean; motivo?: string }> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titulo.slice(0, 120), text: texto.slice(0, 300) }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return { ok: false, motivo: `o destino respondeu HTTP ${r.status}` };
    return { ok: true };
  } catch (falha) {
    return { ok: false, motivo: (falha as Error)?.message ?? 'sem resposta' };
  }
}

async function avisarNoCelular(
  tipo: 'pix' | 'paga',
  v: { nome?: string; valor: number; itens?: string[]; attrib?: Record<string, string>; gateway?: Venda['gateway']; pagamento?: Venda['pagamento']; pagoForaDoGateway?: string | null },
): Promise<void> {
  try {
    const c = await lerNotificacoes();
    if (!c.url) return;
    if (tipo === 'pix' ? !c.pixGerado : !c.vendaPaga) return;

    const primeiro = String(v.nome ?? '').trim().split(/\s+/)[0] || 'Cliente';
    const a = v.attrib ?? {};
    const deOnde = [a.origem, (a.campanha ?? '').split('|')[0]].filter(Boolean).join(' · ') || 'sem origem';
    const porOnde = origemDaVenda(v as Venda);
    const titulo = tipo === 'paga' ? `Venda paga — ${brl(v.valor)}` : v.pagamento === 'boleto' ? `BOLETO pedido — ${brl(v.valor)}` : `PIX gerado — ${brl(v.valor)}`;
    const texto = `${primeiro} · ${/^[A-Z]$/.test(porOnde) ? `Gateway ${porOnde}` : porOnde} · ${deOnde}`;

    const r = await mandarNotificacao(c.url, titulo, texto);
    if (!r.ok) console.error('[notificacao] nao entregue:', tipo, r.motivo);
  } catch (falha) {
    console.error('[notificacao] erro:', (falha as Error)?.message);
  }
}

/**
 * Quantas vendas o índice tinha e quantas deram para ler.
 *
 * Ver `ultimaFalhaDaMemoria`: é este par que impede a próxima suspensão de
 * passar por "dia sem venda".
 */
let ultimaListagem = { listados: 0, lidos: 0, quando: '', motivo: '' };

/**
 * LÊ TODAS AS VENDAS DO ÍNDICE, em lotes — e por que deixou de ser "as 200".
 *
 * Até 07/10/2026 isto era `ids.slice(0, 200)`. O índice é um SET do Redis, que
 * NÃO TEM ORDEM: com mais de 200 vendas, o corte pegava 200 QUAISQUER, e não as
 * 200 mais novas. Medido nesse dia, com 233 vendas em 30 dias: uma venda paga
 * de R$ 74 apareceu numa leitura do painel e SUMIU na seguinte, 20 segundos
 * depois. O faturamento mudava a cada "Atualizar", e — pior — a fila do
 * WhatsApp lê por aqui: venda paga fora do corte não entrava na fila de entrega.
 *
 * AGORA: todos os ids, em lotes de 200 chaves por `MGET`, numa ida só ao Redis
 * (pipeline). O teto de 5.000 é contra a função estourar memória e tempo no dia
 * em que a loja crescer — e, quando ele for atingido, o log GRITA em vez de
 * cortar calado, porque aí é hora de banco de verdade (ver NOTAS.md).
 *
 * `limite` corta DEPOIS de ordenar: quem pedir as N mais novas recebe as N mais
 * novas de verdade.
 */
const TETO_DE_VENDAS_LIDAS = 5000;

async function listarVendas(limite = TETO_DE_VENDAS_LIDAS): Promise<Venda[]> {
  if (!memoriaLigada) return [];
  const ids = (await redis(['SMEMBERS', 'vendas:idx'])) as string[] | null;
  if (!Array.isArray(ids) || ids.length === 0) {
    ultimaListagem = { listados: 0, lidos: 0, quando: new Date().toISOString(), motivo: ultimaFalhaDaMemoria };
    return [];
  }

  if (ids.length > TETO_DE_VENDAS_LIDAS) {
    console.error('[memoria] O INDICE TEM', ids.length, 'VENDAS, acima do teto de', TETO_DE_VENDAS_LIDAS, '— o painel esta lendo um pedaco arbitrario. Hora de banco de verdade.');
  }
  const escolhidos = ids.slice(0, TETO_DE_VENDAS_LIDAS);
  const lotes: string[][] = [];
  for (let i = 0; i < escolhidos.length; i += 200) lotes.push(escolhidos.slice(i, i + 200));
  const respostas = await redisPipeline(lotes.map((lote) => ['MGET', ...lote.map((id) => chaveDaVenda(id))]));
  const brutos = respostas.flatMap((r) => (Array.isArray(r) ? (r as Array<string | null>) : []));

  const lidos: Venda[] = [];
  for (const b of brutos) {
    if (typeof b !== 'string' || !b) continue;
    try {
      const v = JSON.parse(b) as Venda;
      // Registro torto nao derruba a lista inteira.
      if (v && v.id) lidos.push(v);
    } catch {
      /* segue */
    }
  }

  /* As mais NOVAS primeiro: o painel mostra as últimas vendas. */
  lidos.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  if (lidos.length > limite) lidos.length = limite;

  ultimaListagem = {
    listados: escolhidos.length,
    lidos: lidos.length,
    quando: new Date().toISOString(),
    motivo: ultimaFalhaDaMemoria,
  };
  if (escolhidos.length > 0 && lidos.length === 0) {
    console.error(
      '[memoria] O ÍNDICE TEM',
      escolhidos.length,
      'VENDAS E NENHUMA FOI LIDA. O painel vai abrir vazio sem ser um dia sem venda. Motivo:',
      ultimaFalhaDaMemoria || 'sem detalhe',
    );
  }
  return lidos;
}


/**
 * ============================================================================
 * O `Purchase` VOLTOU PARA CÁ (06/09/2026) — e volta para resolver ATRIBUIÇÃO.
 * ============================================================================
 *
 * Ele saiu daqui em 05/09, quando a ZuckPay foi ligada à UTMify. Voltou no dia
 * seguinte, a pedido do dono, com um objetivo claro: **a venda tem de aparecer
 * no Gerenciador de Anúncios COLADA AO CRIATIVO que a pagou.**
 *
 * ANTES DE LIGAR, DESLIGUE A REGRA DE PURCHASE DA UTMIFY. Os dois mandam o
 * mesmo evento com `event_id` diferente, o Meta só junta quando o id bate, e
 * cada venda passa a contar DUAS vezes: ROAS dobrado, e o robô aprendendo com
 * faturamento que não existe. Sem `META_CAPI_TOKEN` nada daqui sai, então o
 * caminho seguro é: desligar lá primeiro, preencher a variável depois.
 *
 * ----------------------------------------------------------------------------
 * O QUE FAZ A VENDA COLAR NO CRIATIVO
 * ----------------------------------------------------------------------------
 *
 * Não é o `utm_content`. O Meta não lê UTM — ele casa a venda com o CLIQUE, e
 * o clique é o `fbc`. Por isso três coisas importam mais que todo o resto:
 *
 *   `fbc`   o identificador do clique. Vem do cookie `_fbc`, e quando ele não
 *           existe É CONSTRUÍDO AQUI a partir do `fbclid` da URL (ver
 *           `montarFbc`). Sem isso, a venda de quem apagou cookies ou entrou
 *           por navegador que bloqueia terceiros vira venda "sem origem".
 *   `fbp`   o identificador do navegador. Liga esta venda às outras visitas da
 *           mesma pessoa.
 *   IP + UA gravados no momento do pedido. O Meta usa os dois para casar a
 *           pessoa; sem eles a qualidade da correspondência despenca e o
 *           evento entra, mas não é atribuído a anúncio nenhum.
 *
 * O `event_time` é a hora do PAGAMENTO, não a de agora: o PIX costuma ser pago
 * minutos ou horas depois do clique, e é por essa hora que o Meta procura.
 *
 * ----------------------------------------------------------------------------
 * O QUE NUNCA PODE SAIR DAQUI
 * ----------------------------------------------------------------------------
 *
 * NOME DE PRODUTO. Em 22/08/2026 a conta anterior recebeu AVISO DE BLOQUEIO por
 * mandar ao Meta dados que revelavam a crença religiosa de quem visitava.
 * Vender produto religioso é permitido; entregar a crença de quem visita, não.
 * Por isso `content_ids` leva `p1`, `p2`, `p3` — o mapa `CODIGO_NEUTRO` abaixo.
 * A conta de hoje é nova e um segundo aviso não tem volta.
 *
 * E-mail, telefone e nome vão em SHA-256, que é o que o Meta exige e o que
 * permite a correspondência sem entregar o dado em claro. `fbp` e `fbc` vão
 * inteiros de propósito: não são dado pessoal, são o identificador do clique.
 */

/**
 * OS PIXELS. Um por BM, separados por vírgula em `META_PIXEL_ID`.
 *
 * POR QUE MAIS DE UM: o dono leva tráfego de várias BMs para o mesmo site, e
 * cada BM tem o próprio pixel. Uma campanha da BM 2 otimizando por COMPRA só
 * aprende se o `Purchase` chegar AO PIXEL DELA — com um pixel só, a BM 2
 * entregaria, gastaria e nunca aprenderia, porque para ela nenhuma venda
 * existiu. O sintoma engana: as campanhas rodam normalmente e o CPA sobe sem
 * explicação.
 *
 * POR QUE NÃO COMPARTILHAR UM PIXEL SÓ ENTRE AS BMs, que também funcionaria:
 * este projeto nasceu de uma conta bloqueada, e a separação em BMs existe
 * justamente para que um bloqueio não leve o resto junto. Pixel compartilhado
 * é um ativo em comum entre elas — exatamente o laço que a separação evita.
 *
 * O `event_id` é o número do pedido e vai igual para todos: cada pixel faz o
 * próprio dedupe, e o mesmo evento em dois pixels NÃO é venda contada duas
 * vezes — são dois livros-caixa diferentes, um por BM.
 */
const PIXELS = (process.env.META_PIXEL_ID ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
/** O primeiro é o principal — é dele que a sonda de saúde do painel fala. */
const PIXEL = PIXELS[0] ?? '';

/**
 * OS TOKENS DA CAPI. Um por pixel, na MESMA ORDEM de `META_PIXEL_ID`.
 *
 * POR QUE MAIS DE UM: token de conjunto de dados vale dentro da BM que o
 * emitiu. Um token da BM 1 mandando `Purchase` para o pixel da BM 2 leva
 * `OAuthException` — e o estrago é que **nada disso aparece na tela**: o site
 * não quebra, a venda acontece, o painel mostra o pedido pago, e só o log da
 * Vercel registra a recusa. A BM nova entrega, gasta e nunca aprende quem
 * compra, com as campanhas rodando aparentemente normais e o CPA subindo sem
 * explicação. É exatamente o sintoma que o comentário dos PIXELS acima
 * descreve, e que um pixel a mais sozinho NÃO resolve.
 *
 * UM TOKEN SÓ CONTINUA VALENDO para todos os pixels: quem tiver o conjunto de
 * dados compartilhado entre as BMs (ou um pixel só) não precisa mudar nada —
 * é o `?? TOKENS[0]` abaixo. Só que compartilhar conjunto de dados é um ativo
 * em comum entre as BMs, que é o laço que a separação em BMs existe para
 * evitar. Token por pixel mantém as duas coisas: cada BM vê a venda dela, e
 * um bloqueio não alcança a outra.
 */
const TOKENS = (process.env.META_CAPI_TOKEN ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

/** O token do pixel da posição `i`. Faltando, cai no primeiro — ver acima. */
function tokenDoPixel(i: number): string {
  return TOKENS[i] ?? TOKENS[0] ?? '';
}

const META_TOKEN = tokenDoPixel(0);
const VERSAO = 'v21.0';

const metaLigado = Boolean(PIXEL && META_TOKEN);

/* -------------------------------------------------------------------------- */
/* TIKTOK — Pixel + Events API. A compra sai daqui, do servidor, igual ao Meta */
/* -------------------------------------------------------------------------- */
/*
 * Mesma lógica do Meta: sem `TIKTOK_PIXEL_ID` e `TIKTOK_EVENTS_TOKEN` no
 * ambiente, `tiktokLigado` é falso e NADA sai — o funil vende igual. O token é
 * secreto (fica só na Vercel); o id do pixel é público (também está no
 * index.html). O evento de compra chama `CompletePayment`, que é o nome padrão
 * de "pagou" do TikTok — otimize a campanha por ele no Ads Manager.
 */
const TIKTOK_PIXEL_ID = (process.env.TIKTOK_PIXEL_ID ?? '').trim();
const TIKTOK_TOKEN = (process.env.TIKTOK_EVENTS_TOKEN ?? '').trim();
const tiktokLigado = Boolean(TIKTOK_PIXEL_ID && TIKTOK_TOKEN);

/*
 * ============================================================================
 * VÁRIOS PIXELS DO TIKTOK — uma conta de anúncio, um pixel, um link (08/10/2026)
 * ============================================================================
 *
 * O dono abriu contas novas para escalar "de lado". Cada conta tem o SEU pixel,
 * e a regra é a mesma do "TikTok separado do Face": a venda vai SÓ para o
 * pixel da conta que trouxe o clique. Mandar a todos faria cada conta contar a
 * venda das outras — ROAS inflado em todas e robô aprendendo com comprador que
 * não é dele.
 *
 * COMO SE SABE DE QUAL CONTA É A VISITA: o link do anúncio leva `?tt=<id do
 * pixel>`. O TikTok não tem macro que diga a conta, e o `ttclid` não revela de
 * quem é. O navegador guarda isso em `attrib.ttpx` (src/lib/atribuicao.ts),
 * carrega SÓ aquele pixel (index.html) e o pedido traz o `ttpx` até aqui.
 *
 * ONDE MORA CADA COISA:
 *   pixel principal   `TIKTOK_PIXEL_ID` + `TIKTOK_EVENTS_TOKEN`, na Vercel. É
 *                     o de quem chega SEM `?tt=` — nada muda para ele
 *   pixels a mais     no Redis (`config:tiktok-pixels`), cadastrados pelo painel
 *                     (`/admin/tiktok-pixels`). Mesmo motivo dos gateways:
 *                     conta nova não pode depender de abrir a Vercel e republicar
 *
 * O TOKEN SÓ ENTRA, NUNCA SAI — igual ao Secret dos gateways.
 *
 * `ttpx` DE PIXEL NÃO CADASTRADO NÃO CAI NO PRINCIPAL. Seria exatamente o
 * conflito que isto existe para evitar: a venda da conta B creditada à conta
 * A. Ela fica SEM envio (`metaEnviadoEm` nulo), o painel conta em "Purchase
 * faltando", e o botão de reenviar manda certo assim que o token for salvo.
 */
interface PixelTikTok {
  id: string;
  token: string;
  nome: string;
  criadoEm: string;
}

const CHAVE_PIXELS_TIKTOK = 'config:tiktok-pixels';
/** O formato do id de pixel do TikTok. O MESMO teste mora no index.html e em atribuicao.ts. */
const ID_DE_PIXEL_TIKTOK = /^[A-Z0-9]{16,24}$/;
let cacheDosPixelsTikTok: { valor: PixelTikTok[]; ate: number } | null = null;

async function lerPixelsTikTok(fresco = false): Promise<PixelTikTok[]> {
  if (!fresco && cacheDosPixelsTikTok && cacheDosPixelsTikTok.ate > Date.now()) return cacheDosPixelsTikTok.valor;
  let valor: PixelTikTok[] = [];
  const bruto = await redis(['GET', CHAVE_PIXELS_TIKTOK]);
  if (typeof bruto === 'string' && bruto) {
    try {
      const lista = JSON.parse(bruto) as Array<Partial<PixelTikTok>>;
      if (Array.isArray(lista)) {
        valor = lista
          .map((x) => ({
            id: String(x?.id ?? '').toUpperCase(),
            token: String(x?.token ?? ''),
            nome: String(x?.nome ?? ''),
            criadoEm: String(x?.criadoEm ?? ''),
          }))
          .filter((x) => ID_DE_PIXEL_TIKTOK.test(x.id));
      }
    } catch {
      /* JSON torto é o mesmo que nenhum pixel a mais. */
    }
  }
  /* 30 s: roda em toda venda e em todo evento espelhado do navegador. */
  cacheDosPixelsTikTok = { valor, ate: Date.now() + 30_000 };
  return valor;
}

async function gravarPixelsTikTok(lista: PixelTikTok[]): Promise<boolean> {
  if (!memoriaLigada) return false;
  const gravou = (await redis(['SET', CHAVE_PIXELS_TIKTOK, JSON.stringify(lista)])) !== null;
  if (gravou) cacheDosPixelsTikTok = { valor: lista, ate: Date.now() + 30_000 };
  return gravou;
}

/**
 * PARA QUAL PIXEL VAI ESTE EVENTO — e com o token de quem.
 *
 * `null` = não manda para ninguém. Ver o cabeçalho: pixel pedido e não
 * cadastrado NÃO vira o principal.
 */
async function pixelTikTokDe(attrib: Record<string, string> | undefined): Promise<{ id: string; token: string } | null> {
  const pedido = String(attrib?.ttpx ?? '').trim().toUpperCase();
  if (ID_DE_PIXEL_TIKTOK.test(pedido) && pedido !== TIKTOK_PIXEL_ID) {
    const achado = (await lerPixelsTikTok()).find((x) => x.id === pedido);
    if (achado?.token) return { id: achado.id, token: achado.token };
    console.error('[tiktok] a visita veio marcada com o pixel', pedido, 'e ele NAO tem token salvo no painel — evento nao enviado.');
    return null;
  }
  return tiktokLigado ? { id: TIKTOK_PIXEL_ID, token: TIKTOK_TOKEN } : null;
}

/**
 * O TOKEN SERVE PARA ESTE PIXEL? — sem criar evento nenhum.
 *
 * Um envio com a lista de eventos VAZIA: token bom leva erro de parâmetro,
 * token ruim leva erro de acesso. Nada entra no pixel nos dois casos. Quando a
 * resposta não deixa claro, o token é aceito e o motivo vai junto — recusar um
 * token certo por causa de um código que não se conhece seria pior.
 */
async function testarTokenTikTok(id: string, token: string): Promise<{ ok: boolean; aviso?: string }> {
  try {
    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': token },
      body: JSON.stringify({ event_source: 'web', event_source_id: id, data: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const resposta = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
    const recado = String(resposta.message ?? '').slice(0, 160);
    const codigo = Number(resposta.code);
    /* 401xx é a família de erro de acesso da Marketing API (token inválido,
       vencido, sem permissão para o pixel). */
    if (r.status === 401 || r.status === 403 || (codigo >= 40100 && codigo < 40200) || /access.?token|permission|unauthori/i.test(recado)) {
      return { ok: false, aviso: `O TikTok recusou o token para este pixel${recado ? `: ${recado}` : ''}.` };
    }
    return { ok: true };
  } catch (falha) {
    return { ok: true, aviso: `Salvei sem conseguir testar (${(falha as Error)?.message ?? 'sem resposta'}). O primeiro evento dirá.` };
  }
}

/*
 * MENOS TOKENS QUE PIXELS É AVISO NA SUBIDA, não erro silencioso.
 *
 * Sem isto, ligar uma BM nova em `META_PIXEL_ID` e esquecer o token dela faz o
 * pixel novo herdar o token do primeiro — que é justamente a combinação que o
 * Meta recusa. O funil venderia igual e a BM nova ficaria cega, sem nada na
 * tela dizendo por quê. Uma linha no log da Vercel é o que separa "descobrir
 * hoje" de "descobrir depois de gastar a semana inteira".
 */
if (PIXELS.length > 1 && TOKENS.length === 1) {
  console.warn(
    '[meta] ATENCAO:', PIXELS.length, 'pixels e 1 token so. Os pixels',
    PIXELS.slice(1).join(', '),
    'vao usar o token do primeiro -- se forem de outra BM, o Meta recusa o Purchase deles.',
  );
}

/** A TRADUÇÃO DOS PRODUTOS. Espelho de src/lib/pixel.ts — produto novo entra nos dois. */
const CODIGO_NEUTRO: Record<string, string> = {
  main: 'p1',
  salmos_150: 'p2',
  vela_7dias: 'p3',
  upsell: 'p4',
  downsell: 'p5',
  /* Código próprio, e não o `p1`: o preço por item sai do código, e p1 custa 47. */
  main_volta: 'p6',
  salmos_150_volta: 'p7',
  vela_7dias_volta: 'p8',
  /* As três contribuições de gratidão são o mesmo "produto" para a plataforma. */
  semente_10: 'p9',
  semente_25: 'p9',
  semente_50: 'p9',
};

/**
 * O PREÇO DE UM ITEM PELO CÓDIGO NEUTRO. Serve para mandar preço POR ITEM ao
 * Meta e ao TikTok sem mandar o produto: "p2 custa 27" não revela o que p2 é.
 * Sai do CATÁLOGO, o mesmo que cobra — nunca de uma tabela paralela.
 */
function precoDoCodigoNeutro(codigo: string): number | undefined {
  const id = Object.keys(CODIGO_NEUTRO).find((k) => CODIGO_NEUTRO[k] === codigo);
  return id ? CATALOGO[id]?.preco : undefined;
}

/** SHA-256 do valor normalizado, como o Meta pede: minúsculo e sem espaços. */
function embaralhar(valor: string | undefined): string | undefined {
  const limpo = (valor ?? '').trim().toLowerCase();
  if (!limpo) return undefined;
  return createHash('sha256').update(limpo).digest('hex');
}

/** Telefone só com dígitos e com o 55 do Brasil, senão a correspondência falha. */
function telefoneE164(tel: string | undefined): string | undefined {
  const so = (tel ?? '').replace(/\D+/g, '');
  if (so.length < 10) return undefined;
  return embaralhar(so.startsWith('55') ? so : `55${so}`);
}

/**
 * O IDENTIFICADOR DO CLIQUE — do cookie, ou construído do `fbclid`.
 *
 * ESTA FUNÇÃO É A ATRIBUIÇÃO. O cookie `_fbc` é criado pelo Pixel no navegador,
 * e nem sempre existe: navegador que bloqueia terceiros, aba anônima, iOS com
 * rastreamento restrito, ou simplesmente o Pixel não ter carregado a tempo.
 * Nesses casos a venda chegava ao Meta sem origem — dinheiro entrando e o
 * Gerenciador dizendo que nenhum anúncio vendeu.
 *
 * Mas o `fbclid` está na URL do clique, e nós o guardamos desde a primeira
 * carga (src/lib/atribuicao.ts). O formato do `_fbc` é público e simples:
 *
 *   fb.1.<milissegundos do clique>.<fbclid>
 *
 * Construir aqui é o mesmo que o Pixel faria, com a vantagem de funcionar
 * mesmo quando o Pixel não funcionou.
 *
 * O tempo usado é o do PEDIDO, não o de agora: é a marca mais próxima do
 * clique que temos guardada.
 */
export function montarFbc(attrib: Record<string, string> | undefined, criadoEm: string): string | undefined {
  const doCookie = attrib?.fbc?.trim();
  if (doCookie) return doCookie;
  const fbclid = attrib?.fbclid?.trim();
  if (!fbclid) return undefined;
  const quando = Date.parse(criadoEm);
  return `fb.1.${Number.isFinite(quando) ? quando : Date.now()}.${fbclid}`;
}

interface VendaParaOMeta {
  id: string;
  valor: number;
  itensNeutros: string[];
  email?: string;
  telefone?: string;
  nome?: string;
  attrib?: Record<string, string>;
  criadoEm: string;
  ua?: string;
  ip?: string;
  /** Quando o pagamento confirmou, em segundos. */
  quando?: number;
}

/** Telefone no formato E.164 com '+', como o TikTok pede, e depois SHA-256. */
function telefoneTikTok(tel: string | undefined): string | undefined {
  const so = (tel ?? '').replace(/\D+/g, '');
  if (so.length < 10) return undefined;
  return embaralhar(`+${so.startsWith('55') ? so : `55${so}`}`);
}

/**
 * VEIO DO TIKTOK? É o que decide para qual plataforma a venda vai. Uma venda
 * vai para UMA só — a do anúncio que a trouxe — senão a mesma compra aparece
 * atribuída (ou meio-atribuída, pelo casamento por e-mail/telefone) nas duas,
 * o ROAS mente para cima e os dois robôs otimizam com venda que não é deles.
 *
 * O sinal forte é o `ttclid` (o clique do TikTok, que só existe em quem veio de
 * lá). O `utm_source` é a rede de segurança para quando o clique não trouxe o
 * ttclid na URL.
 */
function veioDoTikTok(attrib: Record<string, string> | undefined): boolean {
  if (attrib?.ttclid?.trim()) return true;
  /* O link de uma conta do TikTok (`?tt=<pixel>`) também é TikTok, com ou sem clique. */
  if (attrib?.ttpx?.trim()) return true;
  return /tiktok|ttk|\bttclid\b/i.test(attrib?.origem ?? '');
}

/**
 * Manda a COMPRA para o TikTok (Events API 2.0) — o espelho de `enviarCompra`.
 *
 * NUNCA LANÇA. O `event_id` é o número do pedido: se a ZuckPay reenviar o aviso
 * (ela reenvia até receber 200), o TikTok descarta o duplicado. MESMA REGRA DE
 * CRENÇA do Meta: só sai código NEUTRO em `contents` — nada de nome de produto
 * nem do quiz.
 */
async function enviarCompraTikTok(v: VendaParaOMeta): Promise<boolean> {
  /* Qual pixel, e com o token de quem — ver VÁRIOS PIXELS DO TIKTOK, no topo. */
  const pixel = await pixelTikTokDe(v.attrib);
  if (!pixel) return false;
  try {
    const corpo = {
      event_source: 'web',
      event_source_id: pixel.id,
      data: [
        {
          event: 'CompletePayment',
          event_time: v.quando ?? Math.floor(Date.now() / 1000),
          /* O NÚMERO DO PEDIDO, igual ao Meta: é o que deduplica no TikTok. */
          event_id: v.id,
          user: {
            email: embaralhar(v.email),
            phone: telefoneTikTok(v.telefone),
            /* O clique e o cookie do TikTok — o que casa a venda com o anúncio. */
            ttclid: v.attrib?.ttclid,
            ttp: v.attrib?.ttp,
            /* IP e User-Agent casam a pessoa quando o cookie/clique falhou. */
            ip: v.ip,
            user_agent: v.ua,
          },
          properties: {
            currency: 'BRL',
            value: v.valor,
            content_type: 'product',
            contents: v.itensNeutros.map((id) => ({
              content_id: id,
              content_type: 'product',
              price: precoDoCodigoNeutro(id),
              quantity: 1,
            })),
          },
          page: { url: process.env.PUBLIC_BASE_URL ?? undefined },
        },
      ],
    };

    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': pixel.token },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(6000),
    });
    /*
     * A Events API responde HTTP 200 MESMO em erro de payload: o que diz se
     * deu certo é o `code` no corpo (0 = aceito). Ler só o status esconderia a
     * recusa — exatamente o erro silencioso que o comentário do Meta descreve.
     */
    const resposta = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
    if (!r.ok || resposta.code !== 0) {
      console.error('[tiktok] recusou o CompletePayment:', r.status, JSON.stringify(resposta).slice(0, 250));
      return false;
    }
    console.log('[tiktok] CompletePayment aceito:', v.id);
    return true;
  } catch (falha) {
    console.error('[tiktok] falhou:', (falha as Error)?.message);
    return false;
  }
}

/**
 * Manda o `Purchase`. Devolve `true` só quando o Meta confirmou o recebimento.
 *
 * NUNCA LANÇA. Um erro aqui não pode derrubar a resposta ao webhook: se a
 * ZuckPay não receber 200, ela reenvia o aviso — e um evento de medição que
 * falha não pode virar uma fila de reentregas no painel deles.
 */
async function enviarCompra(v: VendaParaOMeta): Promise<boolean> {
  /*
   * SEPARAÇÃO POR ORIGEM — o pedido do dono: "o que veio do TikTok fica marcado
   * SÓ para o TikTok, separado do Face". Veio do TikTok? A venda vai só para o
   * TikTok e NEM TOCA no Meta. Não veio? Segue o fluxo do Meta como sempre.
   *
   * Assim a mesma compra nunca aparece nas duas plataformas: cada robô otimiza
   * com a venda que é dele, e o ROAS de cada um é verdade. A deduplicação
   * DENTRO de cada plataforma continua sendo o `event_id` (o nº do pedido).
   */
  if (veioDoTikTok(v.attrib)) {
    return await enviarCompraTikTok(v);
  }
  /*
   * A VENDA ÓRFÃ, E POR QUE ELA AGORA VAI PARA O TIKTOK (24/09/2026)
   * --------------------------------------------------------------------------
   * Órfã é a venda que chegou sem `ttclid` e sem `utm_source` — a pessoa abriu
   * o link numa aba anônima, limpou o navegador, voltou pelo histórico. Ela
   * caía aqui, no ramo do Meta, e com a BM antiga removida `metaLigado` virou
   * falso: a venda não ia para lugar nenhum. Dinheiro na conta e nenhum robô
   * aprendendo com ele.
   *
   * COM SÓ UMA REDE COMPRANDO TRÁFEGO, ÓRFÃ É DELA. Não há a quem atribuir
   * errado: se o Meta está desligado, cada visita paga veio do TikTok. Mandar
   * para lá é a leitura mais honesta possível do dado, e é melhor que o
   * descarte, que ensina ao robô que aquele criativo não vende.
   *
   * NÃO DUPLICA, e a garantia é dupla: este `return` é exclusivo (venda que já
   * foi pelo ramo de cima nunca chega aqui), e o `event_id` continua sendo o
   * número do pedido — o TikTok descarta o repetido se a mesma venda passar
   * duas vezes por caminhos diferentes (webhook, consulta de status, varredura).
   *
   * Com o Meta LIGADO nada muda: órfã segue para o Meta, como sempre foi.
   */
  if (!metaLigado) {
    return tiktokLigado ? await enviarCompraTikTok(v) : false;
  }
  try {
    const nomes = (v.nome ?? '').trim().split(/\s+/);
    const corpo = {
      data: [
        {
          event_name: 'Purchase',
          event_time: v.quando ?? Math.floor(Date.now() / 1000),
          /*
           * `event_id` É O NÚMERO DO PEDIDO, e não um aleatório.
           *
           * É ele que permite ao Meta descartar o duplicado se o mesmo aviso
           * chegar duas vezes — e a ZuckPay REENVIA o aviso até receber 200.
           * Sem isso, uma venda vira duas no relatório e o ROAS mente para cima.
           */
          event_id: v.id,
          action_source: 'website',
          event_source_url: process.env.PUBLIC_BASE_URL ?? undefined,
          user_data: {
            em: embaralhar(v.email),
            ph: telefoneE164(v.telefone),
            fn: embaralhar(nomes[0]),
            ln: nomes.length > 1 ? embaralhar(nomes[nomes.length - 1]) : undefined,
            fbp: v.attrib?.fbp,
            fbc: montarFbc(v.attrib, v.criadoEm),
            /*
             * IP e User-Agent NÃO são luxo: são o que o Meta usa para casar a
             * pessoa quando o cookie falhou. Sem eles o evento entra e não é
             * atribuído a anúncio nenhum — que é exatamente o problema que
             * este arquivo existe para resolver.
             */
            client_ip_address: v.ip,
            client_user_agent: v.ua,
          },
          custom_data: {
            currency: 'BRL',
            value: v.valor,
            content_type: 'product',
            content_ids: v.itensNeutros,
            /*
             * PREÇO POR ITEM, em código neutro. Em 15/09/2026 o Meta acusou
             * "todos os Purchase do site mandam os mesmos dados de preço" (33
             * conjuntos afetados, ROAS estimado 7% maior ao corrigir): sem
             * `contents` ele só vê o total e não sabe que R$ 74 é 47 + 27. O
             * id continua p1/p2 — o preço não revela o produto; o nome revelaria.
             */
            contents: v.itensNeutros.map((codigo) => ({
              id: codigo,
              quantity: 1,
              item_price: precoDoCodigoNeutro(codigo),
            })),
            num_items: v.itensNeutros.length,
          },
        },
      ],
    };

    /*
     * VAI PARA TODOS OS PIXELS, e em PARALELO: são até quatro chamadas de rede
     * dentro de uma função com teto de 20 s, chamada de dentro da consulta de
     * status que a tela de quem pagou está esperando. Em sequência, o
     * quarto pixel herdaria a espera dos três primeiros.
     */
    const respostas = await Promise.all(
      PIXELS.map(async (pixel, i) => {
        /* O token da BM DESTE pixel. Ver `tokenDoPixel`, lá em cima. */
        const token = tokenDoPixel(i);
        if (!token) {
          console.error('[meta] pixel', pixel, 'sem token na posicao', i, '-- Purchase', v.id, 'nao foi enviado');
          return false;
        }
        try {
          const r = await fetch(
            `https://graph.facebook.com/${VERSAO}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(corpo),
              signal: AbortSignal.timeout(6000),
            },
          );
          const resposta = await r.json().catch(() => ({}));
          if (!r.ok) {
            console.error('[meta] pixel', pixel, 'recusou o Purchase:', r.status, JSON.stringify(resposta).slice(0, 250));
            return false;
          }
          console.log('[meta] Purchase aceito no pixel', pixel, ':', v.id, JSON.stringify(resposta).slice(0, 150));
          return true;
        } catch (falha) {
          console.error('[meta] pixel', pixel, 'falhou:', (falha as Error)?.message);
          return false;
        }
      }),
    );

    /*
     * UM PIXEL QUE ACEITA JÁ CARIMBA A VENDA. `metaEnviadoEm` é um só, então
     * não há como registrar "foi para o pixel A e não para o B" — e exigir que
     * TODOS aceitem faria o botão de reenvio mandar de novo aos que já
     * receberam, toda vez que um pixel qualquer estivesse fora do ar.
     *
     * O que falhou fica no log com o id do pixel, que é onde se procura quando
     * uma BM mostra menos venda que a outra.
     */
    const aceitos = respostas.filter(Boolean).length;
    if (aceitos && aceitos < PIXELS.length) {
      console.warn('[meta] Purchase', v.id, 'entrou em', aceitos, 'de', PIXELS.length, 'pixels');
    }
    return aceitos > 0;
  } catch (falha) {
    console.error('[meta] falhou:', (falha as Error)?.message);
    return false;
  }
}


/* -------------------------------------------------------------------------- */
/* TODOS OS EVENTOS PELO SERVIDOR (CAPI), e não só o Purchase                   */
/* -------------------------------------------------------------------------- */
/**
 * ============================================================================
 * POR QUE O MESMO EVENTO SAI DUAS VEZES — e por que isso NÃO conta duas vezes
 * ============================================================================
 *
 * O Pixel do navegador perde evento o tempo todo: bloqueador de anúncio, iOS,
 * aba fechada antes do script carregar. O que se perde não é só número no
 * relatório — é SINAL: o robô do Meta aprende com menos gente do que de fato
 * avançou no funil, e passa a mirar pior.
 *
 * A saída oficial do Meta é mandar o MESMO evento pelos dois caminhos com o
 * MESMO `event_id`. Ele junta os dois e conta UMA vez. É por isso que o
 * `event_id` aqui não é gerado no servidor: ele NASCE NO NAVEGADOR, junto com
 * a chamada do `fbq`, e viaja para cá. Gerar um novo aqui seria exatamente o
 * erro que a regra 6 do NOTAS.md descreve — dois sistemas medindo o mesmo
 * funil com ids diferentes, e cada evento contado em dobro.
 *
 * ============================================================================
 * O QUE ESTA FUNÇÃO RECUSA, e por que a lista é fechada
 * ============================================================================
 *
 * O corpo vem do NAVEGADOR, ou seja: de qualquer um com um `curl`. Sem lista
 * fechada, dá para mandar ao Meta qualquer nome de evento e qualquer conteúdo
 * em nome desta conta — inclusive palavra que revela crença, que é o que
 * bloqueou a conta anterior em 22/08/2026. Por isso:
 *
 *   • nome do evento: só os seis da lista. `Purchase` fica FORA de propósito —
 *     quem diz que houve venda é o gateway, nunca o navegador.
 *   • `content_ids`: só código neutro (`p1`..`p5`, `px`). Nada de texto livre.
 *   • `value`: número, com teto. `currency`: sempre BRL.
 *
 * Tudo que não casar com isso é descartado em silêncio — medição nunca derruba
 * a venda, e recusar um evento estranho é mais barato que explicar à Meta por
 * que a conta mandou dado sensível.
 */
const EVENTOS_DO_NAVEGADOR = new Set([
  'PageView', 'ViewContent', 'CompleteRegistration', 'InitiateCheckout', 'Lead', 'AddPaymentInfo',
]);

/** Só código neutro entra. Ver regra 8 do NOTAS.md. */
const CODIGO_NEUTRO_VALIDO = /^p[1-9]\d?$|^px$/;

interface EventoDoNavegador {
  nome: string;
  eventId: string;
  params?: Record<string, unknown>;
  attrib?: Record<string, string>;
  url?: string;
  email?: string;
  telefone?: string;
  ip?: string;
  ua?: string;
}

/** Limpa o `custom_data` que veio do navegador. O que não passa, não vai. */
function dadosLimpos(p: Record<string, unknown> | undefined): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  if (!p || typeof p !== 'object') return saida;
  const ids = Array.isArray(p.content_ids)
    ? p.content_ids.map(String).filter((x) => CODIGO_NEUTRO_VALIDO.test(x)).slice(0, 10)
    : [];
  if (ids.length) {
    saida.content_ids = ids;
    saida.content_type = 'product';
    /* O mesmo preço por item que o Purchase manda — foi o que o Meta pediu
       em 15/09/2026 ("todos os Purchase mandam os mesmos dados de preço"). */
    saida.contents = ids.map((id) => ({ id, quantity: 1, item_price: precoDoCodigoNeutro(id) }));
  }
  const valor = Number(p.value);
  /* Teto de R$ 10.000: o carrinho real não passa de R$ 88, e um número absurdo
     vindo do navegador estragaria o ROAS do Gerenciador sem estragar o site. */
  if (Number.isFinite(valor) && valor > 0 && valor <= 10_000) {
    saida.value = valor;
    saida.currency = 'BRL';
  }
  return saida;
}

/**
 * Manda ao Meta um evento que o navegador acabou de disparar. NUNCA LANÇA e
 * nunca é aguardado por quem responde ao visitante: a página não pode ficar
 * esperando o Meta para seguir o funil.
 */
/**
 * ============================================================================
 * O ESPELHO DO FUNIL PARA O TIKTOK — o que faltava para escalar lá
 * ============================================================================
 *
 * POR QUE ISTO EXISTE (19/09/2026): desde 16/09 cada evento do funil sai pelo
 * Pixel do navegador E pela CAPI do Meta, com o mesmo `event_id`. O TikTok só
 * tinha metade disso: o Pixel no navegador, e no servidor apenas o
 * `CompletePayment`. Ou seja, todo `ViewContent` e `InitiateCheckout` perdido
 * por bloqueador de anúncio, por iOS ou por aba fechada simplesmente não
 * existia para o robô do TikTok — e ele é quem decide para quem mostrar o
 * anúncio. Com o tráfego inteiro vindo de lá, essa metade faltando é a
 * diferença entre escalar e apagar incêndio.
 *
 * O `event_id` É O MESMO DO NAVEGADOR, e é ele que impede a contagem dupla: o
 * TikTok junta o evento do Pixel com o da Events API quando os dois trazem o
 * mesmo id. Sem isso, cada visita contaria duas vezes e o robô otimizaria em
 * cima de um funil que não existe — a regra 6 do NOTAS.md, do lado do TikTok.
 *
 * SÓ OS DOIS EVENTOS QUE O TIKTOK USA NESTE FUNIL, os mesmos que
 * `src/lib/pixel.ts` dispara no navegador. Nome fora da lista vira evento
 * personalizado lá também, e o robô passa a mirar em quem navega, não em quem
 * paga. `CompletePayment` continua fora daqui de propósito: ele nasce da
 * confirmação do pagamento, em `enviarCompraTikTok`.
 *
 * SÓ PARA QUEM VEIO DO TIKTOK. É a regra que o dono repetiu: "o que veio do
 * TikTok fica marcado só para o TikTok, separadamente do Face". Visitante sem
 * `ttclid` e sem `utm_source` de TikTok não tem como ser casado com anúncio de
 * lá mesmo — mandar geraria evento órfão e sujaria a taxa de correspondência.
 */
const EVENTOS_DO_TIKTOK: Record<string, string> = {
  ViewContent: 'ViewContent',
  InitiateCheckout: 'InitiateCheckout',
};

async function enviarEventoAoTikTok(e: EventoDoNavegador): Promise<void> {
  const nome = EVENTOS_DO_TIKTOK[e.nome];
  if (!nome) return;
  if (!veioDoTikTok(e.attrib)) return;
  /* O MESMO pixel que o navegador carregou: é o `event_id` igual nos dois
     lados, no MESMO pixel, que faz o TikTok contar uma vez só. */
  const pixel = await pixelTikTokDe(e.attrib);
  if (!pixel) return;
  const eventId = String(e.eventId ?? '').replace(/[^\w.-]/g, '').slice(0, 64);
  if (!eventId) return; // sem id não há dedupe, e sem dedupe é melhor não mandar

  try {
    const limpos = dadosLimpos(e.params);
    const codigos = Array.isArray(limpos.content_ids) ? (limpos.content_ids as string[]) : [];
    const corpo = {
      event_source: 'web',
      event_source_id: pixel.id,
      data: [
        {
          event: nome,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          user: {
            email: embaralhar(e.email),
            phone: telefoneTikTok(e.telefone),
            ttclid: e.attrib?.ttclid,
            ttp: e.attrib?.ttp,
            ip: e.ip,
            user_agent: e.ua,
          },
          properties: {
            currency: 'BRL',
            value: typeof limpos.value === 'number' ? limpos.value : undefined,
            content_type: 'product',
            contents: codigos.map((id) => ({
              content_id: id,
              content_type: 'product',
              price: precoDoCodigoNeutro(id),
              quantity: 1,
            })),
          },
          page: { url: e.url || process.env.PUBLIC_BASE_URL || undefined },
        },
      ],
    };

    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': pixel.token },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(6000),
    });
    /* A Events API devolve 200 mesmo recusando — quem diz é o `code`. Mesma
       armadilha descrita em `enviarCompraTikTok`. */
    const resposta = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
    if (!r.ok || resposta.code !== 0) {
      ultimoErroDoTikTok = `${nome}: ${resposta.message ?? r.status}`;
      console.error('[tiktok] recusou', nome, r.status, JSON.stringify(resposta).slice(0, 200));
      return;
    }
    console.log('[tiktok]', nome, 'aceito:', eventId);
  } catch (falha) {
    /* Medição nunca derruba a venda — regra 9. */
    console.error('[tiktok] falhou em', nome, (falha as Error)?.message);
  }
}

async function enviarEventoAoMeta(e: EventoDoNavegador): Promise<void> {
  if (!metaLigado) return;
  if (!EVENTOS_DO_NAVEGADOR.has(e.nome)) return;
  const eventId = String(e.eventId ?? '').replace(/[^\w.-]/g, '').slice(0, 64);
  if (!eventId) return; // sem id não há dedupe, e sem dedupe é melhor não mandar
  try {
    const corpo = {
      data: [
        {
          event_name: e.nome,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: 'website',
          event_source_url: e.url || process.env.PUBLIC_BASE_URL || undefined,
          user_data: {
            em: embaralhar(e.email),
            ph: telefoneE164(e.telefone),
            fbp: e.attrib?.fbp,
            fbc: montarFbc(e.attrib, new Date().toISOString()),
            client_ip_address: e.ip,
            client_user_agent: e.ua,
          },
          custom_data: dadosLimpos(e.params),
        },
      ],
    };
    await Promise.all(
      PIXELS.map(async (pixel, i) => {
        const token = tokenDoPixel(i);
        if (!token) return;
        try {
          const r = await fetch(
            `https://graph.facebook.com/${VERSAO}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(corpo),
              signal: AbortSignal.timeout(4000),
            },
          );
          if (!r.ok) {
            const resposta = await r.json().catch(() => ({}));
            console.warn('[capi]', e.nome, 'recusado no pixel', pixel, r.status, JSON.stringify(resposta).slice(0, 180));
          }
        } catch (falha) {
          console.warn('[capi]', e.nome, 'falhou:', (falha as Error)?.message);
        }
      }),
    );
  } catch (falha) {
    console.warn('[capi] erro montando', e.nome, (falha as Error)?.message);
  }
}

/* -------------------------------------------------------------------------- */
/* O GASTO, vindo do Meta                                                      */
/* -------------------------------------------------------------------------- */

/**
 * QUANTO CADA ANÚNCIO GASTOU — o número que faltava para o painel decidir.
 *
 * Sem gasto, a tabela por criativo dizia "CV9 vendeu 1, CV1 vendeu 0" e isso
 * NÃO É SUFICIENTE para cortar nada: um criativo que gastou R$ 5 sem vender é
 * barulho, e um que gastou R$ 35 sem vender é dinheiro queimado. A mesma linha,
 * lida sem o gasto, manda parar os dois.
 *
 * Medido em 05/09/2026, o primeiro dia com os dois lados na mesma tabela:
 * R$ 265 gastos, R$ 222 de receita, ROAS 0,84x -- mas TRÊS criativos com ROAS
 * acima de 2,1x e seis com zero. A média mandava desligar tudo; o detalhe
 * mandava escalar três.
 *
 * TOKEN SEPARADO DO DE CONVERSÕES, de propósito. Aquele só sabe mandar evento;
 * este só sabe LER anúncio. Se um vazar, o estrago é metade.
 *
 * SEM `META_ADS_TOKEN` A ROTA NÃO QUEBRA: ela devolve lista vazia e o painel
 * mostra a tabela sem as colunas de gasto, como fazia antes. Medição nunca
 * derruba o que já funcionava.
 */
const ADS_TOKEN = (process.env.META_ADS_TOKEN ?? '').trim();
const AD_ACCOUNT = (process.env.META_AD_ACCOUNT ?? '').trim();
const adsLigado = Boolean(ADS_TOKEN && AD_ACCOUNT);

/* --- TikTok Ads, SÓ LEITURA ------------------------------------------------ */
/*
 * A chave aqui é a da MARKETING API (um app de desenvolvedor autorizado pela
 * conta de anúncios), não a da Events API que manda a compra: uma não abre a
 * porta da outra. Sem as duas variáveis a área TikTok do painel abre em "não
 * conectado" e nada mais muda — o Meta continua exatamente igual.
 */
const TIKTOK_ADS_TOKEN = (process.env.TIKTOK_ADS_TOKEN ?? '').trim();
const TIKTOK_ADVERTISER_ID = (process.env.TIKTOK_ADVERTISER_ID ?? '').trim();
const tiktokAdsLigado = Boolean(TIKTOK_ADS_TOKEN && TIKTOK_ADVERTISER_ID);
/** O que o TikTok respondeu quando recusou a leitura. Vazio quando respondeu bem. */
let ultimoErroDoTikTok = '';

/**
 * O QUE O META DEVOLVE POR ANÚNCIO, GUARDADO SEMPRE EM NÚMERO BRUTO.
 *
 * ============================================================================
 * NENHUMA RAZÃO É GUARDADA AQUI — SÓ NUMERADOR E DENOMINADOR
 * ============================================================================
 *
 * O Meta devolve `ctr`, `cpc`, `cpm` e `frequency` prontos, e é tentador
 * guardá-los. Não guardo, porque a tabela SOMA linhas: o CTR de uma campanha
 * NÃO é a média dos CTRs dos anúncios dela. Um anúncio com 10 impressões e CTR
 * de 50% pesaria igual a outro com 100 mil impressões e CTR de 1%, e a campanha
 * apareceria com um CTR que nenhum anúncio teve.
 *
 * Guardando cliques e impressões, a razão é calculada DEPOIS da soma, em
 * qualquer nível, e sempre dá o número certo.
 */
interface GastoDoAnuncio {
  adId: string;
  nome: string;
  campanhaId: string;
  campanha: string;
  conjuntoId: string;
  conjunto: string;
  gasto: number;
  cliques: number;
  impressoes: number;
  /** Só os cliques NO LINK. O `clicks` cru conta curtida, comentário e "ver mais". */
  cliquesNoLink: number;
  /** Pessoas distintas. Frequência = impressões ÷ alcance, feita depois da soma. */
  alcance: number;
  /** O pixel confirmou que a página abriu. Clique que não vira visita é dinheiro perdido no caminho. */
  lpViews: number;
  /**
   * O Pixel disparou `InitiateCheckout`. Neste funil isso e o CLIQUE NO BOTAO
   * da VSL, nao o envio do formulario -- ver o disparo em OfferScreen.tsx.
   * E a etapa que revela quanta gente quis comprar e nao chegou a gerar o PIX.
   */
  ics: number;
  /** `CompleteRegistration` — quem terminou o quiz. */
  cadastros: number;
  /** Assistiram 3 s — o "hook". */
  video3s: number;
  /** Assistiram 75% — o "hold". */
  video75: number;
  /** Deram play. */
  videoIniciados: number;
}

/** Uma campanha, um conjunto ou um anúncio, como o Meta os conhece. */
interface EntidadeMeta {
  id: string;
  nome: string;
  nivel: 'campanha' | 'conjunto' | 'anuncio';
  /**
   * O que ESTA entidade tem ligado — `ACTIVE` ou `PAUSED`. É o que o
   * interruptor da tabela troca.
   */
  status: string;
  /**
   * O que o Meta está REALMENTE fazendo. Um anúncio `ACTIVE` dentro de uma
   * campanha pausada aparece ligado e não roda; sem `effective_status` o painel
   * mostraria o interruptor verde de um anúncio parado há três dias, e alguém
   * ficaria esperando venda de um criativo que nunca subiu.
   */
  efetivo: string;
  paiId: string;
  /** Em reais. O Meta manda em centavos, como texto. */
  orcamento: number | null;
  tipoOrcamento: 'diario' | 'vitalicio' | null;
  bid: number | null;
  objetivo: string;
  atualizadoEm: string;
  thumb: string | null;
}

const CAMPOS_INSIGHTS = [
  'ad_id',
  'ad_name',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'spend',
  'clicks',
  'impressions',
  'reach',
  'inline_link_clicks',
  'actions',
  'video_play_actions',
  'video_p75_watched_actions',
].join(',');

/** Soma os valores de uma lista de ações do Meta, opcionalmente de um tipo só. */
function somaAcao(lista: unknown, tipo?: string): number {
  if (!Array.isArray(lista)) return 0;
  let total = 0;
  for (const a of lista as Array<Record<string, unknown>>) {
    if (tipo && String(a.action_type ?? '') !== tipo) continue;
    total += Number(a.value ?? 0) || 0;
  }
  return total;
}

/** Uma chamada ao Meta que NUNCA estoura para cima: falhou, devolve o padrão. */
async function pedirAoMeta<T>(url: string, padrao: T, rotulo: string, ms = 9000): Promise<T> {
  if (!adsLigado) return padrao;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    const corpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const e = (corpo as Record<string, any>)?.error;
      ultimoErroDoMeta.ads = String(e?.message ?? `HTTP ${r.status}`).slice(0, 200);
      console.error(`[ads] ${rotulo} recusado:`, r.status, JSON.stringify(corpo).slice(0, 300));
      return padrao;
    }
    ultimoErroDoMeta.ads = '';
    return corpo as unknown as T;
  } catch (falha) {
    /*
     * O painel abre sem o gasto em vez de não abrir. Um relatório que falha
     * inteiro porque uma coluna faltou é um relatório que ninguém consulta.
     */
    console.error(`[ads] ${rotulo} falhou:`, (falha as Error)?.message);
    return padrao;
  }
}

async function gastoPorAnuncio(de: string, ate: string): Promise<GastoDoAnuncio[]> {
  if (!adsLigado) return [];
  /*
   * `time_range` E NAO `date_preset`: o preset do Meta ("today", "last_7d")
   * decide o dia pelo fuso da conta, e nos precisamos do MESMO intervalo que
   * foi usado para filtrar as vendas. Com dois calendarios diferentes, o
   * gasto de um dia encontra a venda de outro.
   */
  const intervalo = encodeURIComponent(JSON.stringify({ since: de, until: ate }));
  const url =
    `https://graph.facebook.com/${VERSAO}/${AD_ACCOUNT}/insights` +
    `?level=ad&fields=${CAMPOS_INSIGHTS}&time_range=${intervalo}&limit=500` +
    `&access_token=${encodeURIComponent(ADS_TOKEN)}`;
  const corpo = await pedirAoMeta<{ data?: Record<string, any>[] }>(url, {}, 'insights');
  return (corpo.data ?? []).map((x) => ({
    adId: String(x.ad_id ?? ''),
    nome: String(x.ad_name ?? ''),
    campanhaId: String(x.campaign_id ?? ''),
    campanha: String(x.campaign_name ?? ''),
    conjuntoId: String(x.adset_id ?? ''),
    conjunto: String(x.adset_name ?? ''),
    gasto: Number(x.spend ?? 0) || 0,
    cliques: Number(x.clicks ?? 0) || 0,
    impressoes: Number(x.impressions ?? 0) || 0,
    cliquesNoLink: Number(x.inline_link_clicks ?? 0) || 0,
    alcance: Number(x.reach ?? 0) || 0,
    lpViews: somaAcao(x.actions, 'landing_page_view'),
    /*
     * `initiate_checkout` E O AGREGADO, e e ele que se usa.
     *
     * Esta conta devolve o MESMO numero em tres chaves --
     * `initiate_checkout`, `offsite_conversion.fb_pixel_initiate_checkout` e
     * `offsite_initiate_checkout_add_20_s_calls`, todas 189 em 30 dias. Somar
     * as tres triplicaria a etapa do funil.
     */
    ics: somaAcao(x.actions, 'initiate_checkout'),
    cadastros: somaAcao(x.actions, 'complete_registration'),
    /* `video_view` dentro de `actions` é a contagem de 3 segundos. */
    video3s: somaAcao(x.actions, 'video_view'),
    video75: somaAcao(x.video_p75_watched_actions),
    videoIniciados: somaAcao(x.video_play_actions),
  }));
}

/**
 * AS ENTIDADES — nome, status e orçamento. É o que o `insights` NÃO devolve.
 *
 * ============================================================================
 * POR QUE É UMA CHAMADA SEPARADA, E POR QUE ELA TRAZ ANÚNCIO SEM GASTO
 * ============================================================================
 *
 * `insights` só conhece quem gastou. Um anúncio ligado que ainda não entregou,
 * ou um que foi pausado ontem, não aparece lá — e é exatamente esse que o dono
 * precisa ver, porque é nele que ele vai mexer. Sem esta chamada o interruptor
 * só existiria para quem já gastou, que é o oposto do que serve.
 *
 * As três descidas vão JUNTAS, então o custo é o da mais lenta, não a soma.
 */
async function entidadesDoMeta(): Promise<EntidadeMeta[]> {
  if (!adsLigado) return [];
  const chave = `&access_token=${encodeURIComponent(ADS_TOKEN)}`;
  const raiz = `https://graph.facebook.com/${VERSAO}/${AD_ACCOUNT}`;

  const [camp, conj, anun] = await Promise.all([
    pedirAoMeta<{ data?: Record<string, any>[] }>(
      `${raiz}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,updated_time&limit=200${chave}`,
      {},
      'campanhas',
    ),
    pedirAoMeta<{ data?: Record<string, any>[] }>(
      `${raiz}/adsets?fields=id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,bid_amount,updated_time&limit=300${chave}`,
      {},
      'conjuntos',
    ),
    pedirAoMeta<{ data?: Record<string, any>[] }>(
      `${raiz}/ads?fields=id,name,status,effective_status,adset_id,updated_time,creative{thumbnail_url}&limit=500${chave}`,
      {},
      'anuncios',
    ),
  ]);

  /* O Meta manda orçamento em CENTAVOS, e como texto. R$ 30,00 chega "3000". */
  const reais = (bruto: unknown): number | null => {
    const n = Number(bruto ?? '');
    return Number.isFinite(n) && n > 0 ? n / 100 : null;
  };

  const saida: EntidadeMeta[] = [];
  for (const c of camp.data ?? []) {
    const diario = reais(c.daily_budget);
    const vitalicio = reais(c.lifetime_budget);
    saida.push({
      id: String(c.id ?? ''),
      nome: String(c.name ?? ''),
      nivel: 'campanha',
      status: String(c.status ?? ''),
      efetivo: String(c.effective_status ?? c.status ?? ''),
      paiId: '',
      orcamento: diario ?? vitalicio,
      tipoOrcamento: diario ? 'diario' : vitalicio ? 'vitalicio' : null,
      bid: null,
      objetivo: String(c.objective ?? ''),
      atualizadoEm: String(c.updated_time ?? ''),
      thumb: null,
    });
  }
  for (const c of conj.data ?? []) {
    const diario = reais(c.daily_budget);
    const vitalicio = reais(c.lifetime_budget);
    saida.push({
      id: String(c.id ?? ''),
      nome: String(c.name ?? ''),
      nivel: 'conjunto',
      status: String(c.status ?? ''),
      efetivo: String(c.effective_status ?? c.status ?? ''),
      paiId: String(c.campaign_id ?? ''),
      orcamento: diario ?? vitalicio,
      tipoOrcamento: diario ? 'diario' : vitalicio ? 'vitalicio' : null,
      bid: reais(c.bid_amount),
      objetivo: '',
      atualizadoEm: String(c.updated_time ?? ''),
      thumb: null,
    });
  }
  for (const a of anun.data ?? []) {
    saida.push({
      id: String(a.id ?? ''),
      nome: String(a.name ?? ''),
      nivel: 'anuncio',
      status: String(a.status ?? ''),
      efetivo: String(a.effective_status ?? a.status ?? ''),
      paiId: String(a.adset_id ?? ''),
      orcamento: null,
      tipoOrcamento: null,
      bid: null,
      objetivo: '',
      atualizadoEm: String(a.updated_time ?? ''),
      thumb: (a.creative?.thumbnail_url as string) ?? null,
    });
  }
  return saida;
}

/**
 * LIGA E DESLIGA NO META DE VERDADE. É a única coisa neste projeto que ESCREVE
 * fora daqui.
 *
 * ============================================================================
 * SÓ DOIS VALORES, E NUNCA APAGAR
 * ============================================================================
 *
 * `ACTIVE` e `PAUSED`, mais nada. O mesmo `POST /{id}` que pausa também apaga
 * (`DELETED`), muda orçamento e troca público — e um painel que repassa
 * "qualquer campo que vier no corpo" é um painel em que um erro de digitação
 * zera o orçamento da campanha que está pagando as contas. Anúncio apagado não
 * volta: o histórico de aprendizado morre junto.
 *
 * O ID é conferido contra `^\d{5,}$` antes de sair daqui. Sem isso, um id com
 * barra viraria outro caminho na Graph API — e aí não é mais "pausar um
 * anúncio", é qualquer chamada que quem tem a senha do painel quiser fazer na
 * BM inteira.
 */
async function mudarStatusNoMeta(id: string, status: string): Promise<{ ok: boolean; erro?: string }> {
  if (!adsLigado) return { ok: false, erro: 'A conta de anúncios não está conectada.' };
  if (!/^\d{5,}$/.test(id)) return { ok: false, erro: 'Identificador inválido.' };
  if (status !== 'ACTIVE' && status !== 'PAUSED') return { ok: false, erro: 'Só dá para ativar ou pausar.' };
  try {
    const r = await fetch(`https://graph.facebook.com/${VERSAO}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status, access_token: ADS_TOKEN }).toString(),
      signal: AbortSignal.timeout(9000),
    });
    const corpo = (await r.json().catch(() => ({}))) as Record<string, any>;
    if (!r.ok || corpo.error) {
      /*
       * A MENSAGEM DO META VAI INTEIRA PARA A TELA. "Falhou" não diz se foi
       * permissão, se a campanha está em revisão ou se o token venceu — e cada
       * uma dessas tem uma saída diferente. `error_user_msg` é a versão que o
       * próprio Meta escreveu para humano ler.
       */
      const e = corpo.error ?? {};
      const msg = String(e.error_user_msg ?? e.message ?? `HTTP ${r.status}`);
      console.error('[ads] status recusado:', id, status, msg);
      return { ok: false, erro: msg };
    }
    return { ok: true };
  } catch (falha) {
    return { ok: false, erro: (falha as Error)?.message ?? 'Sem resposta do Meta.' };
  }
}

/**
 * O TOKEN PODE MEXER, OU SÓ OLHAR?
 *
 * O interruptor fica desligado e explicado quando o token só tem `ads_read`.
 * Descobrir isso ANTES é a diferença entre um botão que não faz nada e um aviso
 * que diz o que fazer.
 *
 * QUANDO A PRÓPRIA PERGUNTA FALHA, A RESPOSTA É "PODE". Um `debug_token` que
 * não respondeu não é prova de que falta permissão, e travar o painel por causa
 * de uma checagem instável seria pior: o dono ficaria sem conseguir pausar um
 * anúncio que está queimando dinheiro. Se não puder mesmo, o Meta recusa o POST
 * e a mensagem dele aparece na tela.
 */
/**
 * O QUE O META RESPONDEU DA ÚLTIMA VEZ.
 *
 * A tela dizia "Meta Ads: ligada" só porque as duas variáveis existiam — e em
 * 06/09/2026 elas existiam, o token era o mesmo do dia inteiro, e TODA chamada
 * voltava `API access blocked`. O painel mostrou integração verde com gasto
 * zero, que é a mesma armadilha do armazenamento suspenso: o defeito aparecia
 * como "dia parado".
 *
 * Agora "ligada" significa QUE RESPONDE, e o motivo da recusa vai para a tela.
 */
let ultimoErroDoMeta = { ads: '', capi: '' };

/* -------------------------------------------------------------------------- */
/* TIKTOK ADS — no MESMO formato do Meta, para passar pelas mesmas somas        */
/* -------------------------------------------------------------------------- */

/**
 * Uma ida à Marketing API do TikTok. Devolve `null` quando falhou — diferente
 * de lista vazia, que é resposta boa. O TikTok responde HTTP 200 mesmo
 * recusando: o que diz se deu certo é `code === 0` no corpo, igual à Events
 * API. Nunca lança — o painel abre sem a área TikTok em vez de não abrir.
 */
async function pedirAoTikTok<T>(
  caminho: string,
  params: Record<string, string>,
  rotulo: string,
  ms = 9000,
): Promise<T | null> {
  if (!tiktokAdsLigado) return null;
  try {
    const query = new URLSearchParams({ advertiser_id: TIKTOK_ADVERTISER_ID, ...params }).toString();
    const r = await fetch(`https://business-api.tiktok.com/open_api/v1.3${caminho}?${query}`, {
      headers: { 'Access-Token': TIKTOK_ADS_TOKEN },
      signal: AbortSignal.timeout(ms),
    });
    const corpo = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: T };
    if (!r.ok || corpo.code !== 0) {
      ultimoErroDoTikTok = String(corpo.message ?? `HTTP ${r.status}`).slice(0, 200);
      console.error(`[tiktok-ads] ${rotulo} recusado:`, r.status, JSON.stringify(corpo).slice(0, 300));
      return null;
    }
    ultimoErroDoTikTok = '';
    return (corpo.data ?? null) as T | null;
  } catch (falha) {
    ultimoErroDoTikTok = String((falha as Error)?.message ?? 'falhou').slice(0, 200);
    console.error(`[tiktok-ads] ${rotulo} falhou:`, (falha as Error)?.message);
    return null;
  }
}

const numeroTk = (x: unknown): number => Number(x ?? 0) || 0;

/**
 * O GASTO POR ANÚNCIO, do relatório integrado do TikTok — traduzido para o
 * MESMO `GastoDoAnuncio` do Meta, para que `juntarGastoComVendas`, `agrupar` e
 * `totalizar` façam a conta sem saber de qual rede veio (regra 13: nenhuma
 * fórmula de dinheiro nova).
 *
 * DUAS TENTATIVAS: a primeira pede também os eventos do pixel (ViewContent,
 * InitiateCheckout, CompletePayment). Conta que ainda não tem esses eventos
 * liberados no relatório recebe recusa da lista INTEIRA — aí sai a segunda,
 * só com o básico, em vez de a área abrir vazia.
 *
 * Tradução honesta: o TikTok não tem "visualização de página"; aqui `lpViews`
 * é o ViewContent (a tela da oferta abriu) e `video3s` é o "2 s assistidos",
 * que é o hook que o TikTok mede.
 */
async function gastoPorAnuncioTikTok(de: string, ate: string): Promise<GastoDoAnuncio[]> {
  if (!tiktokAdsLigado) return [];
  const basicas = [
    'spend', 'impressions', 'clicks', 'reach',
    'campaign_id', 'campaign_name', 'adgroup_id', 'adgroup_name', 'ad_name',
    'video_play_actions', 'video_watched_2s', 'video_views_p75',
  ];
  const doPixel = ['view_content', 'initiate_checkout', 'complete_payment'];
  type Relatorio = { list?: Array<{ dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> }> };
  const pedir = (metricas: string[]) =>
    pedirAoTikTok<Relatorio>(
      '/report/integrated/get/',
      {
        report_type: 'BASIC',
        data_level: 'AUCTION_AD',
        dimensions: JSON.stringify(['ad_id']),
        metrics: JSON.stringify(metricas),
        start_date: de,
        end_date: ate,
        page_size: '1000',
        page: '1',
      },
      'relatorio',
    );
  const corpo = (await pedir([...basicas, ...doPixel])) ?? (await pedir(basicas));
  return (corpo?.list ?? []).map((x) => {
    const m = x.metrics ?? {};
    return {
      adId: String(x.dimensions?.ad_id ?? ''),
      nome: String(m.ad_name ?? ''),
      campanhaId: String(m.campaign_id ?? ''),
      campanha: String(m.campaign_name ?? ''),
      conjuntoId: String(m.adgroup_id ?? ''),
      conjunto: String(m.adgroup_name ?? ''),
      gasto: numeroTk(m.spend),
      cliques: numeroTk(m.clicks),
      impressoes: numeroTk(m.impressions),
      cliquesNoLink: numeroTk(m.clicks),
      alcance: numeroTk(m.reach),
      lpViews: numeroTk(m.view_content),
      ics: numeroTk(m.initiate_checkout),
      cadastros: 0,
      video3s: numeroTk(m.video_watched_2s),
      video75: numeroTk(m.video_views_p75),
      videoIniciados: numeroTk(m.video_play_actions),
    };
  });
}

/**
 * CAMPANHA, GRUPO E ANÚNCIO do TikTok no formato `EntidadeMeta`. O "grupo de
 * anúncios" do TikTok é o "conjunto" do Meta. `operation_status` é o que está
 * LIGADO (ENABLE/DISABLE → ACTIVE/PAUSED, para a tela usar o mesmo filtro);
 * `secondary_status` é o que o TikTok está de fato FAZENDO (não entregando
 * por saldo, em aprendizado…) — vira o `efetivo`, sem o prefixo repetitivo.
 * Orçamento do TikTok já vem em reais, não em centavos como no Meta.
 */
async function entidadesDoTikTok(): Promise<EntidadeMeta[]> {
  if (!tiktokAdsLigado) return [];
  type Lista = { list?: Record<string, unknown>[] };
  const [camp, grupos, anun] = await Promise.all([
    pedirAoTikTok<Lista>('/campaign/get/', { page_size: '1000' }, 'campanhas'),
    pedirAoTikTok<Lista>('/adgroup/get/', { page_size: '1000' }, 'grupos'),
    pedirAoTikTok<Lista>('/ad/get/', { page_size: '1000' }, 'anuncios'),
  ]);
  const ligado = (op: unknown) => (String(op ?? '').toUpperCase() === 'ENABLE' ? 'ACTIVE' : 'PAUSED');
  const efetivo = (sec: unknown, op: unknown) => {
    const s = String(sec ?? '').replace(/^(CAMPAIGN|ADGROUP|AD)_STATUS_/, '');
    return s || ligado(op);
  };
  const orcamento = (b: unknown): number | null => {
    const n = Number(b ?? '');
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const tipo = (modo: unknown): 'diario' | 'vitalicio' | null =>
    modo === 'BUDGET_MODE_DAY' ? 'diario' : modo === 'BUDGET_MODE_TOTAL' ? 'vitalicio' : null;

  const saida: EntidadeMeta[] = [];
  for (const c of camp?.list ?? []) {
    saida.push({
      id: String(c.campaign_id ?? ''),
      nome: String(c.campaign_name ?? ''),
      nivel: 'campanha',
      status: ligado(c.operation_status),
      efetivo: efetivo(c.secondary_status, c.operation_status),
      paiId: '',
      orcamento: orcamento(c.budget),
      tipoOrcamento: tipo(c.budget_mode),
      bid: null,
      objetivo: String(c.objective_type ?? ''),
      atualizadoEm: String(c.modify_time ?? ''),
      thumb: null,
    });
  }
  for (const g of grupos?.list ?? []) {
    saida.push({
      id: String(g.adgroup_id ?? ''),
      nome: String(g.adgroup_name ?? ''),
      nivel: 'conjunto',
      status: ligado(g.operation_status),
      efetivo: efetivo(g.secondary_status, g.operation_status),
      paiId: String(g.campaign_id ?? ''),
      orcamento: orcamento(g.budget),
      tipoOrcamento: tipo(g.budget_mode),
      bid: orcamento(g.conversion_bid_price ?? g.bid_price),
      objetivo: String(g.optimization_goal ?? ''),
      atualizadoEm: String(g.modify_time ?? ''),
      thumb: null,
    });
  }
  for (const a of anun?.list ?? []) {
    saida.push({
      id: String(a.ad_id ?? ''),
      nome: String(a.ad_name ?? ''),
      nivel: 'anuncio',
      status: ligado(a.operation_status),
      efetivo: efetivo(a.secondary_status, a.operation_status),
      paiId: String(a.adgroup_id ?? ''),
      orcamento: null,
      tipoOrcamento: null,
      bid: null,
      objetivo: '',
      atualizadoEm: String(a.modify_time ?? ''),
      thumb: null,
    });
  }
  return saida;
}

/**
 * O token da CAPI está vivo?
 *
 * ============================================================================
 * A PERGUNTA É FEITA COM UMA LISTA DE EVENTOS VAZIA, e isso é o ponto
 * ============================================================================
 *
 * A primeira versão fazia um GET no conjunto de dados e voltou
 * `(#100) Missing Permission` — e eu quase transformei isso num alerta
 * vermelho dizendo que a venda não chegava ao Meta. **Era pergunta errada.**
 * Token de conjunto de dados serve para ESCREVER evento; ele não tem permissão
 * de ler o objeto, e nunca teve. O "erro" era o comportamento normal.
 *
 * `POST /events` com `data: []` faz o Meta validar o token e o conjunto, e
 * responder `events_received: 0`. Nenhum evento é criado — não há evento na
 * lista —, então não suja o Gerenciador nem inventa uma compra.
 *
 * MANDAR UM `Purchase` DE TESTE SERIA O CAMINHO ERRADO: o `event_id` novo não
 * seria descartado por dedupe, e o robô de otimização passaria a aprender com
 * uma venda que não existiu.
 */
async function capiResponde(): Promise<boolean> {
  if (!metaLigado) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/${VERSAO}/${encodeURIComponent(PIXEL)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [], access_token: META_TOKEN }),
      signal: AbortSignal.timeout(6000),
    });
    const corpo = (await r.json().catch(() => ({}))) as Record<string, any>;
    const e = corpo.error;
    /*
     * RECLAMAR DA LISTA VAZIA É A RESPOSTA BOA — e é ela que se procura.
     *
     * `(#100) param data must be non-empty` significa que o Meta CONFERIU o
     * token e o conjunto de dados, passou pela autenticação, e só então
     * esbarrou na validação do corpo. Porta aberta.
     *
     * NÃO DÁ PARA SEPARAR PELO `type`: o Meta devolve `OAuthException` tanto
     * para "acesso bloqueado" quanto para essa validação. Foi o que aconteceu
     * na primeira tentativa desta sonda. Quem separa é a mensagem, e ela é
     * inequívoca.
     */
    const reclamouDaListaVazia = /non-empty/i.test(String(e?.message ?? ''));
    if (e && !reclamouDaListaVazia) {
      ultimoErroDoMeta.capi = String(e.message ?? '').slice(0, 200);
      console.error('[capi] recusado:', ultimoErroDoMeta.capi);
      return false;
    }
    ultimoErroDoMeta.capi = '';
    return true;
  } catch (falha) {
    ultimoErroDoMeta.capi = (falha as Error)?.message ?? 'sem resposta';
    return false;
  }
}

async function podeGerenciarAnuncios(): Promise<boolean> {
  if (!adsLigado) return false;
  const url =
    `https://graph.facebook.com/${VERSAO}/debug_token?input_token=${encodeURIComponent(ADS_TOKEN)}` +
    `&access_token=${encodeURIComponent(ADS_TOKEN)}`;
  const corpo = await pedirAoMeta<{ data?: { scopes?: string[] } }>(url, {}, 'debug_token', 5000);
  const escopos = corpo.data?.scopes;
  if (!Array.isArray(escopos)) return true;
  return escopos.includes('ads_management');
}

/**
 * A CONTA DE ANÚNCIOS EM SI — nome, situação e saldo.
 *
 * A aba "Contas" existe por um motivo só, e não é enfeite: conta com cartão
 * recusado ou limite de gasto batido PARA DE ENTREGAR sem nenhum aviso na
 * tabela de anúncios. O painel mostraria "gasto zero hoje" e o dono procuraria
 * defeito no criativo, quando o problema é a cobrança.
 */
async function contaDeAnuncios(): Promise<Record<string, unknown> | null> {
  if (!adsLigado) return null;
  const campos = 'name,account_status,disable_reason,currency,amount_spent,spend_cap,balance,timezone_name';
  const url =
    `https://graph.facebook.com/${VERSAO}/${AD_ACCOUNT}?fields=${campos}` +
    `&access_token=${encodeURIComponent(ADS_TOKEN)}`;
  const c = await pedirAoMeta<Record<string, any>>(url, {}, 'conta', 6000);
  if (!c || !c.id) return null;
  /* Tudo em centavos do lado do Meta. Aqui vira real, uma vez só. */
  const reais = (b: unknown) => (Number(b ?? 0) || 0) / 100;
  return {
    id: String(c.id),
    nome: String(c.name ?? ''),
    situacao: Number(c.account_status ?? 0),
    motivo: Number(c.disable_reason ?? 0),
    moeda: String(c.currency ?? 'BRL'),
    gastoTotal: reais(c.amount_spent),
    teto: reais(c.spend_cap),
    saldo: reais(c.balance),
    fuso: String(c.timezone_name ?? ''),
  };
}

/* -------------------------------------------------------------------------- */
/* O PERÍODO — resolvido no servidor, e em São Paulo                          */
/* -------------------------------------------------------------------------- */

/**
 * O intervalo de datas de um período, e o intervalo ANTERIOR do mesmo tamanho.
 *
 * ============================================================================
 * POR QUE ISTO É RESOLVIDO AQUI, E NÃO NO NAVEGADOR
 * ============================================================================
 *
 * O relógio do navegador é o do visitante. Um dono viajando, ou um celular com
 * fuso errado, veria "hoje" começando em outra hora — e as vendas da madrugada
 * cairiam no dia anterior. O gasto, esse, o Meta calcula no fuso da CONTA DE
 * ANÚNCIOS. Duas réguas diferentes na mesma tabela é ROAS errado, e ROAS errado
 * manda escalar o criativo errado.
 *
 * Aqui existe uma régua só: America/Sao_Paulo, dos dois lados.
 *
 * ============================================================================
 * O PERÍODO ANTERIOR TEM O MESMO TAMANHO, e não "o mês passado"
 * ============================================================================
 *
 * Comparar 7 dias com 30 dias faria toda variação parecer despencar. O anterior
 * de "7d" são os 7 dias imediatamente antes; o de "ontem" é anteontem.
 */
interface Intervalo {
  de: string;
  ate: string;
  /** O mesmo número de dias, imediatamente antes. Para o "vs período anterior". */
  anteriorDe: string;
  anteriorAte: string;
  dias: number;
}

/** A data em São Paulo, com deslocamento em dias. */
function diaSP(deslocamento = 0, base?: Date): string {
  const d = new Date((base ?? new Date()).getTime() + deslocamento * 86_400_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(d);
}

/** Quantos dias, inclusive, entre duas datas `YYYY-MM-DD`. */
function diasEntre(de: string, ate: string): number {
  return Math.max(1, Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000) + 1);
}

function menos(dia: string, n: number): string {
  return new Date(Date.parse(dia) - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `hoje | ontem | 7d | 14d | 30d | mes | mes_passado | <de>:<ate>`
 *
 * Qualquer coisa que não bata cai em "hoje" — período inválido vindo da URL não
 * pode virar erro numa tela que o dono abre com pressa.
 */
/** O primeiro dia com checkout neste projeto. É o piso de "Todo o período". */
const INICIO_DA_OPERACAO = '2026-08-23';

function resolverPeriodo(bruto: string | undefined): Intervalo {
  const hoje = diaSP(0);
  let de = hoje;
  let ate = hoje;

  const pedido = String(bruto ?? 'hoje').trim();
  const personalizado = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(pedido);

  if (personalizado) {
    de = personalizado[1];
    ate = personalizado[2];
    if (Date.parse(de) > Date.parse(ate)) [de, ate] = [ate, de];
  } else if (pedido === 'ontem') {
    de = ate = diaSP(-1);
  } else if (pedido === '7d' || pedido === '14d' || pedido === '30d') {
    const n = Number.parseInt(pedido, 10);
    /*
     * O dia de HOJE ENTRA nos "últimos N dias" -- é o que o dono espera ao
     * abrir o painel de manhã e ver o que já aconteceu. O Meta faz igual no
     * `last_7d`, então as duas réguas continuam batendo.
     */
    de = menos(hoje, n - 1);
    ate = hoje;
  } else if (pedido === 'tudo') {
    /*
     * "TODO O PERÍODO" (pedido do dono, 11/10/2026): do começo da operação até
     * hoje. A data é a do primeiro checkout deste projeto (23/08/2026) — antes
     * dela não existe venda para contar, e uma data fixa é mais honesta que
     * "desde sempre": o painel mostra de quando até quando está somando.
     *
     * DUAS COISAS QUE ESTE PERÍODO NÃO CONSEGUE SER, e a tela diz:
     *   - as VISITAS (o funil do site) só existem dos últimos 60 dias — as
     *     contagens diárias expiram (ver `marcarEtapa`), então o funil de "todo
     *     o período" é o dos últimos 60 dias;
     *   - a comparação com o "período anterior" não faz sentido aqui.
     */
    de = INICIO_DA_OPERACAO;
    ate = hoje;
  } else if (pedido === 'mes') {
    de = `${hoje.slice(0, 7)}-01`;
    ate = hoje;
  } else if (pedido === 'mes_passado') {
    const primeiroDesteMes = `${hoje.slice(0, 7)}-01`;
    ate = menos(primeiroDesteMes, 1);
    de = `${ate.slice(0, 7)}-01`;
  }

  const dias = diasEntre(de, ate);
  return { de, ate, dias, anteriorAte: menos(de, 1), anteriorDe: menos(de, dias) };
}

/** As vendas dentro de um intervalo, pela data de CRIAÇÃO do pedido. */
function vendasDoIntervalo(vendas: Venda[], de: string, ate: string): Venda[] {
  /*
   * PELA CRIAÇÃO, e não pelo pagamento. O PIX é gerado num dia e às vezes pago
   * no seguinte: contando pelo pagamento, a venda apareceria num dia em que o
   * anúncio não gastou nada, e o ROAS daquele dia iria para o céu enquanto o
   * dia do clique ficaria zerado. Quem paga o anúncio é o clique.
   */
  return vendas.filter((v) => {
    const dia = diaSP(0, new Date(v.criadoEm));
    return dia >= de && dia <= ate;
  });
}

/* -------------------------------------------------------------------------- */
/* A AGREGAÇÃO — o que substitui as queries de um banco que não existe        */
/* -------------------------------------------------------------------------- */

/**
 * ============================================================================
 * NÃO HÁ SQL AQUI, E ISSO É DE PROJETO
 * ============================================================================
 *
 * Um painel de tráfego normalmente roda em cima de tabelas: `ad_insights_daily`,
 * `checkouts`, um `GROUP BY ad_id`. Esta operação não tem banco -- decisão
 * registrada no NOTAS.md. Cada venda é um arquivo JSON no armazenamento, e o
 * gasto vem AO VIVO do Meta a cada abertura da tela.
 *
 * O que um `GROUP BY` faria, estas funções fazem em memória. A garantia que
 * importa é a mesma: **a soma acontece no servidor**, e o navegador recebe
 * linhas prontas. Somar no navegador significaria mandar a lista inteira de
 * clientes para a tela toda vez -- e cada pessoa que abre o painel baixaria a
 * carteira completa só para ver um total.
 *
 * O LIMITE HONESTO DESTE DESENHO: ele lê até 200 vendas por vez. Serve com
 * folga para o volume de hoje (dezenas por dia). Quando passar de alguns
 * milhares, o certo é um banco de verdade -- e aí estas funções viram as
 * queries que elas hoje imitam. Está escrito aqui para ninguém descobrir isso
 * por acidente, num dia de pico.
 */

/**
 * UMA LINHA DA TABELA — anúncio, conjunto ou campanha.
 *
 * TUDO AQUI É SOMÁVEL. Nenhum campo é uma razão: CTR, CPC, CPM, ROAS, margem e
 * as taxas de vídeo são calculados na tela, DEPOIS da soma, a partir destes
 * números. É o que permite trocar de aba (Campanhas → Conjuntos → Anúncios) sem
 * pedir nada de novo ao servidor e sem risco de a soma de cima discordar das
 * linhas de baixo.
 */
interface LinhaDeDesempenho {
  id: string;
  nome: string;
  campanhaId: string;
  campanha: string;
  conjuntoId: string;
  conjunto: string;

  /* --- o que veio do Meta --- */
  gasto: number;
  cliques: number;
  cliquesNoLink: number;
  impressoes: number;
  alcance: number;
  lpViews: number;
  ics: number;
  cadastros: number;
  video3s: number;
  video75: number;
  videoIniciados: number;

  /* --- o que veio do nosso lado --- */
  /** Cobranças geradas no período (todas, pagas ou não). É o IC deste funil. */
  pix: number;
  pagas: number;
  receita: number;
  /** Pendentes que ainda podem virar pagamento. */
  pendentes: number;
  receitaPendente: number;
  /** Recusadas e expiradas — o denominador da taxa de aprovação. */
  recusadas: number;
  reembolsadas: number;
  receitaReembolsada: number;
  /**
   * A TAXA QUE O GATEWAY REALMENTE COBROU, somada venda por venda (03/10/2026),
   * e a receita que ela cobre. Só entra aqui a venda paga que tem `valorLiquido`
   * gravado: bruto − líquido é a taxa daquela venda, sem ninguém digitar
   * percentual. O resto da receita continua estimado pela taxa da aba Taxas —
   * ver `totalizar`.
   */
  taxasReais: number;
  receitaComTaxaReal: number;

  /* --- o que veio do Meta sobre o objeto, não sobre o desempenho --- */
  status: string;
  efetivo: string;
  orcamento: number | null;
  tipoOrcamento: string | null;
  objetivo: string;
  atualizadoEm: string;
  thumb: string | null;
}

/** Uma linha zerada, com identidade. Todo lugar que cria linha passa por aqui. */
function linhaVazia(id: string, nome: string): LinhaDeDesempenho {
  return {
    id,
    nome,
    campanhaId: '',
    campanha: '',
    conjuntoId: '',
    conjunto: '',
    gasto: 0,
    cliques: 0,
    cliquesNoLink: 0,
    impressoes: 0,
    alcance: 0,
    lpViews: 0,
    ics: 0,
    cadastros: 0,
    video3s: 0,
    video75: 0,
    videoIniciados: 0,
    pix: 0,
    pagas: 0,
    receita: 0,
    pendentes: 0,
    receitaPendente: 0,
    recusadas: 0,
    reembolsadas: 0,
    receitaReembolsada: 0,
    taxasReais: 0,
    receitaComTaxaReal: 0,
    status: '',
    efetivo: '',
    orcamento: null,
    tipoOrcamento: null,
    objetivo: '',
    atualizadoEm: '',
    thumb: null,
  };
}

/**
 * O ID DO ANÚNCIO QUE VEIO NO CARIMBO DA VENDA.
 *
 * O `utm_content` pode chegar como "CV9|120252240937490723" (nome|id) OU como o
 * ID cru "120252240937490723" — depende de como o parâmetro de URL do anúncio
 * foi montado. É pelo ID que se junta com o Meta, nunca pelo nome: dois anúncios
 * podem ter o mesmo nome, e nesta conta já têm.
 *
 * QUANDO NÃO HÁ "|", O CARIMBO JÁ É O PRÓPRIO ID. Sem este fallback, a venda cai
 * como "sem anúncio" mesmo com o clique corretamente atribuído — foi o que
 * aconteceu em 14/09/2026 com o `ad2`, cujos anúncios mandavam só `{{ad.id}}`.
 */
function adIdDaVenda(v: Venda): string {
  const bruto = (v.attrib?.criativo ?? '').trim();
  if (!bruto) return '';
  return bruto.includes('|') ? bruto.split('|').pop()!.trim() : bruto;
}

/** Soma os números de uma linha na outra. A identidade fica com o destino. */
function somarNa(destino: LinhaDeDesempenho, l: LinhaDeDesempenho): void {
  destino.gasto += l.gasto;
  destino.cliques += l.cliques;
  destino.cliquesNoLink += l.cliquesNoLink;
  destino.impressoes += l.impressoes;
  destino.alcance += l.alcance;
  destino.lpViews += l.lpViews;
  destino.ics += l.ics;
  destino.cadastros += l.cadastros;
  destino.video3s += l.video3s;
  destino.video75 += l.video75;
  destino.videoIniciados += l.videoIniciados;
  destino.pix += l.pix;
  destino.pagas += l.pagas;
  destino.receita += l.receita;
  destino.pendentes += l.pendentes;
  destino.receitaPendente += l.receitaPendente;
  destino.recusadas += l.recusadas;
  destino.reembolsadas += l.reembolsadas;
  destino.receitaReembolsada += l.receitaReembolsada;
  destino.taxasReais += l.taxasReais;
  destino.receitaComTaxaReal += l.receitaComTaxaReal;
}

/** Onde cada status da venda entra na linha. Um lugar só, para não divergir. */
function contarVenda(linha: LinhaDeDesempenho, v: Venda): void {
  linha.pix += 1;
  const valor = v.valor ?? 0;
  if (v.status === 'completed') {
    linha.pagas += 1;
    linha.receita += valor;
    /* Líquido maior que o bruto é impossível (taxa não paga o vendedor): aí o
       dado é descartado e a venda cai na estimativa, como as que não têm. */
    const liquidoReal = v.valorLiquido;
    if (typeof liquidoReal === 'number' && liquidoReal > 0 && liquidoReal <= valor) {
      linha.taxasReais += valor - liquidoReal;
      linha.receitaComTaxaReal += valor;
    }
  } else if (v.status === 'pending') {
    linha.pendentes += 1;
    linha.receitaPendente += valor;
  } else if (v.status === 'refunded') {
    /*
     * REEMBOLSO NÃO ENTRA EM `pagas`, e sai da receita. Contá-lo como venda
     * infla o ROAS de um criativo que na prática deu prejuízo — e é justamente
     * o criativo que atrai reembolso que alguém escalaria por engano.
     */
    linha.reembolsadas += 1;
    linha.receitaReembolsada += valor;
  } else {
    /* `cancelled`, `expired`, `failed`: PIX que nasceu e não virou dinheiro. */
    linha.recusadas += 1;
  }
}

/**
 * Junta o gasto (do Meta), as entidades (do Meta) e as vendas (nossas), por ID.
 *
 * VENDA SEM ID DE ANÚNCIO NÃO ENTRA AQUI. Ela vai para "não atribuídas", e é
 * assim que tem de ser: espalhar venda órfã pelas linhas infla o ROAS de quem
 * não vendeu e faz escalar o errado. O painel prefere dizer "não sei de onde
 * veio" a dizer um número bonito e falso.
 *
 * ANÚNCIO SEM GASTO E SEM VENDA TAMBÉM ENTRA, se ele existe na conta. É o
 * criativo recém-subido que ainda não entregou, e é o primeiro que o dono
 * procura na tela — ele quer ver o interruptor, não uma tabela onde o anúncio
 * some até gastar.
 */
function juntarGastoComVendas(
  gasto: GastoDoAnuncio[],
  vendas: Venda[],
  entidades: EntidadeMeta[] = [],
): LinhaDeDesempenho[] {
  const porId = new Map<string, LinhaDeDesempenho>();
  const anuncios = entidades.filter((e) => e.nivel === 'anuncio');
  const conjuntos = new Map(entidades.filter((e) => e.nivel === 'conjunto').map((e) => [e.id, e]));
  const campanhas = new Map(entidades.filter((e) => e.nivel === 'campanha').map((e) => [e.id, e]));

  /* 1. Todo anúncio que EXISTE na conta vira linha, mesmo zerado. */
  for (const a of anuncios) {
    const l = linhaVazia(a.id, a.nome);
    const conj = conjuntos.get(a.paiId);
    const camp = conj ? campanhas.get(conj.paiId) : undefined;
    l.conjuntoId = conj?.id ?? '';
    l.conjunto = conj?.nome ?? '';
    l.campanhaId = camp?.id ?? '';
    l.campanha = camp?.nome ?? '';
    l.status = a.status;
    l.efetivo = a.efetivo;
    l.atualizadoEm = a.atualizadoEm;
    l.thumb = a.thumb;
    porId.set(a.id, l);
  }

  /* 2. O gasto entra por cima — e cria a linha se o anúncio não veio na lista. */
  for (const g of gasto) {
    const l = porId.get(g.adId) ?? linhaVazia(g.adId, g.nome);
    if (!l.nome) l.nome = g.nome;
    l.campanhaId = l.campanhaId || g.campanhaId;
    l.campanha = l.campanha || g.campanha;
    l.conjuntoId = l.conjuntoId || g.conjuntoId;
    l.conjunto = l.conjunto || g.conjunto;
    l.gasto += g.gasto;
    l.cliques += g.cliques;
    l.cliquesNoLink += g.cliquesNoLink;
    l.impressoes += g.impressoes;
    l.alcance += g.alcance;
    l.lpViews += g.lpViews;
    l.ics += g.ics;
    l.cadastros += g.cadastros;
    l.video3s += g.video3s;
    l.video75 += g.video75;
    l.videoIniciados += g.videoIniciados;
    porId.set(g.adId, l);
  }

  /* 3. As vendas. */
  for (const v of vendas) {
    const id = adIdDaVenda(v);
    if (!id) continue;
    /*
     * Anúncio que VENDEU mas não aparece no gasto do período existe: a venda
     * pode ter vindo de um clique de ontem, ou o anúncio foi pausado hoje.
     * Criar a linha com gasto zero é mais honesto que sumir com a venda.
     */
    const linha = porId.get(id) ?? linhaVazia(id, (v.attrib?.criativo ?? '').split('|')[0] || id);
    if (!linha.campanha) linha.campanha = v.attrib?.campanha ?? '';
    if (!linha.conjunto) linha.conjunto = v.attrib?.conjunto ?? '';
    contarVenda(linha, v);
    porId.set(id, linha);
  }

  return [...porId.values()].sort((a, b) => b.gasto - a.gasto || b.receita - a.receita);
}

/**
 * Sobe as linhas de anúncio para conjunto ou campanha.
 *
 * A CHAVE É O ID, NUNCA O NOME. Dois anúncios com o mesmo nome existem nesta
 * conta, e agrupar por nome juntaria duas campanhas diferentes numa linha só —
 * com o gasto certo e a atribuição de outra. O nome é só o rótulo da linha.
 */
function agrupar(
  linhas: LinhaDeDesempenho[],
  nivel: 'conjunto' | 'campanha',
  entidades: EntidadeMeta[] = [],
): LinhaDeDesempenho[] {
  const mapa = new Map<string, LinhaDeDesempenho>();
  const meta = new Map(entidades.filter((e) => e.nivel === nivel).map((e) => [e.id, e]));

  for (const l of linhas) {
    const id = nivel === 'campanha' ? l.campanhaId : l.conjuntoId;
    const nome = nivel === 'campanha' ? l.campanha : l.conjunto;
    const chave = id || nome || '(sem nome)';
    let atual = mapa.get(chave);
    if (!atual) {
      atual = linhaVazia(chave, nome || chave);
      if (nivel === 'campanha') {
        atual.campanhaId = id;
        atual.campanha = nome;
      } else {
        atual.conjuntoId = id;
        atual.conjunto = nome;
        atual.campanhaId = l.campanhaId;
        atual.campanha = l.campanha;
      }
      const e = meta.get(id);
      if (e) {
        atual.status = e.status;
        atual.efetivo = e.efetivo;
        atual.orcamento = e.orcamento;
        atual.tipoOrcamento = e.tipoOrcamento;
        atual.objetivo = e.objetivo;
        atual.atualizadoEm = e.atualizadoEm;
      }
      mapa.set(chave, atual);
    }
    somarNa(atual, l);
  }

  /*
   * Campanha e conjunto que existem e não têm anúncio com gasto nem venda
   * entram zerados. É o conjunto recém-criado, e ele precisa aparecer para
   * poder ser ligado.
   */
  for (const e of meta.values()) {
    if (mapa.has(e.id)) continue;
    const l = linhaVazia(e.id, e.nome);
    l.status = e.status;
    l.efetivo = e.efetivo;
    l.orcamento = e.orcamento;
    l.tipoOrcamento = e.tipoOrcamento;
    l.objetivo = e.objetivo;
    l.atualizadoEm = e.atualizadoEm;
    if (nivel === 'campanha') {
      l.campanhaId = e.id;
      l.campanha = e.nome;
    } else {
      l.conjuntoId = e.id;
      l.conjunto = e.nome;
    }
    mapa.set(e.id, l);
  }

  return [...mapa.values()].sort((a, b) => b.gasto - a.gasto || b.receita - a.receita);
}

/**
 * AS VENDAS AGRUPADAS POR UMA DIMENSÃO DA URL (`utm_source`, `utm_campaign`…).
 *
 * ============================================================================
 * ESTA TABELA NÃO TEM GASTO, E NÃO É ESQUECIMENTO
 * ============================================================================
 *
 * O gasto do Meta vem por `ad_id`. `utm_source` não é um objeto do Meta: não
 * existe "quanto gastei no utm_source=fb". Inventar um rateio aqui produziria
 * um ROAS por origem que parece informação e é chute.
 *
 * O que esta tabela responde é outra pergunta, e uma que a tabela de anúncios
 * não responde: **de onde vem o dinheiro que o Gerenciador não credita a
 * ninguém.** É aqui que aparece a venda orgânica, a do link direto e a que
 * perdeu o carimbo — e é olhando para cá que se descobre marcação quebrada.
 */
function porUtm(vendas: Venda[], campo: string): LinhaDeDesempenho[] {
  const mapa = new Map<string, LinhaDeDesempenho>();
  for (const v of vendas) {
    const bruto = (v.attrib?.[campo] ?? '').trim();
    const chave = bruto || '(sem marcação)';
    let l = mapa.get(chave);
    if (!l) {
      l = linhaVazia(chave, chave);
      mapa.set(chave, l);
    }
    contarVenda(l, v);
  }
  return [...mapa.values()].sort((a, b) => b.receita - a.receita || b.pix - a.pix);
}

/**
 * ============================================================================
 * OS TOTAIS E O LUCRO — as fórmulas em UM lugar só
 * ============================================================================
 *
 * Cada número daqui existe uma vez. A tela não recalcula lucro, nem ROI, nem
 * margem: se recalculasse, um dia o cartão do topo e a linha da tabela dariam
 * respostas diferentes, e ninguém saberia em qual acreditar.
 *
 * A CADEIA, na ordem em que o dinheiro sai:
 *
 *   bruto      = o que entrou (só as pagas)
 *   líquido    = bruto − taxa do gateway − imposto sobre vendas
 *   lucro      = líquido − anúncios − custo do produto − despesas
 *                        − reembolsos − imposto sobre a mídia
 */
interface Custos {
  taxaPct: number | null;
  impostoPct: number | null;
  custoPorVenda: number;
  impostoAdsPct: number;
  despesas: number;
}

function totalizar(linhas: LinhaDeDesempenho[], orfas: Venda[], custos: Custos) {
  const soma = linhaVazia('total', 'Total');
  for (const l of linhas) somarNa(soma, l);
  /* As órfãs entram nos totais e em lugar nenhum mais — elas não têm anúncio. */
  for (const v of orfas) contarVenda(soma, v);

  const bruto = soma.receita;
  const gasto = soma.gasto;

  /*
   * O LUCRO SÓ APARECE SE OS CUSTOS ESTIVEREM CONFIGURADOS.
   *
   * A taxa do gateway e o imposto são do dono e ninguém aqui sabe de cor.
   *
   * VARIÁVEL VAZIA NÃO É ZERO. `Number('')` devolve 0, que é finito -- e a
   * primeira versão disto mostrou "lucro R$ 77,91" num painel sem custo nenhum
   * configurado, como se a taxa do gateway e o imposto fossem 0%. Lucro
   * inventado é pior que lucro ausente, porque se decide em cima dele.
   */
  /*
   * A TAXA VEM DO GATEWAY QUANDO ELE A INFORMA, e só o resto é estimado.
   *
   * Pedido do dono (03/10/2026), depois de o painel mostrar R$ 133,26 de
   * líquido onde a Pagou.ai liquidaria R$ 122,39: a aba Taxas tinha 5,49%, e a
   * taxa de verdade era 7,9% + R$ 2,49 por venda. Percentual digitado não
   * acompanha troca de gateway nem taxa fixa.
   *
   * Agora: a parte da receita que tem líquido informado usa a taxa REAL
   * (`taxasReais`); a parte que não tem (outro gateway, venda antiga, cartão)
   * usa o percentual da aba Taxas. Se TODA a receita tem taxa real, o
   * percentual nem é necessário.
   */
  const semTaxaReal = Math.max(0, bruto - soma.receitaComTaxaReal);
  const precisaDoPercentual = semTaxaReal > 0.005;
  const temCustos = custos.impostoPct !== null && (custos.taxaPct !== null || !precisaDoPercentual);
  const taxas = temCustos ? soma.taxasReais + (precisaDoPercentual ? semTaxaReal * (custos.taxaPct! / 100) : 0) : 0;
  const impostoVendas = temCustos ? bruto * (custos.impostoPct! / 100) : 0;
  const custoProduto = soma.pagas * custos.custoPorVenda;
  const impostoAds = gasto * (custos.impostoAdsPct / 100);
  const liquido = temCustos ? bruto - taxas - impostoVendas : null;
  const lucro =
    liquido === null
      ? null
      : liquido - gasto - custoProduto - custos.despesas - soma.receitaReembolsada - impostoAds;

  /* A taxa de aprovação: de tudo que virou cobrança, quanto virou dinheiro. */
  const tentativas = soma.pagas + soma.recusadas + soma.pendentes;

  return {
    /* --- volume --- */
    gasto,
    cliques: soma.cliques,
    cliquesNoLink: soma.cliquesNoLink,
    impressoes: soma.impressoes,
    alcance: soma.alcance,
    lpViews: soma.lpViews,
    ics: soma.ics,
    cadastros: soma.cadastros,
    pix: soma.pix,
    pagas: soma.pagas,
    pendentes: soma.pendentes,
    recusadas: soma.recusadas,
    reembolsadas: soma.reembolsadas,

    /* --- dinheiro --- */
    receita: bruto,
    receitaPendente: soma.receitaPendente,
    receitaReembolsada: soma.receitaReembolsada,
    taxas: temCustos ? taxas : null,
    impostoVendas: temCustos ? impostoVendas : null,
    custoProduto: custos.custoPorVenda > 0 ? custoProduto : null,
    despesas: custos.despesas,
    impostoAds: custos.impostoAdsPct > 0 ? impostoAds : null,
    liquido,
    lucro,

    /* --- razões: N/A quando não há denominador, nunca zero mentiroso --- */
    cpa: soma.pagas > 0 ? gasto / soma.pagas : null,
    cpi: soma.pix > 0 ? gasto / soma.pix : null,
    cpc: soma.cliques > 0 ? gasto / soma.cliques : null,
    ctr: soma.impressoes > 0 ? soma.cliques / soma.impressoes : null,
    cpm: soma.impressoes > 0 ? (gasto / soma.impressoes) * 1000 : null,
    roas: gasto > 0 ? bruto / gasto : null,
    roi: lucro !== null && gasto > 0 ? lucro / gasto : null,
    margem: lucro !== null && bruto > 0 ? lucro / bruto : null,
    ticket: soma.pagas > 0 ? bruto / soma.pagas : null,
    aprovacao: tentativas > 0 ? soma.pagas / tentativas : null,
    reembolsoPct: bruto > 0 ? soma.receitaReembolsada / bruto : null,
    conversao: soma.pix > 0 ? soma.pagas / soma.pix : null,

    /*
     * A SAÚDE DO RASTREIO. Venda sem carimbo de anúncio não é detalhe: é
     * dinheiro que entrou e que o Gerenciador não vai creditar a criativo
     * nenhum. Se esta porcentagem cair, alguma coisa quebrou na marcação das
     * URLs, e é melhor descobrir por aqui do que pelo ROAS despencando sem
     * explicação.
     */
    atribuidas: soma.pix > 0 ? 1 - orfas.length / soma.pix : null,
    orfas: orfas.length,
  };
}

/**
 * A MESMA CONTA DA LINHA DE CIMA, APLICADA A UMA LINHA SÓ.
 *
 * ============================================================================
 * POR QUE O SERVIDOR CALCULA ROAS E LUCRO DE CADA LINHA, E NÃO A TELA
 * ============================================================================
 *
 * A alternativa era mandar os números crus e deixar a tela dividir. Ela teria
 * de reescrever as mesmas onze fórmulas, e no dia em que uma das duas mudasse,
 * o cartão do topo e a linha da tabela diriam coisas diferentes sobre o mesmo
 * período — com o dono decidindo em cima de qual dos dois ele viu primeiro.
 *
 * Passando pela MESMA `totalizar`, é impossível divergirem.
 *
 * AS DESPESAS AVULSAS FICAM DE FORA DA LINHA, de propósito. "Assinatura de
 * ferramenta, R$ 200" não pertence a nenhum criativo; jogá-la em cada linha
 * multiplicaria a despesa pelo número de anúncios e faria todo mundo aparecer
 * no prejuízo. Ela entra uma vez só, no total do período.
 */
function comDerivados(l: LinhaDeDesempenho, custos: Custos) {
  return { ...l, d: totalizar([l], [], { ...custos, despesas: 0 }) };
}

/**
 * ============================================================================
 * OS CUSTOS DO DONO — taxa, imposto, custo por venda e despesas avulsas
 * ============================================================================
 *
 * Ficam num arquivo no armazenamento, editável pela tela "Taxas".
 *
 * POR QUE NÃO SÓ VARIÁVEL DE AMBIENTE: mudar a taxa do gateway exigiria abrir a
 * Vercel, editar a variável e REPUBLICAR — e o dono não vai fazer isso, então o
 * painel ficaria mostrando lucro com a taxa do ano passado. O que fica em
 * variável continua valendo como PADRÃO, para o painel não nascer vazio.
 *
 * POR QUE UM ARQUIVO SÓ, e não um por despesa: são poucos registros e eles
 * mudam juntos. Um arquivo é uma leitura; e a disputa de escrita que isso
 * criaria (dois navegadores salvando ao mesmo tempo) não existe num painel com
 * um usuário.
 */
interface ConfigDoPainel {
  taxaPct: number | null;
  impostoPct: number | null;
  custoPorVenda: number | null;
  impostoAdsPct: number | null;
  breakEvenRoas: number | null;
  despesas: Array<{ id: string; descricao: string; valor: number; de: string; ate: string }>;
  atualizadoEm: string;
}

const CHAVE_CONFIG = 'config:painel';

/** Texto vazio não é zero — ver o comentário do lucro, em `totalizar`. */
function numeroOuNulo(bruto: unknown): number | null {
  if (bruto === null || bruto === undefined) return null;
  const limpo = String(bruto).trim().replace(',', '.');
  if (!limpo) return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

function configPadrao(): ConfigDoPainel {
  return {
    taxaPct: numeroOuNulo(process.env.TAXA_GATEWAY_PCT),
    impostoPct: numeroOuNulo(process.env.IMPOSTO_PCT),
    custoPorVenda: numeroOuNulo(process.env.CUSTO_POR_VENDA),
    impostoAdsPct: null,
    breakEvenRoas: null,
    despesas: [],
    atualizadoEm: '',
  };
}

async function lerConfig(): Promise<ConfigDoPainel> {
  const padrao = configPadrao();
  const bruto = await redis(['GET', CHAVE_CONFIG]);
  if (typeof bruto !== 'string' || !bruto) return padrao;
  try {
    const salvo = JSON.parse(bruto) as Partial<ConfigDoPainel>;
    /*
     * O QUE ESTÁ SALVO GANHA DA VARIÁVEL, campo a campo — inclusive quando o
     * valor salvo é zero. `salvo.taxaPct ?? padrao.taxaPct` está certo; um
     * `||` aqui faria "taxa 0%" (gateway sem taxa) voltar a ler a variável.
     */
    return {
      taxaPct: salvo.taxaPct ?? padrao.taxaPct,
      impostoPct: salvo.impostoPct ?? padrao.impostoPct,
      custoPorVenda: salvo.custoPorVenda ?? padrao.custoPorVenda,
      impostoAdsPct: salvo.impostoAdsPct ?? padrao.impostoAdsPct,
      breakEvenRoas: salvo.breakEvenRoas ?? padrao.breakEvenRoas,
      despesas: Array.isArray(salvo.despesas) ? salvo.despesas : [],
      atualizadoEm: salvo.atualizadoEm ?? '',
    };
  } catch {
    return padrao;
  }
}

async function gravarConfig(c: ConfigDoPainel): Promise<boolean> {
  if (!memoriaLigada) return false;
  return (await redis(['SET', CHAVE_CONFIG, JSON.stringify(c)])) !== null;
}

/** Quanto das despesas avulsas cai dentro do período que está na tela. */
function despesasDoPeriodo(c: ConfigDoPainel, de: string, ate: string): number {
  return (c.despesas ?? [])
    .filter((d) => {
      const inicio = d.de || d.ate || '';
      const fim = d.ate || d.de || '';
      if (!inicio) return false;
      /* Sobreposição de intervalos: a despesa toca o período em algum dia. */
      return inicio <= ate && fim >= de;
    })
    .reduce((s, d) => s + (Number(d.valor) || 0), 0);
}

function custosDe(c: ConfigDoPainel, de: string, ate: string): Custos {
  return {
    taxaPct: c.taxaPct,
    impostoPct: c.impostoPct,
    custoPorVenda: c.custoPorVenda ?? 0,
    impostoAdsPct: c.impostoAdsPct ?? 0,
    despesas: despesasDoPeriodo(c, de, ate),
  };
}

/**
 * A CONTAGEM DO FUNIL. Quantas pessoas chegaram em cada etapa.
 *
 * ---------------------------------------------------------------------------
 * UM ARQUIVO VAZIO POR SESSAO E POR ETAPA, COM A ETAPA NO CAMINHO
 * ---------------------------------------------------------------------------
 *
 * `metricas/<dia>/<etapa>/<sessao>` -- e o arquivo nao tem conteudo nenhum.
 *
 * Duas razoes, e as duas sao praticas:
 *
 * 1. NAO HA DISPUTA. Um contador num arquivo so obrigaria a ler, somar e
 *    reescrever; com trafego pago, dois visitantes ao mesmo tempo sobrescrevem
 *    um ao outro e o topo do funil fica menor do que foi. Funil com o topo
 *    errado nao serve para decidir nada.
 * 2. CONTAR E LISTAR. A etapa esta no CAMINHO, entao o total de uma etapa e o
 *    numero de arquivos com aquele prefixo -- sem baixar um byte de conteudo.
 *
 * O mesmo visitante gravando a mesma etapa duas vezes escreve o mesmo caminho:
 * continua sendo uma pessoa.
 */
/*
 * `cartao` ENTROU EM 19/09/2026 e não é mais uma etapa da fila — é um DESVIO.
 *
 * Quem toca em "Pagar com cartão" sai deste site para a Kiwify e nunca chega
 * em `pix`. Até aqui essa pessoa sumia do funil: aparecia em `checkout` e
 * evaporava, e o degrau `checkout → pix` de 5,8% levava a culpa por gente que
 * não desistiu de nada — só foi pagar de outro jeito. Sem este contador não há
 * como saber se o buraco do checkout é desistência ou é o botão do cartão.
 *
 * ELE NÃO ENTRA NO DESENHO DO FUNIL DO RESUMO, de propósito: seis etapas em
 * fila mais uma que se ramifica no meio viram um gráfico que ninguém lê. O
 * número dele mora na aba Cartão, ao lado das vendas que ele gerou.
 */
/*
 * `n1`…`n8` SÃO OS PASSOS DO FUNIL `/novo`, um por tela (nome, área, idade,
 * dinheiro, família, sinais, compromisso, WhatsApp). No quiz antigo o painel só
 * sabia "começou" e "chegou nos depoimentos", e 58% sumiam no meio sem dizer
 * em qual pergunta. Aqui cada pergunta conta. O NOME DA ETAPA É UM NÚMERO, de
 * propósito: o que a pessoa RESPONDEU nunca sai do navegador (regra 10).
 */
const ETAPAS_VALIDAS = new Set([
  'chegou', 'quiz', 'audio', 'depoimentos', 'vsl', 'checkout', 'pix', 'cartao',
  'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8',
]);

/** O dia em Sao Paulo, e nao em UTC: o relatorio e lido em horario do Brasil. */
function diaDeHoje(quando?: Date): string {
  const d = quando ?? new Date();
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(d);
}

/**
 * OS DOIS FUNIS (03/10/2026): o do quiz e o do pedido de oração.
 *
 * O site diz de qual endereço a visita veio (`src/lib/funil.ts`). Aqui isso
 * vira três coisas, e as três existem para o seletor Quiz/Pedido do painel:
 *
 *   1. `metricas:pedido:<dia>:<etapa>` — o MESMO conjunto de sessões do funil
 *      geral, só das visitas do pedido. O geral continua sendo gravado inteiro:
 *      o quiz é "geral menos pedido", e assim o histórico de antes de hoje, que
 *      é todo do quiz, não some do filtro.
 *   2. `funil-do-ad:<id>` — para qual funil cada ANÚNCIO manda gente. É o que
 *      deixa dividir o GASTO: o Meta e o TikTok não sabem de funil, só de
 *      anúncio, e sem isto o ROAS de cada funil sairia com o gasto dos dois.
 *   3. `funil` na venda, gravado em `criarPedido`.
 */
/** Vendas cuja taxa real já foi perguntada ao gateway nesta instância. */
const jaTentouLiquido = new Set<string>();

/*
 * O TERCEIRO FUNIL, `/novo` (10/10/2026): o quiz enxuto com captura de contato
 * antes da VSL. Conta separado para poder ser COMPARADO com o quiz de sempre —
 * é para isso que ele mora num endereço próprio. O total (sem prefixo) soma os
 * três; "quiz" continua sendo o total menos os outros.
 */
/* `sinais` (13/10/2026) é o funil de quatro perguntas em `/sinais`, testado
   numa conta de anúncio à parte. Entra em TODO lugar onde `novo` entra: a
   contagem de visitas, a venda, o gasto e o filtro do painel. */
type Funil = 'quiz' | 'pedido' | 'novo' | 'sinais';
const lerFunil = (bruto: unknown): Funil =>
  bruto === 'pedido' ? 'pedido' : bruto === 'novo' ? 'novo' : bruto === 'sinais' ? 'sinais' : 'quiz';
/** Os funis que têm contagem própria; o quiz é o geral MENOS todos eles. */
const FUNIS_A_PARTE: Funil[] = ['pedido', 'novo', 'sinais'];
const idDoAd = (bruto: unknown): string => {
  const texto = String(bruto ?? '').trim();
  const id = texto.includes('|') ? texto.split('|').pop()!.trim() : texto;
  return /^[w-]{1,60}$/.test(id) ? id : '';
};

async function marcarEtapa(sessaoBruta: string, etapa: string, funilBruto?: unknown, adBruto?: unknown): Promise<void> {
  if (!memoriaLigada) return;
  if (!ETAPAS_VALIDAS.has(etapa)) return;
  const sessao = String(sessaoBruta).replace(/[^\w-]/g, '').slice(0, 40);
  if (!sessao) return;
  /*
   * UM CONJUNTO POR DIA E POR ETAPA, e a sessão é o membro.
   *
   * `SADD` da mesma sessão duas vezes continua sendo UMA pessoa — que era
   * exatamente o que o caminho repetido do arquivo garantia no desenho
   * anterior, e agora sai de graça, sem inventar contador.
   *
   * NÃO HÁ DISPUTA: dois visitantes ao mesmo tempo entram no mesmo conjunto
   * sem se sobrescrever. Um contador em `INCR` também serviria, mas perderia a
   * dedução de pessoa repetida e o topo do funil ficaria maior do que foi.
   *
   * VALIDADE DE 60 DIAS. O painel olha no máximo os últimos 30; guardar sessão
   * para sempre encheria a cota de graça com dado que ninguém consulta.
   */
  const chave = `metricas:${diaDeHoje()}:${etapa}`;
  const validade = String(60 * 24 * 60 * 60);
  const comandos: string[][] = [
    ['SADD', chave, sessao],
    ['EXPIRE', chave, validade],
  ];
  const funil = lerFunil(funilBruto);
  if (funil !== 'quiz') {
    const doPedido = `metricas:${funil}:${diaDeHoje()}:${etapa}`;
    comandos.push(['SADD', doPedido, sessao], ['EXPIRE', doPedido, validade]);
  }
  /* Só na chegada: é a única etapa em que TODO visitante do anúncio passa, e
     gravar em todas multiplicaria as escritas por oito para dizer o mesmo. */
  const ad = etapa === 'chegou' ? idDoAd(adBruto) : '';
  if (ad) comandos.push(['SET', `funil-do-ad:${ad}`, funil], ['EXPIRE', `funil-do-ad:${ad}`, String(90 * 24 * 60 * 60)]);
  await redisPipeline(comandos);
}

/** Para qual funil cada anúncio manda gente. Sem registro = quiz, que é o de sempre. */
async function funisDosAds(ids: string[]): Promise<Map<string, Funil>> {
  const saida = new Map<string, Funil>();
  const unicos = [...new Set(ids.map(idDoAd).filter(Boolean))];
  if (!memoriaLigada || !unicos.length) return saida;
  const valores = await redisPipeline(unicos.map((id) => ['GET', `funil-do-ad:${id}`]));
  unicos.forEach((id, i) => saida.set(id, lerFunil(valores[i])));
  return saida;
}

/** O funil geral menos o do pedido — nunca negativo. */
function subtrair(geral: Record<string, number>, pedido: Record<string, number>): Record<string, number> {
  const saida: Record<string, number> = {};
  for (const e of Object.keys(geral)) saida[e] = Math.max(0, (geral[e] ?? 0) - (pedido[e] ?? 0));
  return saida;
}

/**
 * O funil do dia inteiro, numa viagem só.
 *
 * Eram SETE listagens paginadas de mil em mil por dia — e o painel pede dois
 * dias, hoje e ontem. Agora são sete `SCARD` num pipeline: a contagem de um
 * conjunto é uma operação, não uma varredura.
 */
async function funilDoDia(dia: string, funil?: Funil | ''): Promise<Record<string, number>> {
  if (funil === 'quiz') {
    let resto = await funilDoDia(dia);
    for (const outro of FUNIS_A_PARTE) resto = subtrair(resto, await funilDoDia(dia, outro));
    return resto;
  }
  const prefixo = funil && FUNIS_A_PARTE.includes(funil) ? `metricas:${funil}` : 'metricas';
  const etapas = [...ETAPAS_VALIDAS];
  const saida: Record<string, number> = {};
  for (const e of etapas) saida[e] = 0;
  if (!memoriaLigada) return saida;

  const contagens = await redisPipeline(etapas.map((e) => ['SCARD', `${prefixo}:${dia}:${e}`]));
  etapas.forEach((e, i) => {
    const n = Number(contagens[i] ?? 0);
    saida[e] = Number.isFinite(n) ? n : 0;
  });
  return saida;
}

/**
 * O FUNIL DO SITE INTEIRO NO PERÍODO, somando os contadores de cada dia.
 *
 * ============================================================================
 * POR QUE ISTO PRECISOU EXISTIR (18/09/2026)
 * ============================================================================
 *
 * O funil do Resumo desenhava as três primeiras etapas com número do META
 * INSIGHTS (cliques, visualizações de página, InitiateCheckout) e as duas
 * últimas com o NOSSO registro de pedidos. Enquanto todo o tráfego era do Meta
 * isso batia. Quando o TikTok virou a fonte principal, virou mentira: em
 * 18/09 o Pixel recebeu 62 InitiateCheckout e o gráfico mostrava **1** — o
 * Meta só conta o que consegue atribuir aos anúncios DELE, e o resto do funil
 * mostrava as vendas de TODAS as redes. Duas réguas diferentes no mesmo
 * desenho, com o número da régua pequena em cima.
 *
 * Este contador não sabe o que é Meta nem TikTok: ele conta SESSÃO que passou
 * pela etapa, venha de onde vier. É a única régua que não muda quando a fonte
 * de tráfego muda.
 *
 * SOMA POR DIA, e não conjunto único: quem entrou ontem e hoje conta duas
 * vezes. O `SUNION` daria o número exato de pessoas, mas puxaria todas as
 * sessões de todos os dias para a memória da função só para contar — e o que
 * o funil precisa é da PROPORÇÃO entre as etapas, que a soma preserva.
 */
async function funilDoIntervalo(de: string, ate: string, funil?: Funil | ''): Promise<Record<string, number>> {
  if (funil === 'quiz') {
    let resto = await funilDoIntervalo(de, ate);
    for (const outro of FUNIS_A_PARTE) resto = subtrair(resto, await funilDoIntervalo(de, ate, outro));
    return resto;
  }
  const prefixo = funil && FUNIS_A_PARTE.includes(funil) ? `metricas:${funil}` : 'metricas';
  const etapas = [...ETAPAS_VALIDAS];
  const saida: Record<string, number> = {};
  for (const e of etapas) saida[e] = 0;
  if (!memoriaLigada) return saida;

  /* Teto de dias: um intervalo torto (ou um ano inteiro) não pode virar mil
     idas ao Redis. Ver o laço abaixo para o número e o porquê. */
  const dias: string[] = [];
  const inicio = new Date(`${de}T12:00:00Z`);
  const fim = new Date(`${ate}T12:00:00Z`);
  /*
   * OS ÚLTIMOS 62 DIAS DO INTERVALO, contados DE TRÁS PARA A FRENTE (11/10/2026).
   * Era "os primeiros 31": num intervalo maior que isso o funil contava o mês
   * mais ANTIGO e ignorava o mais recente — com "Todo o período" ele mostraria
   * agosto e setembro e esconderia outubro. As contagens diárias vivem 60 dias,
   * então 62 cobre tudo o que existe; começar pelo fim garante que, se algo
   * ficar de fora, é o que já expirou.
   */
  for (let d = new Date(fim); d >= inicio && dias.length < 62; d.setUTCDate(d.getUTCDate() - 1)) {
    dias.push(new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC' }).format(d));
  }
  if (!dias.length) return saida;

  const comandos = dias.flatMap((dia) => etapas.map((e) => ['SCARD', `${prefixo}:${dia}:${e}`]));
  const contagens = await redisPipeline(comandos);
  contagens.forEach((valor, i) => {
    const etapa = etapas[i % etapas.length];
    const n = Number(valor ?? 0);
    if (Number.isFinite(n)) saida[etapa] += n;
  });
  return saida;
}

/* ===== FIM DAS PARTES JUNTADAS ===== */

/* -------------------------------------------------------------------------- */
/* O catálogo — a fonte da verdade do preço                                    */
/* -------------------------------------------------------------------------- */

/**
 * O PREÇO MORA AQUI, e o navegador nunca manda valor: ele manda IDs.
 *
 * Quem confia no valor que o front envia vende a Oração por R$ 0,01 no dia em
 * que alguém abrir o DevTools. Os números da tela
 * (`PRECO_BASE` e `ORDER_BUMPS`, em src/components/InlineCheckout.tsx) são
 * espelho de exibição e TÊM de bater com estes — já saíram de sincronia uma
 * vez, e a tela anunciou R$ 47,00 enquanto a cobrança nascia com R$ 27,00.
 */
const CATALOGO: Record<string, { titulo: string; preco: number }> = {
  main: { titulo: 'Oração Sagrada do Arcanjo Miguel', preco: 47 },
  /*
   * A OFERTA DE QUEM IA EMBORA (11/10/2026): a MESMA oração, por R$ 27, mostrada
   * uma vez a quem aperta "voltar" no funil (src/components/OfertaDeSaida.tsx).
   *
   * É um item do catálogo, e não um desconto aplicado sobre `main`, porque este
   * arquivo refaz a soma a partir do catálogo em vários lugares (a tela do PIX,
   * a entrega, o preço por item dos pixels): um desconto valeria na cobrança e
   * seria esquecido em todos os outros, e a tela mostraria R$ 47 num PIX de 27.
   * O que ela ENTREGA é o de `main` — ver `itemDeEntrega`.
   */
  main_volta: { titulo: 'Oração Sagrada do Arcanjo Miguel', preco: 27 },
  /*
   * OS BÔNUS DA OFERTA DE SAÍDA, A R$ 9,90 CADA (pedido do dono, 11/10/2026).
   * São os mesmos dois bônus do checkout, mais baratos, e SÓ valem junto com
   * `main_volta` — ver o filtro de bumps em `criarPedido`. Sem essa trava,
   * qualquer um trocaria `salmos_150` por `salmos_150_volta` no DevTools e
   * levaria o bônus de R$ 27 por R$ 9,90 na oferta cheia.
   */
  salmos_150_volta: { titulo: 'Guia Sagrado dos 150 Salmos de Proteção & Libertação', preco: 9.9 },
  vela_7dias_volta: { titulo: 'Consagração do Seu Nome na Vela Sagrada de 7 Dias', preco: 9.9 },
  salmos_150: { titulo: 'Guia Sagrado dos 150 Salmos de Proteção & Libertação', preco: 27 },
  vela_7dias: { titulo: 'Consagração do Seu Nome na Vela Sagrada de 7 Dias', preco: 14 },
  /*
   * A CONTRIBUIÇÃO DE GRATIDÃO (13/10/2026, de volta do funil primordial): um
   * valor a mais que a pessoa escolhe somar, sem produto atrás. São TRÊS itens
   * de preço fixo, e não um valor livre, pela regra 2: o navegador manda o ID
   * e o preço sai daqui. Só UMA entra por pedido (ver o filtro em `criarPedido`).
   */
  semente_10: { titulo: 'Contribuição de gratidão', preco: 10 },
  semente_25: { titulo: 'Contribuição de gratidão', preco: 25 },
  semente_50: { titulo: 'Contribuição de gratidão', preco: 50 },
  upsell: { titulo: 'Aplicativo Espiritual com Rotina Diária & Tutorial em Vídeo', preco: 47 },
  downsell: { titulo: 'Aplicativo Espiritual — Versão Essencial', preco: 14.9 },
  /*
   * O ENVIO DA IMAGEM DE SÃO MIGUEL — o upsell que sai pelo WhatsApp
   * (19/09/2026). São TRÊS ofertas e não uma com valor variável, porque é esta
   * a regra da casa: o navegador manda o ID, o preço mora aqui. Uma oferta só,
   * com o valor vindo da tela, venderia o Sedex por R$ 0,01 no dia em que
   * alguém abrisse o DevTools.
   *
   * Os preços são ESPELHO de `SHIPPING`, em `src/lib/offer.ts` do projeto do
   * upsell. Mexeu num, mexa no outro: quando divergiram no funil principal, a
   * tela anunciou R$ 47,00 e a cobrança nasceu com R$ 27,00.
   */
  frete_jadlog: { titulo: 'Envio Jadlog — Imagem de São Miguel Arcanjo', preco: 17 },
  frete_magalu: { titulo: 'Envio Magalu — Imagem de São Miguel Arcanjo', preco: 27 },
  frete_sedex: { titulo: 'Envio Sedex — Imagem de São Miguel Arcanjo', preco: 47 },
};

/** O que cada item entrega. Vazio = "pago e sem nada para receber". */
const DESCRICOES: Record<string, string> = {
  main: 'Áudio completo da Oração Sagrada do Arcanjo Miguel, preparada a partir das suas respostas.',
  main_volta: 'Áudio completo da Oração Sagrada do Arcanjo Miguel, preparada a partir das suas respostas.',
  salmos_150: 'Livro digital com os 150 Salmos de proteção e libertação, em PDF.',
  vela_7dias: 'Confirmação da consagração do seu nome na Vela Sagrada de 7 dias.',
  semente_10: 'Sua contribuição de gratidão, levada junto na consagração.',
  semente_25: 'Sua contribuição de gratidão, levada junto na consagração.',
  semente_50: 'Sua contribuição de gratidão, levada junto na consagração.',
  salmos_150_volta: 'Livro digital com os 150 Salmos de proteção e libertação, em PDF.',
  vela_7dias_volta: 'Confirmação da consagração do seu nome na Vela Sagrada de 7 dias.',
  upsell: 'Acesso ao Aplicativo Espiritual completo + vídeo tutorial de instalação.',
  downsell: 'Acesso à Versão Essencial do Aplicativo Espiritual.',
  frete_jadlog: 'Envio da imagem de São Miguel Arcanjo pela Jadlog, em até 10 dias úteis.',
  frete_magalu: 'Envio da imagem de São Miguel Arcanjo pela Magalu Entregas, em até 7 dias úteis.',
  frete_sedex: 'Envio da imagem de São Miguel Arcanjo por Sedex, em até 3 dias úteis.',
};

/**
 * Produto cuja entrega é o próprio ato — a vela acesa no altar, a caixa
 * despachada na transportadora. Sem isto eles entrariam para sempre na lista
 * de "pago sem link configurado", porque não existe link para entregar: o que
 * chega é um objeto, pelo correio.
 */
/**
 * O QUE VIAJA DE CAIXA, pelo correio — e não por link nem por e-mail.
 *
 * A lista existe separada porque duas regras diferentes dependem dela: estes
 * produtos são entregáveis sem `DELIVERY_URL_*` (ver `SERVICOS`), e são os
 * únicos que nascem SEM e-mail, porque o que a entrega precisa deles é
 * endereço e WhatsApp.
 */
const ENTREGA_FISICA = new Set(['frete_jadlog', 'frete_magalu', 'frete_sedex']);

/* As contribuições de gratidão entram aqui: não têm link para entregar, e não é para ter. */
const SERVICOS = new Set(['vela_7dias', 'semente_10', 'semente_25', 'semente_50', ...ENTREGA_FISICA]);
/**
 * A OFERTA TEM COMO SER ENTREGUE?
 *
 * `false` significa "pago e sem nada para receber": nem link configurado, nem
 * a lista de servicos que o time entrega na mao.
 */
/**
 * DE QUAL PRODUTO SAI O LINK DE ENTREGA. `main_volta` é a oração com outro
 * preço: sem esta tradução ela procuraria `DELIVERY_URL_MAIN_VOLTA`, que não
 * existe, e quem pagou os R$ 27 ficaria sem receber — o pior defeito daqui.
 */
function itemDeEntrega(id: string): string {
  /* Todo item `*_volta` é o produto de sempre com o preço da oferta de saída. */
  return id.replace(/_volta$/, '');
}

/** O link de entrega de um item, ou vazio. Um lugar só, para a tradução acima não ser esquecida. */
function linkDeEntrega(id: string): string {
  return (process.env[`DELIVERY_URL_${itemDeEntrega(id).toUpperCase()}`] ?? '').trim();
}

function ofertaEntregavel(id: string): boolean {
  if (SERVICOS.has(itemDeEntrega(id))) return true;
  return Boolean(linkDeEntrega(id));
}

/**
 * OS PRODUTOS DE DEPOIS DA COMPRA -- e a regra que os desliga sozinhos.
 *
 * Em 05/09/2026 `DELIVERY_URL_UPSELL` e `DELIVERY_URL_DOWNSELL` estavam
 * vazias. Quem pagava os R$ 47 do upsell via, na tela, "link de acesso ainda
 * nao configurado, acione o suporte" -- e nao existe suporte para acionar.
 * Dinheiro cobrado, nada entregue, e a pessoa acabara de confiar o suficiente
 * para comprar duas vezes seguidas.
 *
 * A REGRA SO VALE PARA ESTES DOIS, de proposito. Aplicada ao produto
 * principal, uma variavel de ambiente que sumisse do painel derrubaria a
 * operacao inteira para zero, calada -- o remedio seria pior que a doenca. Ali
 * o certo e gritar (o painel mostra), nao parar de vender.
 *
 * Aqui e o contrario: nao vender o upsell custa uma venda que nao seria
 * entregue; vende-lo custa a confianca de um cliente que acabou de pagar.
 */
const ADDONS = new Set(['upsell', 'downsell']);


/* -------------------------------------------------------------------------- */
/* Configuração                                                                */
/* -------------------------------------------------------------------------- */


/**
 * O SEGREDO DO WEBHOOK DA KIWIFY — o cartão de crédito entra por lá.
 *
 * É o "Token" que aparece na tela de criar webhook no painel dela, e com ele a
 * Kiwify assina cada chamada: `?signature=<HMAC-SHA1 hex do corpo cru>`.
 *
 * SEM ELE A ROTA NÃO GRAVA NADA — fica só escutando e anotando no log. É
 * proposital: um webhook de venda sem assinatura conferida é um formulário
 * público para inventar venda paga neste painel e disparar `Purchase` falso ao
 * Meta, que aí otimiza para um público que nunca comprou.
 */
const KIWIFY_TOKEN = (process.env.KIWIFY_TOKEN ?? '').trim();

/**
 * DE QUAL PRODUTO DA KIWIFY VEIO — e por que isto não podia ficar chumbado.
 *
 * A KIWIFY MANDA UMA CHAMADA POR PRODUTO, não uma por pedido. Foi lido na API
 * dela em 19/09/2026: às 16:23 de 17/09 chegaram TRÊS vendas com o mesmo
 * horário — R$ 47, R$ 27 e R$ 14 — que são uma pessoa só levando a oração e os
 * dois bumps. A primeira versão desta rota gravava `itens: ['main']` fixo, e
 * com isso o bump de R$ 27 entraria no painel como se fosse a oração, e sairia
 * para o Meta com o código neutro `p1` em vez de `p2`.
 *
 * Os IDs vieram de `GET /v1/products` da própria conta. Produto novo lá entra
 * aqui — e, se não entrar, cai em `main`, que é errado mas não é mentira sobre
 * crença: o código neutro continua saindo. Ver a regra 8 do NOTAS.md.
 */
const PRODUTOS_DA_KIWIFY: Record<string, string> = {
  '64857090-a47d-11f1-90f1-13f5745c7321': 'main',
  '8ec166b0-a47e-11f1-88ea-31ff0a9e164c': 'salmos_150',
  'ca171160-a47e-11f1-aa06-698fc0ef5af5': 'vela_7dias',
};

function itemDaKiwify(produtoId: unknown): string {
  const id = String(produtoId ?? '').trim();
  const nosso = PRODUTOS_DA_KIWIFY[id];
  if (nosso) return nosso;
  console.warn('[kiwify] produto desconhecido:', id, '— gravado como main. Acrescente em PRODUTOS_DA_KIWIFY.');
  return 'main';
}

/*
 * ============================================================================
 * A API DA KIWIFY — o histórico do cartão, que o webhook sozinho não traz
 * ============================================================================
 *
 * O WEBHOOK SÓ SABE DO FUTURO. Ele passou a existir em 19/09/2026, e o que foi
 * vendido no cartão ANTES dele nunca passou por este servidor: eram R$ 638,54
 * líquidos, 18 vendas, das quais DEZ vieram do TikTok — invisíveis no painel,
 * fora de todo ROAS, num dia em que a conclusão que eu tinha dado ao dono era
 * "o TikTok não vendeu". A API é o que conserta isso, e continua consertando
 * sempre que o webhook falhar.
 *
 * ELA ENTRA NA MESMA LISTA DE VENDAS DO PAINEL, e essa é a decisão que importa
 * aqui: não é uma aba paralela com números próprios. Venda de cartão atribuída
 * ao TikTok tem de aparecer no criativo do TikTok, junto da venda de PIX do
 * mesmo criativo — senão o painel mostra dois ROAS diferentes para o mesmo
 * anúncio e nenhum dos dois é o verdadeiro.
 *
 * O `de-para` com o que já está gravado é pelo ID: a venda que o webhook
 * gravou tem `kw-<order_id>`, e a que vem da API recebe o MESMO prefixo. Quem
 * já está no Redis ganha, porque lá tem o carimbo de `Purchase` enviado.
 */
const KIWIFY_CLIENT_ID = (process.env.KIWIFY_CLIENT_ID ?? '').trim();
const KIWIFY_CLIENT_SECRET = (process.env.KIWIFY_CLIENT_SECRET ?? '').trim();
const KIWIFY_ACCOUNT_ID = (process.env.KIWIFY_ACCOUNT_ID ?? '').trim();
const kiwifyApiLigada = Boolean(KIWIFY_CLIENT_ID && KIWIFY_CLIENT_SECRET && KIWIFY_ACCOUNT_ID);
const KIWIFY_API = 'https://public-api.kiwify.com.br/v1';
let ultimoErroDaKiwify = '';

/**
 * O token OAuth, guardado no Redis até quase expirar.
 *
 * Ele vale 24 h (`expires_in: 86400`, medido em 19/09/2026), e pedir um novo a
 * cada abertura do painel seria uma ida à rede a mais em toda leitura — além de
 * gastar cota de um endereço que ninguém documenta o limite. Os 5 minutos de
 * folga existem para o token não vencer no meio de uma consulta já começada.
 */
async function tokenDaKiwify(): Promise<string> {
  if (!kiwifyApiLigada) return '';
  const guardado = await redis(['GET', 'kiwify:token']);
  if (typeof guardado === 'string' && guardado) return guardado;
  try {
    const r = await fetch(`${KIWIFY_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: KIWIFY_CLIENT_ID, client_secret: KIWIFY_CLIENT_SECRET }).toString(),
      signal: AbortSignal.timeout(9000),
    });
    const d = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !d.access_token) {
      ultimoErroDaKiwify = `oauth: HTTP ${r.status}`;
      console.error('[kiwify]', ultimoErroDaKiwify);
      return '';
    }
    const vida = Math.max(300, Number(d.expires_in ?? 86400) - 300);
    await redis(['SET', 'kiwify:token', d.access_token, 'EX', String(vida)]);
    ultimoErroDaKiwify = '';
    return d.access_token;
  } catch (falha) {
    ultimoErroDaKiwify = `oauth: ${(falha as Error)?.message ?? 'sem detalhe'}`;
    console.error('[kiwify]', ultimoErroDaKiwify);
    return '';
  }
}

async function pedirAKiwify(caminho: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${KIWIFY_API}${caminho}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-kiwify-account-id': KIWIFY_ACCOUNT_ID,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) {
      ultimoErroDaKiwify = `${caminho}: HTTP ${r.status}`;
      return null;
    }
    /* Limpar no sucesso, senão o aviso vermelho do painel fica na tela para
       sempre depois de um erro passageiro de rede — e o dono passa a procurar
       defeito numa integração que voltou a funcionar. */
    ultimoErroDaKiwify = '';
    return (await r.json()) as Record<string, unknown>;
  } catch (falha) {
    ultimoErroDaKiwify = `${caminho}: ${(falha as Error)?.message ?? 'sem detalhe'}`;
    return null;
  }
}

/**
 * As vendas do cartão no período, no MESMO formato das vendas de PIX.
 *
 * DUAS IDAS POR VENDA, e não uma: a lista (`GET /sales`) não traz o rastreio —
 * o `tracking` com `utm_source`, `utm_campaign` e `utm_content` só existe no
 * detalhe (`GET /sales/{id}`). Sem ele a venda de cartão entraria no painel
 * como "sem anúncio", que é exatamente o problema que esta função existe para
 * resolver. Por isso o detalhe é buscado SÓ das pagas: são elas que viram
 * dinheiro na tabela, e cada recusada a mais seria uma ida à rede à toa.
 *
 * EM LEVAS DE 6, porque a função tem 60 s de teto e 20 vendas em série já
 * comeram 4 s de relógio na medição de 19/09. Paralelo demais tampouco serve:
 * a Kiwify não publica o limite de requisições dela, e descobrir qual é no meio
 * de um dia de venda é o tipo de economia que sai caro.
 *
 * O CACHE DE 2 MINUTOS é o que torna isto aceitável num painel que o dono deixa
 * aberto atualizando: sem ele, cada F5 refaria vinte e tantas chamadas.
 */
/** `2026-09-18` → `2026-09-19`. Ver o uso em `vendasDaKiwify`. */
function diaSeguinte(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dia;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function vendasDaKiwify(de: string, ate: string): Promise<Venda[]> {
  if (!kiwifyApiLigada) return [];
  const chave = `kiwify:vendas:${de}:${ate}`;
  const guardado = await redis(['GET', chave]);
  if (typeof guardado === 'string' && guardado) {
    try {
      return JSON.parse(guardado) as Venda[];
    } catch {
      /* cache torto é cache ignorado */
    }
  }

  const token = await tokenDaKiwify();
  if (!token) return [];

  /*
   * O FIM DA CONSULTA É SEMPRE UM DIA DEPOIS DO FIM QUE O PAINEL PEDIU.
   *
   * Duas razões, e as duas foram medidas em 19/09/2026:
   *
   *   1. A Kiwify RECUSA `end_date` igual a `start_date` — "end_date must be
   *      greater than start_date", HTTP 400. E "Hoje" e "Ontem", que são os
   *      dois períodos mais usados deste painel, mandam a MESMA data nos dois
   *      campos. Sem este ajuste a aba Cartão nascia quebrada justamente nos
   *      dois filtros que o dono abre o dia inteiro.
   *   2. Não está documentado se o fim é inclusivo. Pedir um dia a mais e
   *      recortar aqui do lado é a única forma de não perder a venda do último
   *      dia se ele for exclusivo — e o dia a mais não suja nada, porque
   *      `vendasDoIntervalo` filtra de novo pelo período verdadeiro.
   */
  const lista = await pedirAKiwify(`/sales?start_date=${de}&end_date=${diaSeguinte(ate)}&page_size=100`, token);
  const cruas = (lista?.data ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(cruas) || !cruas.length) return [];

  const pagas = cruas.filter((v) => String(v.status ?? '') === 'paid');
  const detalhes = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < pagas.length; i += 6) {
    const leva = pagas.slice(i, i + 6);
    const vindos = await Promise.all(leva.map((v) => pedirAKiwify(`/sales/${String(v.id)}`, token)));
    vindos.forEach((d, j) => {
      if (d) detalhes.set(String(leva[j].id), d);
    });
  }

  const texto = (v: unknown): string | undefined => {
    const s = String(v ?? '').trim();
    return s && s !== 'null' ? s.slice(0, 200) : undefined;
  };

  const vendas: Venda[] = cruas.map((v) => {
    const id = String(v.id ?? '');
    const d = detalhes.get(id) ?? v;
    const t = (d.tracking ?? {}) as Record<string, unknown>;
    const pagamento = (d.payment ?? {}) as Record<string, unknown>;
    const cliente = (v.customer ?? {}) as Record<string, unknown>;
    const produto = (v.product ?? {}) as Record<string, unknown>;

    const attrib: Record<string, string> = {};
    const por = (chave: string, valor: unknown) => {
      const s = texto(valor);
      if (s) attrib[chave] = s;
    };
    por('origem', t.utm_source);
    por('campanha', t.utm_campaign);
    por('conjunto', t.utm_medium);
    por('criativo', t.utm_content);
    por('termo', t.utm_term);
    por('fbclid', t.sck);
    por('ttclid', t.s1);

    const st = String(v.status ?? '');
    /*
     * `charge_amount` é o que a pessoa pagou (com juros de parcelamento);
     * `net_amount` é o que sobra para o dono. O painel soma FATURAMENTO, então
     * `valor` é o cobrado — e o líquido vai no campo que já existe para isso,
     * o mesmo que a ZuckPay preenche. Trocar os dois faria o topo do painel
     * discordar do extrato da Kiwify.
     */
    const cobrado = Number(pagamento.charge_amount ?? 0) / 100;
    const liquido = Number(pagamento.net_amount ?? v.net_amount ?? 0) / 100;

    return {
      id: `kw-${id}`,
      nome: texto(cliente.name) ?? '',
      email: texto(cliente.email) ?? '',
      telefone: texto(cliente.mobile) ?? '',
      itens: [itemDaKiwify(produto.id)],
      valor: cobrado > 0 ? cobrado : liquido,
      status: st === 'paid' ? 'completed' : st === 'refused' ? 'refused' : 'pending',
      criadoEm: String(v.created_at ?? new Date().toISOString()),
      pagoEm: texto(d.approved_date) ?? (st === 'paid' ? String(v.updated_at ?? '') : null),
      adquirente: 'Kiwify (cartão)',
      valorLiquido: Number.isFinite(liquido) && liquido > 0 ? liquido : null,
      attrib,
      metaEnviadoEm: null,
      semUpsell: true,
      pagamento: 'cartao',
      cartaoRecusa: st === 'refused' ? (texto(d.card_rejection_reason) ?? 'sem motivo informado') : null,
      parcelas: Number(d.installments ?? 0) || null,
    };
  });

  await redis(['SET', chave, JSON.stringify(vendas), 'EX', '120']);
  return vendas;
}

/* ========================================================================== */
/* AVENPAY — NÃO COBRA MAIS (30/09/2026). Só recebe os avisos que faltam.      */
/* ========================================================================== */
/**
 * Decisão do dono em 30/09/2026: ficam só SpyPag e ZuckPay, ligadas pelo
 * painel. A AvenPay parou de criar cobrança.
 *
 * A ROTA DE AVISO DELA (`/webhooks/avenpay`) CONTINUA DE PÉ, e não é esquecimento:
 * PIX gerado pela AvenPay antes da troca ainda pode ser pago, e esse pagamento
 * só chega por ela. Tirar a rota junto seria dinheiro na conta e venda parada
 * em `pending` para sempre — sem entrega, sem evento, sem faturamento. Ela pode
 * sair quando não houver mais pedido `aven` pendente com menos de 7 dias.
 *
 * O resto do desenho dela está no histórico do git (commit anterior a esta
 * data), incluindo a proibição de consultar status que moldou a tela do QR.
 */
const AVEN_WEBHOOK_SECRET = (process.env.AVEN_WEBHOOK_SECRET ?? '').trim();
/** A segunda porta do aviso dela — o `?k=` do endereço. Ver `/webhooks/avenpay`. */
const AVEN_WEBHOOK_URL_KEY = (process.env.AVEN_WEBHOOK_URL_KEY ?? '').trim();

/** Teto de espera por resposta do gateway. A Vercel corta a função em 20 s. */
const TIMEOUT_MS = Number.parseInt(process.env.GATEWAY_TIMEOUT_MS ?? process.env.AVEN_TIMEOUT_MS ?? '12000', 10);

/* -------------------------------------------------------------------------- */
/* CPF_DO_PAGADOR — leia isto antes de mexer                                   */
/* -------------------------------------------------------------------------- */

/**
 * O CPF QUE VAI NO PAYLOAD, JÁ QUE O FORMULÁRIO NÃO PEDE MAIS.
 *
 * Decisão do dono em 04/09/2026: tirar o campo da tela ("deixa o checkout mais
 * clean") e mandar um CPF daqui. A ZuckPay marca `cpf` como obrigatório no
 * `POST /v3/pix/qrcode`; sem nada no campo, a cobrança não nasce.
 *
 * ================== O QUE ISSO CUSTA, POR ESCRITO ==========================
 *
 * 1. SE A ZUCKPAY TRAVAR A COBRANÇA NO CPF INFORMADO — como a PixGo travava —,
 *    o QR só aceita pagamento daquele CPF. Com um CPF que não é o de quem está
 *    comprando, ou TODO MUNDO é recusado, ou o pagamento sai no nome errado.
 *    Isso não aparece em teste: aparece na primeira venda real.
 * 2. ESTORNO. A copy promete devolução integral em 30 dias, e reembolso de PIX
 *    é feito contra o pagador registrado. Com CPF que não é o do comprador, o
 *    reembolso trava — e vira reclamação de quem já pagou.
 * 3. A CONTA. PSP tem obrigação de identificar o pagador; CPF constante ou
 *    inventado em todas as transações aparece na conciliação deles. Conta
 *    derrubada com saldo retido é pior que gateway fora do ar.
 *
 * ================== O QUE FAZER PARA REDUZIR O RISCO ========================
 *
 * PREENCHA `CPF_PADRAO` COM O CPF DO TITULAR DA CONTA DO GATEWAY. É a
 * versão menos ruim disto: o documento existe, é do dono da operação, e a
 * conciliação do gateway bate com alguém real. Sem a variável, a função gera um
 * CPF sintético por pedido — passa na validação de dígito, e é tudo que ele
 * tem de verdadeiro.
 *
 * O CAMINHO QUE NÃO TEM ESSE PROBLEMA: `POST /v3/card/charge` marca `cpf` como
 * OPCIONAL. Um checkout de cartão dispensa o campo sem inventar nada.
 */
/**
 * ============================================================================
 * A URL QUE O GATEWAY CHAMA QUANDO O PAGAMENTO CONFIRMA
 * ============================================================================
 *
 * `PUBLIC_BASE_URL` É CONFERIDA, e não usada como veio.
 *
 * POR QUE A CHECAGEM VALE A PENA: o `urlnoty` é o único jeito de o gateway
 * avisar que o pagamento caiu, e sem ele o `Purchase` só sai se o navegador de
 * quem comprou ainda estiver na tela consultando o status. Quem paga PIX no app
 * do banco fecha a aba — foi assim que DUAS vendas de cinco não chegaram ao
 * Meta em 06/09/2026.
 *
 * Uma variável torta produziria uma URL torta, o gateway aceitaria em silêncio
 * e ninguém descobriria até faltar venda no Gerenciador semanas depois. Aqui,
 * ou é `http(s)://algo`, ou não se manda `urlnoty` nenhum e o painel diz que a
 * integração está incompleta — o defeito aparece na tela, não no relatório.
 */
function montarUrlDoWebhook(rota = 'zuckpay'): string {
  const bruto = (process.env.PUBLIC_BASE_URL ?? '').trim();
  if (!bruto) return '';
  try {
    const u = new URL(bruto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${bruto.replace(/\/+$/, '')}/api/webhooks/${rota}`;
  } catch {
    console.error('[config] PUBLIC_BASE_URL nao e uma URL. O gateway ficara SEM webhook.');
    return '';
  }
}
const URL_DO_WEBHOOK = montarUrlDoWebhook();

/* ========================================================================== */
/* OS GATEWAYS DE PIX: SPYPAG E ZUCKPAY, LIGADOS PELO PAINEL (30/09/2026)      */
/* ========================================================================== */
/**
 * POR QUE AS CREDENCIAIS MORAM NO REDIS, E NÃO NUMA VARIÁVEL DA VERCEL.
 *
 * Pedido do dono: URL, Client ID, Secret e um botão de ligar/desligar no
 * painel, um cartão por gateway. Variável de ambiente exige abrir a Vercel e
 * REPUBLICAR para cada troca — e trocar de gateway é justamente o que se faz
 * com pressa, quando o outro caiu. A regra 1 do NOTAS.md continua de pé: o
 * Secret entra pelo painel, fica no Redis e NUNCA volta ao navegador (a tela
 * recebe só os quatro últimos caracteres, para o dono saber qual está salvo).
 *
 * UM LIGADO POR VEZ. Ligar um desliga o outro (rota `/admin/gateways/<s|z>`).
 * Se os dois estiverem ligados mesmo assim (edição à mão no Redis), a SpyPag
 * ganha — ver `gatewayAtivo`. Nenhum ligado = checkout sem PIX, com 503 claro.
 *
 * OS AVISOS DE PAGAMENTO NÃO OLHAM O INTERRUPTOR, de propósito: desligar um
 * gateway com PIX em aberto não pode transformar pagamento feito em venda
 * parada em `pending`.
 *
 * O NOME NÃO PODE IR PARA O PAINEL — ver INTEGRACOES em PainelAdmin.tsx. Lá
 * eles são "Gateway S" (SpyPag) e "Gateway Z" (ZuckPay).
 *
 * ---------------------------------------------------------------------------
 * SPYPAG (documentação lida em 30/09/2026, spypag.online/documentacao)
 *
 *   cobrança     POST /payments/pix, valor em REAIS (float)
 *   exige        payer_name, payer_email, payer_cpf
 *   cabeçalhos   Bearer <token> + X-Client-ID + **Accept: application/json**:
 *                sem o Accept, erro de validação vira 302 para a home deles
 *   id           `transaction_uuid`. Não há campo de referência nossa, então o
 *                id da venda no Redis É o uuid — o aviso acha a venda por ele
 *   validade     5 minutos declarados (`expires_in_seconds`). No primeiro PIX
 *                real o número veio sem sentido — ver `validadeSensata`
 *   aviso        `deposit.completed`, HMAC-SHA256 do corpo cru com o PRÓPRIO
 *                TOKEN como chave, no `X-Webhook-Signature`
 *   IP fixo      só para SAQUE automático; cobrança não pede
 *
 * ZUCKPAY (o desenho que rodou de 23/08 a 25/09/2026, trazido do git)
 *
 *   cobrança     POST /v3/pix/qrcode, Basic base64(client_id:client_secret),
 *                valor em REAIS
 *   exige        nome, cpf, email (ver CPF_DO_PAGADOR e `emailParaOGateway`)
 *   aviso        SEM assinatura. O corpo só diz QUAL pedido olhar; quem diz o
 *                que aconteceu é `GET /v3/pix/status`, uma vez por aviso que
 *                fala de dinheiro. Nunca em laço: o teto deles é baixo
 *
 * PAGOU.AI (documentação lida em 02/10/2026, developer.pagou.ai)
 *
 *   cobrança     POST /v2/transactions, Bearer <secret>, valor em CENTAVOS
 *                (inteiro) — o único dos três que não é em reais
 *   exige        amount, method, buyer (nome + e-mail) e products. O documento
 *                é OPCIONAL, e por isso não vai: mandar o CPF sintético de
 *                CPF_DO_PAGADOR a quem não pede só cria o risco sem precisar
 *   credencial   UMA chave só. Não existe Client ID — o cartão do painel não
 *                pede, e `gatewayPronto` não cobra
 *   aviso        o `notify_url` chega SEM assinatura (a doc diz com todas as
 *                letras). Mesmo desenho da ZuckPay: o corpo diz qual pedido,
 *                `GET /v2/transactions/{id}` diz o que aconteceu
 *
 * PINGUPAG (documentação colada pelo dono em 07/10/2026) — "Gateway G"
 *
 *   cobrança     POST /gateway/v1/transaction, cabeçalho `X-API-Key`, valor em
 *                CENTAVOS (inteiro). `source: "api_externa"` dispensa o
 *                `productHash` — os produtos não são cadastrados lá
 *   exige        description, reference e customer com nome, e-mail,
 *                documento e telefone (DDD, sem DDI)
 *   credencial   UMA chave só, como a Pagou.ai
 *   id           A NOSSA `reference`. Ela devolve um `transaction_id` numérico
 *                na criação e OUTRO, em texto, no aviso — o único identificador
 *                que aparece igual nos dois lados é o nosso. Então o id da
 *                venda no Redis é a referência (ver `referenciaPinguPag`)
 *   validade     `expires_at` vem em HORÁRIO DE BRASÍLIA, sem fuso
 *   aviso        sem assinatura documentada. Mesmo desenho da ZuckPay: o corpo
 *                diz qual pedido, e `GET /gateway/v1/query?action=
 *                list_transactions&external_id=` diz o que aconteceu
 *
 * BEEHIVE (paybeehive.readme.io, lida em 09/10/2026) — "Gateway B"
 *
 *   cobrança     POST /transactions, `Basic base64(<secret>:x)`, valor em
 *                CENTAVOS. Exige `amount`, `paymentMethod: "pix"`, `customer`
 *                (nome + e-mail) e `items` (título, preço unitário, quantidade,
 *                `tangible`)
 *   credencial   UMA chave só (a secreta), como Pagou.ai e PinguPag
 *   id           O DELA É UM NÚMERO SEQUENCIAL (`282`), e isso não pode virar o
 *                id da venda: este id libera a entrega em `/orders/:id/access`,
 *                e número em sequência se adivinha. A venda nasce com a NOSSA
 *                referência (`MPV-…`), e um mapa no Redis (`bee:tx:<número>`)
 *                leva do número dela até a nossa — ver `chaveDaBeehive`
 *   validade     `pix.expirationDate` vem só com o DIA. Fica o padrão de 20 min
 *                na tela; o código em si vale mais que isso
 *   aviso        `postbackUrl`, sem assinatura: `{ type: "transaction", data }`.
 *                Mesmo desenho da ZuckPay — o corpo diz qual transação, e
 *                `GET /transactions/{id}` diz o que aconteceu
 *   taxa         `fee.netAmount`, em centavos: o painel mostra o líquido REAL
 */
type IdGateway = 'spypag' | 'zuckpay' | 'pagouai' | 'pingupag' | 'beehive';

/** Quem não tem Client ID: a credencial é uma chave só. */
const SEM_CLIENT_ID: ReadonlySet<IdGateway> = new Set(['pagouai', 'pingupag', 'beehive']);

interface ConfigGateway {
  url: string;
  clientId: string;
  /** O Secret. Na SpyPag é o token `nxp_…`; na ZuckPay, o client_secret. */
  token: string;
  ligado: boolean;
  atualizadoEm: string;
}

const GATEWAYS: Record<IdGateway, { chave: string; urlPadrao: string }> = {
  spypag: { chave: 'config:gateway-pix-2', urlPadrao: 'https://spypag.online/api/v1' },
  zuckpay: { chave: 'config:gateway-zuckpay', urlPadrao: 'https://www.zuckpay.com.br/conta' },
  pagouai: { chave: 'config:gateway-pagouai', urlPadrao: 'https://api.pagou.ai' },
  pingupag: { chave: 'config:gateway-pingupag', urlPadrao: 'https://app.pingupag.com' },
  beehive: { chave: 'config:gateway-beehive', urlPadrao: 'https://api.conta.paybeehive.com.br/v1' },
};

/**
 * CACHE DE 15 s, e o que ele custa.
 *
 * `gatewayAtivo` roda em TODA requisição (é ela que decide se a função tem
 * gateway). Sem cache seria uma ida ao Redis a cada consulta da tela do QR —
 * 227 num pedido só, medido em 24/09. O preço: depois de apertar o botão no
 * painel, uma instância que já estava de pé pode levar até 15 s para obedecer.
 * A instância que gravou obedece na hora (ver `gravarGateway`).
 */
const cacheDosGateways: Partial<Record<IdGateway, { valor: ConfigGateway; ate: number }>> = {};

async function lerGateway(id: IdGateway, fresco = false): Promise<ConfigGateway> {
  const guardado = cacheDosGateways[id];
  if (!fresco && guardado && guardado.ate > Date.now()) return guardado.valor;
  let valor: ConfigGateway = { url: GATEWAYS[id].urlPadrao, clientId: '', token: '', ligado: false, atualizadoEm: '' };
  const bruto = await redis(['GET', GATEWAYS[id].chave]);
  if (typeof bruto === 'string' && bruto) {
    try {
      const s = JSON.parse(bruto) as Partial<ConfigGateway>;
      valor = {
        url: typeof s.url === 'string' && s.url ? s.url : GATEWAYS[id].urlPadrao,
        clientId: String(s.clientId ?? ''),
        token: String(s.token ?? ''),
        ligado: s.ligado === true,
        atualizadoEm: String(s.atualizadoEm ?? ''),
      };
    } catch {
      /* JSON torto é o mesmo que não configurado. */
    }
  }
  cacheDosGateways[id] = { valor, ate: Date.now() + 15_000 };
  return valor;
}

async function gravarGateway(id: IdGateway, c: ConfigGateway): Promise<boolean> {
  if (!memoriaLigada) return false;
  const gravou = (await redis(['SET', GATEWAYS[id].chave, JSON.stringify(c)])) !== null;
  if (gravou) cacheDosGateways[id] = { valor: c, ate: Date.now() + 15_000 };
  return gravou;
}

/**
 * A SEGUNDA PORTA DO AVISO DA SPYPAG, sem um segredo a mais para guardar.
 *
 * Mesma lição da AvenPay (25/09/2026): se a assinatura não vier, ou vier num
 * formato que não se esperava, a porta da assinatura fecha para sempre e toda
 * venda paga fica `pending`. A chave da URL é DERIVADA do token — muda junto
 * quando o token muda, e não existe um terceiro campo no painel para esquecer.
 */
function chaveDaUrlSpyPag(token: string): string {
  return createHmac('sha256', token).update('url-do-aviso').digest('hex').slice(0, 32);
}

/**
 * O endereço que vai junto de cada cobrança. A ZuckPay não leva chave: o
 * aviso dela é conferido perguntando o status a ela mesma.
 */
function urlDoAviso(id: IdGateway, c: ConfigGateway): string {
  const base = montarUrlDoWebhook(id);
  if (!base || !c.token) return '';
  /*
   * A ZUCKPAY TAMBÉM LEVA A CHAVE NA URL (11/10/2026). O aviso dela não é
   * assinado, e a regra era "o aviso é só gatilho, quem diz se pagou é a
   * consulta". Só que a consulta dela ATRASA: responde pendente no segundo do
   * pagamento e só minutos depois responde pago — o evento de compra chegava ao
   * TikTok com 11 min a 2h46 de atraso, e a campanha otimizava no escuro.
   *
   * Com a chave, o aviso passa a provar de onde veio: esta URL só existe dentro
   * da cobrança que NÓS criamos pela API dela, por TLS. Quem não é a ZuckPay
   * não a conhece. É o mesmo desenho da SpyPag — ver `chaveDaUrlSpyPag`.
   */
  return id === 'spypag' || id === 'zuckpay' ? `${base}?k=${chaveDaUrlSpyPag(c.token)}` : base;
}

/**
 * PRONTO = LIGADO E COMPLETO. O aviso entra na conta: sem ele NADA descobre
 * que o PIX foi pago (a tela do QR não consulta o gateway), e cobrar sem saber
 * que recebeu é pior que não vender.
 */
function gatewayPronto(id: IdGateway, c: ConfigGateway): boolean {
  const temClientId = SEM_CLIENT_ID.has(id) || Boolean(c.clientId);
  return c.ligado && Boolean(c.url && temClientId && c.token && urlDoAviso(id, c));
}

const TODOS_OS_GATEWAYS: readonly IdGateway[] = ['spypag', 'zuckpay', 'pagouai', 'pingupag', 'beehive'];

/** Quem cobra agora. SpyPag primeiro — ver o cabeçalho deste bloco. */
async function gatewayAtivo(): Promise<{ id: IdGateway; c: ConfigGateway } | null> {
  for (const id of TODOS_OS_GATEWAYS) {
    const c = await lerGateway(id);
    if (gatewayPronto(id, c)) return { id, c };
  }
  return null;
}

/**
 * POR ONDE O DINHEIRO ENTROU, como o painel mostra: `S` (SpyPag), `Z`
 * (ZuckPay), `A` (AvenPay) ou `cartão`. Letra, e não nome, porque o painel é
 * bundle público (ver INTEGRACOES em PainelAdmin.tsx) — e a tradução mora aqui,
 * no servidor, para o nome não precisar existir no JavaScript da tela.
 *
 * `gateway` AUSENTE É ZUCKPAY: é de onde vieram todas as vendas anteriores a
 * 25/09/2026, quando o campo nasceu. Venda marcada à mão fora do gateway diz
 * isso, em vez de fingir que passou por um.
 */
function origemDaVenda(v: Venda): string {
  if (v.pagamento === 'cartao') return 'cartão';
  if (v.pagamento === 'boleto') return 'boleto';
  /* `pagoPorFora` é a marca de UMA venda de 12/10/2026, feita por uma rota que durou um dia (duplicava `/admin/orders/<id>/pago`). */
  if (v.pagoForaDoGateway || v.pagoPorFora) return 'fora do gateway';
  if (v.gateway === 'spypag') return 'S';
  if (v.gateway === 'pagouai') return 'P';
  if (v.gateway === 'pingupag') return 'G';
  if (v.gateway === 'beehive') return 'B';
  if (v.gateway === 'aven') return 'A';
  return 'Z';
}

/** Só `https://`: por aqui passa uma chave que também SACA dinheiro da conta. */
function urlDaApi(id: IdGateway, bruto: unknown): string | null {
  const texto = String(bruto ?? '').trim().replace(/\/+$/, '');
  if (!texto) return GATEWAYS[id].urlPadrao;
  try {
    return new URL(texto).protocol === 'https:' ? texto : null;
  } catch {
    return null;
  }
}

/** Uma ida ao gateway. Nunca lança, e o corpo cru nunca vai ao log (tem CPF). */
async function chamarGateway(
  id: IdGateway,
  c: ConfigGateway,
  caminho: string,
  opcoes: { metodo: 'GET' | 'POST'; corpo?: Record<string, unknown> },
): Promise<{ ok: boolean; status: number; dados: Record<string, unknown> }> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  const autenticacao: Record<string, string> =
    id === 'spypag'
      ? { Authorization: `Bearer ${c.token}`, 'X-Client-ID': c.clientId }
      : id === 'pagouai'
        ? { Authorization: `Bearer ${c.token}` }
        : id === 'pingupag'
          ? { 'X-API-Key': c.token }
          : id === 'beehive'
            ? { Authorization: `Basic ${Buffer.from(`${c.token}:x`).toString('base64')}` }
          : { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.token}`).toString('base64')}` };
  try {
    const resposta = await fetch(`${c.url}${caminho}`, {
      method: opcoes.metodo,
      headers: {
        ...autenticacao,
        Accept: 'application/json',
        ...(opcoes.corpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
      signal: controle.signal,
      /* O 302 para a home da SpyPag é ERRO, não caminho a seguir: segui-lo
         daria um HTML com 200 e a cobrança pareceria criada sem código. */
      redirect: 'manual',
    });
    const texto = await resposta.text();
    let dados: Record<string, unknown> = {};
    if (texto) {
      try {
        dados = JSON.parse(texto) as Record<string, unknown>;
      } catch {
        return { ok: false, status: resposta.status, dados: { message: 'Resposta inesperada do gateway.' } };
      }
    }
    return { ok: resposta.ok, status: resposta.status, dados };
  } catch (falha) {
    return { ok: false, status: 0, dados: { message: (falha as Error)?.message ?? 'sem resposta' } };
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * A VALIDADE SÓ É ACEITA SE FIZER SENTIDO. No primeiro PIX real da SpyPag
 * (30/09/2026) a tela recebeu o código SEM relógio nenhum — o número que veio
 * não era um prazo positivo. Prazo zero ou negativo faria a tela mostrar
 * "vencido" num código que acabou de nascer, e a pessoa desistiria sem tentar.
 * Ordem: segundos razoáveis; senão uma data no futuro; senão o padrão.
 */
function validadeSensata(segundosBrutos: unknown, dataBruta: unknown, padrao: number): number {
  const segundos = Number(segundosBrutos);
  if (Number.isFinite(segundos) && segundos >= 60 && segundos <= 86_400) return Math.floor(segundos);
  const ateData = Math.floor((Date.parse(String(dataBruta ?? '')) - Date.now()) / 1000);
  if (Number.isFinite(ateData) && ateData >= 60 && ateData <= 86_400) return ateData;
  if (segundosBrutos !== undefined || dataBruta !== undefined) {
    console.warn('[gateway] validade estranha na resposta:', segundosBrutos, dataBruta, `-> usando ${padrao} s`);
  }
  return padrao;
}

/**
 * CRIA O PIX NA SPYPAG e devolve no formato que `criarPedido` lê:
 * `transactionId`, `pix_code`, `status` e `calendar.expiration`.
 *
 * SEM UTM: a cobrança deles não tem campo de rastreio. A atribuição sempre
 * veio do NOSSO Redis (`attrib`, gravado em `criarPedido`); o que fica cego é
 * só o painel deles.
 */
async function cobrarPixNaSpyPag(
  c: ConfigGateway,
  p: { total: number; nome: string; cpf: string; titulo: string },
): Promise<{ ok: boolean; status: number; dados: Record<string, unknown> }> {
  const { ok, status, dados } = await chamarGateway('spypag', c, '/payments/pix', {
    metodo: 'POST',
    corpo: {
      amount: Math.round(p.total * 100) / 100,
      payer_name: p.nome,
      payer_email: emailParaOGateway(),
      payer_cpf: p.cpf,
      description: p.titulo.slice(0, 120),
      callback_url: urlDoAviso('spypag', c),
    },
  });

  const bloco = (dados.data ?? {}) as Record<string, unknown>;
  const transacao = String(bloco.transaction_uuid ?? '');
  const codigo = String(bloco.pix_code ?? bloco.qr_code ?? '');
  if (!ok || dados.success === false || !transacao || !codigo) {
    const recado = typeof dados.message === 'string' ? dados.message : '';
    console.error('[spypag] recusou a cobranca:', status, recado.slice(0, 200));
    /* 3xx é o redirect de erro deles: para a tela, "o banco não respondeu". */
    return { ok: false, status: status >= 300 && status < 400 ? 502 : status, dados };
  }

  return {
    ok: true,
    status,
    dados: {
      transactionId: transacao,
      pix_code: codigo,
      status: 'PENDING',
      calendar: { expiration: validadeSensata(bloco.expires_in_seconds, bloco.expires_at, 300) },
    },
  };
}

/**
 * O TELEFONE COMO A ZUCKPAY ACEITA: 10 ou 11 dígitos, SEM o 55.
 *
 * MEDIDO EM 07/10/2026, em produção: com `5581...` (12 dígitos) ela responde
 * `400 Telefone inválido. Envie 10 ou 11 dígitos numéricos (sem DDI)`, e a
 * tela de quem compra mostra "confira seus dados" — para um número que está
 * certo. Em 30 dias, 4 de 195 compradores digitaram o número com DDI: seriam
 * 4 vendas recusadas sem ninguém saber por quê.
 *
 * Só mexe em quem tem MAIS de 11 dígitos: um número de 11 que começa com 55 é
 * DDD 55 (Santa Maria/RS), e cortar ali mandaria um telefone de 9 dígitos. O
 * que se grava na venda continua sendo o que a pessoa digitou.
 */
function telefoneSemDdi(telefone: string): string {
  let d = telefone.replace(/\D+/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d.length > 11 ? d.slice(-11) : d;
}

/**
 * CRIA O PIX NA ZUCKPAY. O formato de resposta dela É o que `criarPedido` lê
 * (a tradução da AvenPay foi escrita imitando ele), então aqui só se confere a
 * validade e se devolve.
 *
 * O RASTREIO VAI NO CORPO: a ZuckPay aceita `utm_*`, `fbc`, `fbp`, `fbclid`,
 * `ttclid`, `src` e `sck`, guarda e devolve no aviso — o painel dela enxerga
 * de onde veio a venda.
 */
async function cobrarPixNaZuckPay(
  c: ConfigGateway,
  p: {
    total: number;
    nome: string;
    cpf: string;
    telefone: string;
    titulo: string;
    externalId: string;
    rastreio: Record<string, string>;
  },
): Promise<{ ok: boolean; status: number; dados: Record<string, unknown> }> {
  const { ok, status, dados } = await chamarGateway('zuckpay', c, '/v3/pix/qrcode', {
    metodo: 'POST',
    corpo: {
      nome: p.nome,
      cpf: p.cpf,
      valor: Number(p.total.toFixed(2)),
      email: emailParaOGateway(),
      telefone: telefoneSemDdi(p.telefone),
      descricao: p.titulo.slice(0, 120),
      external_id_client: p.externalId,
      urlnoty: urlDoAviso('zuckpay', c),
      ...p.rastreio,
    },
  });
  if (!ok) {
    const recado = typeof dados.message === 'string' ? dados.message : '';
    console.error('[zuckpay] recusou a cobranca:', status, recado.slice(0, 200));
    return { ok: false, status: status >= 300 && status < 400 ? 502 : status, dados };
  }
  const calendario = (dados.calendar ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status,
    dados: { ...dados, calendar: { expiration: validadeSensata(calendario.expiration, undefined, 1200) } },
  };
}

/**
 * A CHAVE FUNCIONA? — sem criar cobrança nenhuma. Chamada UMA vez, quando o
 * dono liga o interruptor; nunca em laço.
 *
 *   SpyPag    `GET /transactions?limit=1` — leitura pura
 *   ZuckPay   status de um pedido que não existe: chave errada dá 401/403,
 *             chave certa dá "não encontrado". Nenhum PIX nasce nos dois
 */
/**
 * CRIA O PIX NA PAGOU.AI e devolve no MESMO formato da ZuckPay
 * (`transactionId`, `pix_code`, `calendar.expiration`) — é o formato que
 * `criarPedido` lê, e assim o resto do caminho não sabe de qual gateway veio.
 *
 * CENTAVOS, e arredondados: 74.0 * 100 dá 7400 limpo, mas 14.9 * 100 dá
 * 1490.0000000000002, e a API recusa inteiro que não é inteiro.
 */
async function cobrarPixNaPagouAi(
  c: ConfigGateway,
  p: { total: number; nome: string; email: string; cpf: string; telefone: string; titulo: string; externalId: string },
): Promise<{ ok: boolean; status: number; dados: Record<string, unknown> }> {
  const centavos = Math.round(p.total * 100);
  const { ok, status, dados } = await chamarGateway('pagouai', c, '/v2/transactions', {
    metodo: 'POST',
    corpo: {
      external_ref: p.externalId,
      amount: centavos,
      currency: 'BRL',
      method: 'pix',
      notify_url: urlDoAviso('pagouai', c),
      buyer: {
        name: p.nome,
        /*
         * O E-MAIL DE QUEM COMPRA, e não o fixo de `emailParaOGateway`.
         *
         * A Pagou.ai identifica o comprador pelo e-mail: com o mesmo endereço em
         * toda cobrança, as oito primeiras vendas apareceram no painel dela sob
         * UM cliente só, com o nome do primeiro (03/10/2026). Além de ilegível,
         * muitas compras de nomes diferentes num e-mail só têm cara de fraude.
         * O fixo fica só de reserva, para o pedido que chegar sem e-mail.
         */
        email: p.email.includes('@') ? p.email : emailParaOGateway(),
        ...(p.telefone ? { phone: p.telefone } : {}),
        document: { type: 'CPF', number: p.cpf },
      },
      products: [{ name: p.titulo.slice(0, 120), price: centavos, quantity: 1 }],
    },
  });

  const bloco = (dados.data ?? {}) as Record<string, unknown>;
  const pix = (bloco.pix ?? {}) as Record<string, unknown>;
  const transacao = String(bloco.id ?? '');
  const codigo = String(pix.qr_code ?? '');
  if (!ok || dados.success === false || !transacao || !codigo) {
    /* Erro deles vem como "problem+json": o motivo mora em `detail`, e o campo
       recusado em `errors[].field`. Nunca o corpo inteiro no log. */
    const recado = typeof dados.detail === 'string' ? dados.detail : typeof dados.message === 'string' ? dados.message : '';
    const campos = Array.isArray(dados.errors)
      ? (dados.errors as Array<Record<string, unknown>>).map((e) => String(e?.field ?? '')).filter(Boolean).join(',')
      : '';
    console.error('[pagouai] recusou a cobranca:', status, recado.slice(0, 200), campos ? `campos: ${campos}` : '');
    return { ok: false, status: status >= 300 && status < 400 ? 502 : status || 502, dados: { message: recado } };
  }

  return {
    ok: true,
    status,
    dados: {
      transactionId: transacao,
      pix_code: codigo,
      status: 'PENDING',
      calendar: { expiration: validadeSensata(undefined, pix.expiration_date, 1200) },
    },
  };
}

/**
 * DO NÚMERO DA BEEHIVE ATÉ A NOSSA VENDA.
 *
 * Ela identifica a transação por um inteiro sequencial, e é só ele que volta no
 * aviso. A venda mora no Redis com a NOSSA referência; este mapa faz a ponte.
 * 60 dias cobrem com folga o prazo de estorno do PIX.
 *
 * O MAPA É NOSSO, e por isso o aviso não precisa ser acreditado: um aviso
 * forjado com o número de OUTRA transação só faz o servidor conferir aquela
 * transação com a Beehive — e marcar a venda DELA, que é a certa.
 */
const chaveDaBeehive = (numero: string) => `bee:tx:${numero.replace(/\D+/g, '')}`;

/**
 * CRIA O PIX NA BEEHIVE e devolve no formato que `criarPedido` lê.
 *
 * O `transactionId` devolvido é a NOSSA referência — ver o cabeçalho do bloco.
 * Se o mapa não puder ser gravado, a cobrança é RECUSADA aqui mesmo: sem ele o
 * aviso de pagamento não acha a venda, e seria dinheiro na conta com o pedido
 * parado em `pending` para sempre.
 */
async function cobrarPixNaBeehive(
  c: ConfigGateway,
  p: { total: number; nome: string; email: string; cpf: string; telefone: string; titulo: string; ip?: string },
): Promise<{ ok: boolean; status: number; dados: Record<string, unknown> }> {
  const referencia = referenciaPinguPag();
  const centavos = Math.round(p.total * 100);
  const telefone = telefoneSemDdi(p.telefone);
  const { ok, status, dados } = await chamarGateway('beehive', c, '/transactions', {
    metodo: 'POST',
    corpo: {
      amount: centavos,
      paymentMethod: 'pix',
      customer: {
        name: p.nome,
        email: p.email.includes('@') ? p.email : emailParaOGateway(),
        document: { number: p.cpf, type: 'cpf' },
        ...(telefone ? { phone: telefone } : {}),
      },
      /* Um item só, com o total: a tela já separa a oferta dos bumps. */
      items: [{ title: p.titulo.slice(0, 120), unitPrice: centavos, quantity: 1, tangible: false }],
      pix: { expiresInDays: 1 },
      postbackUrl: urlDoAviso('beehive', c),
      /* Só para o painel DELES mostrar qual pedido é. Quem liga os dois lados
         é o mapa do Redis, não este campo. */
      metadata: referencia,
      ...(p.ip ? { ip: p.ip } : {}),
    },
  });

  const pix = (dados.pix ?? {}) as Record<string, unknown>;
  const numero = String(dados.id ?? '').replace(/\D+/g, '');
  const codigo = String(pix.qrcode ?? '');
  if (!ok || !numero || !codigo) {
    const recado =
      typeof dados.message === 'string' ? dados.message : typeof dados.error === 'string' ? dados.error : '';
    console.error('[beehive] recusou a cobranca:', status, recado.slice(0, 200), 'status da transacao:', String(dados.status ?? ''));
    return { ok: false, status: status >= 300 && status < 400 ? 502 : status || 502, dados: { message: recado } };
  }

  const gravou = await redis(['SET', chaveDaBeehive(numero), referencia, 'EX', String(60 * 86_400)]);
  if (gravou === null) {
    console.error('[beehive] a cobranca', numero, 'nasceu mas o mapa nao foi gravado — recusando para nao vender sem saber que recebeu.');
    return { ok: false, status: 502, dados: { message: 'sem armazenamento' } };
  }

  return {
    ok: true,
    status,
    dados: {
      transactionId: referencia,
      pix_code: codigo,
      status: 'PENDING',
      acquirer: dados.acquirerType,
      calendar: { expiration: 1200 },
    },
  };
}

/**
 * A REFERÊNCIA QUE A PINGUPAG RECEBE — e que vira o id da venda.
 *
 * Só letras, números e hífen: o `externalId` das outras (`mpv.x.main-salmos`)
 * tem ponto e sublinhado, e os exemplos deles são todos `PEDIDO-2026-99881`.
 * Um caractere recusado aqui seria toda cobrança morrendo em 400.
 *
 * ALEATÓRIA DE VERDADE (`randomBytes`), porque este id libera a entrega em
 * `/orders/:id/access`: quem adivinhasse o de uma venda paga levaria o produto.
 */
function referenciaPinguPag(): string {
  return `MPV-${randomBytes(9).toString('hex').toUpperCase()}`;
}

/**
 * CRIA O PIX NA PINGUPAG e devolve no formato que `criarPedido` lê.
 *
 * O `transactionId` devolvido é a NOSSA referência — ver o cabeçalho do bloco.
 * O e-mail é o de quem compra (mesma lição da Pagou.ai: um e-mail só para todo
 * mundo junta todos os clientes num cadastro, com cara de fraude).
 */
async function cobrarPixNaPinguPag(
  c: ConfigGateway,
  p: { total: number; nome: string; email: string; cpf: string; telefone: string; titulo: string; rastreio: Record<string, string> },
): Promise<{ ok: boolean; status: number; dados: Record<string, unknown> }> {
  const referencia = referenciaPinguPag();
  const tracking: Record<string, string> = {};
  for (const campo of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const) {
    if (p.rastreio[campo]) tracking[campo] = p.rastreio[campo];
  }
  /* Sem campo de `ttclid`/`fbclid`: os dois livres são `src` e `sck`, o mesmo
     truque da Kiwify. A atribuição de verdade continua no nosso Redis. */
  const src = p.rastreio.fbclid ?? p.rastreio.src;
  const sck = p.rastreio.ttclid ?? p.rastreio.sck;
  if (src) tracking.src = src;
  if (sck) tracking.sck = sck;

  const { ok, status, dados } = await chamarGateway('pingupag', c, '/gateway/v1/transaction', {
    metodo: 'POST',
    corpo: {
      amount: Math.round(p.total * 100),
      description: p.titulo.slice(0, 120),
      reference: referencia,
      postback_url: urlDoAviso('pingupag', c),
      source: 'api_externa',
      customer: {
        name: p.nome,
        email: p.email.includes('@') ? p.email : emailParaOGateway(),
        document: p.cpf,
        phone: telefoneSemDdi(p.telefone),
      },
      ...(Object.keys(tracking).length ? { tracking } : {}),
    },
  });

  const codigo = String(dados.qr_code ?? dados.pix_code ?? '');
  if (!ok || dados.status === 'error' || dados.success === false || !codigo) {
    const recado = typeof dados.message === 'string' ? dados.message : typeof dados.error === 'string' ? dados.error : '';
    console.error('[pingupag] recusou a cobranca:', status, recado.slice(0, 200));
    return { ok: false, status: status >= 300 && status < 400 ? 502 : status || 502, dados: { message: recado } };
  }

  /* "2025-08-22 21:30:00" é hora de Brasília sem fuso: lida crua, a função
     (que roda em UTC) acharia que o código vence três horas antes. */
  const venceEm = typeof dados.expires_at === 'string' ? `${dados.expires_at.trim().replace(' ', 'T')}-03:00` : undefined;
  return {
    ok: true,
    status,
    dados: {
      transactionId: referencia,
      pix_code: codigo,
      status: 'PENDING',
      acquirer: dados.acquirer,
      calendar: { expiration: validadeSensata(undefined, venceEm, 1200) },
    },
  };
}

async function testarChave(id: IdGateway, c: ConfigGateway): Promise<{ ok: boolean; motivo?: string }> {
  /* Na PinguPag, os dados do vendedor são leitura pura: 200 com a chave certa,
     401 com a errada ou com a loja inativa. Nenhuma cobrança nasce. */
  /* Na Beehive, os dados da empresa: leitura pura, 401 com a chave errada. */
  if (id === 'beehive') {
    const { ok, status, dados } = await chamarGateway(id, c, '/company', { metodo: 'GET' });
    if (ok) {
      if (dados.blocked === true) return { ok: false, motivo: 'A conta está BLOQUEADA no gateway — ele não vai gerar cobrança.' };
      return { ok: true };
    }
    if (status === 401 || status === 403) {
      return { ok: false, motivo: `O gateway recusou a chave terminada em …${c.token.slice(-4)}. Use a chave SECRETA, de Configurações → Credenciais de API.` };
    }
    if (status === 0) return { ok: false, motivo: 'Não consegui falar com a URL informada.' };
    const recado = typeof dados.message === 'string' ? dados.message.slice(0, 160) : '';
    return { ok: false, motivo: `O gateway respondeu HTTP ${status}${recado ? `: ${recado}` : ''}.` };
  }
  if (id === 'pingupag') {
    const { ok, status, dados } = await chamarGateway(id, c, '/gateway/v1/seller', { metodo: 'GET' });
    if (ok) return { ok: true };
    if (status === 401 || status === 403) {
      return { ok: false, motivo: `O gateway recusou a chave terminada em …${c.token.slice(-4)} (chave errada ou loja inativa).` };
    }
    if (status === 0) return { ok: false, motivo: 'Não consegui falar com a URL informada.' };
    const recado = typeof dados.message === 'string' ? dados.message.slice(0, 160) : '';
    return { ok: false, motivo: `O gateway respondeu HTTP ${status}${recado ? `: ${recado}` : ''}.` };
  }
  /* Na Pagou.ai a listagem é leitura pura: 200 com a chave certa, 401 com a
     errada, e nenhuma cobrança nasce. */
  if (id === 'pagouai') {
    /* A chave PÚBLICA mora na mesma tela da secreta, com um botão de copiar ao
       lado — e foi ela que o dono colou três vezes em 02/10/2026, lendo só
       "o gateway recusou a chave". O motivo tem de dizer qual chave é. */
    if (/^pk_/i.test(c.token)) {
      return {
        ok: false,
        motivo: 'Essa é a CHAVE PÚBLICA (começa com pk_). Use a secreta, do botão verde "Revelar chave de API".',
      };
    }
    const { ok, status, dados } = await chamarGateway(id, c, '/v2/transactions?limit=1', { metodo: 'GET' });
    if (status === 401 || status === 403) {
      /* Chave de teste no endereço de produção também dá 401. Uma pergunta ao
         sandbox separa "chave errada" de "chave do ambiente errado". */
      const noSandbox = await chamarGateway(id, { ...c, url: 'https://api.sandbox.pagou.ai' }, '/v2/transactions?limit=1', {
        metodo: 'GET',
      });
      const recado = typeof dados.detail === 'string' ? dados.detail.slice(0, 120) : '';
      console.error('[pagouai] teste de chave recusado:', status, recado, '| sandbox:', noSandbox.status, '| final:', c.token.slice(-4));
      if (noSandbox.ok) {
        return { ok: false, motivo: 'Essa chave é de TESTE (sandbox), não de produção. Gere a chave de produção na Pagou.ai.' };
      }
      return {
        ok: false,
        motivo: `A Pagou.ai recusou a chave terminada em …${c.token.slice(-4)} (HTTP ${status}${recado ? `: ${recado}` : ''}).`,
      };
    }
    if (status === 0) return { ok: false, motivo: 'Não consegui falar com a URL informada.' };
    if (ok) return { ok: true };
    const recado = typeof dados.detail === 'string' ? dados.detail.slice(0, 160) : '';
    return { ok: false, motivo: `O gateway respondeu HTTP ${status}${recado ? `: ${recado}` : ''}.` };
  }
  const caminho = id === 'spypag' ? '/transactions?limit=1' : '/v3/pix/status?transactionId=teste-de-chave';
  const { ok, status, dados } = await chamarGateway(id, c, caminho, { metodo: 'GET' });
  if (status === 401 || status === 403) return { ok: false, motivo: 'O gateway recusou o Client ID ou o Secret.' };
  if (status === 0) return { ok: false, motivo: 'Não consegui falar com a URL informada.' };
  if (ok || id === 'zuckpay') {
    /* Na ZuckPay, 4xx que não seja de credencial é o "não encontrado" esperado.
       5xx não prova nada sobre a chave: melhor avisar do que ligar no escuro. */
    if (status < 500) return { ok: true };
  }
  const recado = typeof dados.message === 'string' ? dados.message.slice(0, 160) : '';
  return { ok: false, motivo: `O gateway respondeu HTTP ${status}${recado ? `: ${recado}` : ''}.` };
}

const CPF_DO_PAGADOR = (process.env.CPF_PADRAO ?? process.env.ZUCKPAY_CPF_PADRAO ?? '').replace(/\D+/g, '');

/** Os dois dígitos verificadores, para o CPF sintético passar na validação. */
function digitosVerificadores(base: string): string {
  const calcular = (parcial: string, pesoInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < parcial.length; i += 1) soma += Number(parcial[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const primeiro = calcular(base, 10);
  const segundo = calcular(base + primeiro, 11);
  return `${primeiro}${segundo}`;
}

/**
 * Devolve o CPF que vai na cobrança.
 *
 * Com `ZUCKPAY_CPF_PADRAO` configurado, é sempre ele. Sem a variável, gera um
 * por pedido: nove dígitos aleatórios mais os dois verificadores corretos.
 *
 * POR QUE NÃO UM NÚMERO FIXO INVENTADO: `111.111.111-11` e afins são recusados
 * por qualquer validador (dígitos repetidos), e um único CPF sintético repetido
 * em toda venda é o padrão mais fácil de detectar que existe.
 */
function cpfParaACobranca(): string {
  if (CPF_DO_PAGADOR.length === 11) return CPF_DO_PAGADOR;

  let base = '';
  for (let i = 0; i < 9; i += 1) base += Math.floor(Math.random() * 10);
  /* Nove dígitos iguais reprovam na validação: troca um e segue. */
  if (/^(\d)\1{8}$/.test(base)) base = `${(Number(base[0]) + 1) % 10}${base.slice(1)}`;
  return base + digitosVerificadores(base);
}

/**
 * O E-MAIL QUE VAI NO PAYLOAD DA ZUCKPAY — e por que ele é sempre o mesmo.
 *
 * **A ZuckPay EXIGE `email` no `POST /v3/pix/qrcode`.** Sem ele a resposta é
 * `400 Campos obrigatórios ausentes: email`, e a cobrança não nasce.
 *
 * Isso derrubou `/presente` em 20/09/2026: aquela tela não pede e-mail, de
 * propósito (o que ela entrega é uma caixa pelo correio, e cada campo a mais é
 * gente que some no formulário). A função aceitava o pedido sem e-mail e
 * repassava string vazia ao gateway — TODA tentativa de pagar o frete morria
 * com "confira seus dados", mandando a pessoa procurar erro onde não havia.
 *
 * DECISÃO DO DONO (20/09/2026): vai SEMPRE o mesmo endereço, para todo pedido.
 * Ele existe só para preencher o campo obrigatório do gateway — não é
 * mostrado em tela nenhuma e não substitui o e-mail de ninguém.
 *
 * O QUE ISSO CUSTA, POR ESCRITO: o comprovante que a ZuckPay mandaria ao
 * comprador passa a cair sempre nesta caixa. Quem compra no funil principal
 * deixa o e-mail dele no formulário e continua recebendo a ENTREGA por ele —
 * o que se perde é só o aviso de pagamento do gateway.
 *
 * O E-MAIL REAL DO CLIENTE NÃO É TOCADO: `venda.email` continua guardando o
 * que a pessoa digitou (ou vazio, quando ela não digitou nada), que é a
 * verdade do registro e o que o painel e a entrega usam.
 *
 * `ZUCKPAY_EMAIL_PADRAO` troca o endereço sem deploy.
 */
function emailParaOGateway(): string {
  const configurado = (process.env.EMAIL_PADRAO ?? process.env.ZUCKPAY_EMAIL_PADRAO ?? '').trim();
  return configurado.includes('@') ? configurado : 'compra@pay.com';
}

/* -------------------------------------------------------------------------- */
/* Resposta                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * QUEM PODE CHAMAR ESTA FUNÇÃO — e por que a lista é fechada.
 *
 * O site vive na Hostinger (`mensagemcelestial.online`) e esta função na
 * Vercel: são ORIGENS DIFERENTES, então o navegador exige CORS. Sem os
 * cabeçalhos abaixo, o checkout falha com "Failed to fetch" e a pessoa vê "não
 * foi possível falar com o servidor" — sem nada aparecer no log do gateway.
 *
 * A LISTA É FECHADA, e não `*`, porque esta função cria cobrança: com `*`
 * qualquer site do mundo pode montar um formulário, chamar o seu `/api/orders`
 * e gerar PIX na sua conta — cobrando gente que nunca entrou aqui. Origem nova
 * entra em `ALLOWED_ORIGINS`, separada por vírgula.
 */
const ORIGENS_PERMITIDAS = (process.env.ALLOWED_ORIGINS ?? 'https://mensagemcelestial.online,https://www.mensagemcelestial.online')
  .split(',')
  .map((origem) => origem.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function aplicarCors(req: IncomingMessage, res: ServerResponse): void {
  /*
   * `req.headers` com guarda: numa requisição sem cabeçalho nenhum isto era um
   * TypeError, e um erro aqui derruba a função ANTES de qualquer rota — o
   * checkout inteiro sairia do ar por causa da camada de CORS.
   */
  const origem = String(req.headers?.origin ?? '').replace(/\/+$/, '');
  if (origem && ORIGENS_PERMITIDAS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    /*
     * `Vary: Origin` não é detalhe: sem ele, um proxy ou CDN pode guardar a
     * resposta com o cabeçalho de UMA origem e servi-la para outra — e aí o
     * checkout quebra só para parte das pessoas, de forma intermitente.
     */
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    /*
     * `X-Admin-Token` PRECISA ESTAR AQUI, e a falta dele nao parece um problema
     * de CORS -- foi assim que apareceu em 04/09/2026.
     *
     * O painel manda a senha nesse cabecalho. Cabecalho que nao esta nesta
     * lista faz o navegador BARRAR o pedido antes de sair, e o `fetch` rejeita
     * exatamente como se a rede tivesse caido. A tela do painel dizia "nao foi
     * possivel falar com o servidor" enquanto o servidor respondia normal --
     * uma mensagem que manda procurar no lugar errado.
     *
     * Cabecalho novo no front entra nesta lista. Sempre.
     */
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Admin-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* Resposta de pagamento nunca pode ser cacheada por proxy nenhum. */
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(corpo));
}

/**
 * O erro que chega à tela.
 *
 * `message` é MOSTRADO À PESSOA, sem tradução — por isso é escrito na língua de
 * quem está comprando, e nunca contém código de gateway. "O CPF informado não é
 * válido" resolve; "ZUCKPAY_400 invalid document" faz ela achar que o site
 * quebrou e ir embora.
 */
function erro(res: ServerResponse, status: number, codigo: string, mensagem: string, campo?: string): void {
  json(res, status, { success: false, error: codigo, message: mensagem, ...(campo ? { field: campo } : {}) });
}

/* -------------------------------------------------------------------------- */
/* O pedido codificado no external_id_client                                   */
/* -------------------------------------------------------------------------- */

/**
 * `mpv.<aleatório>.<ids separados por hífen>` — o pedido inteiro numa string.
 *
 * A ZuckPay guarda este campo e o devolve na consulta de status, e é assim que
 * a função sabe, mais tarde, o que entregar: sem banco, sem sessão, sem estado
 * nenhum entre uma requisição e a seguinte.
 *
 * O trecho aleatório existe porque `external_id_client` também dá IDEMPOTÊNCIA
 * na ZuckPay: repetir o mesmo id dentro de 15 minutos devolve a cobrança
 * anterior em vez de criar outra. Isso protege contra duplo toque no botão —
 * mas se o id fosse só a lista de itens, DUAS PESSOAS comprando o mesmo combo
 * receberiam o mesmo QR, e a segunda pagaria a cobrança da primeira.
 */
function montarExternalId(ids: string[]): string {
  const aleatorio = Math.random().toString(36).slice(2, 10);
  return `mpv.${aleatorio}.${ids.join('-')}`;
}

function itensDoExternalId(externalId: string | null | undefined): string[] {
  const partes = String(externalId ?? '').split('.');
  if (partes.length < 3 || partes[0] !== 'mpv') return [];
  return partes.slice(2).join('.').split('-').filter((id) => CATALOGO[id]);
}

/* -------------------------------------------------------------------------- */
/* Conversa com a ZuckPay                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Os estados da ZuckPay traduzidos para os que o checkout entende.
 *
 * São DUAS listas do lado deles, e diferentes entre si: a consulta de status
 * responde `PENDING | PAID | FAILED | EXPIRADO | UNKNOWN` (com "EXPIRADO" em
 * português no meio dos outros), e o webhook usa
 * `PAID | PENDING | REFUSED | CHARGEBACK | REFUNDED`. As duas estão aqui.
 *
 * `UNKNOWN` VIRA `pending`, e não `failed`, de propósito: "não sei" não é "não
 * pagou". Tratar desconhecido como falha fecharia a tela na cara de quem
 * acabou de pagar e ainda está esperando o banco confirmar.
 */
function traduzirStatus(bruto: unknown): string {
  switch (String(bruto ?? '').toUpperCase()) {
    case 'PAID':
    /* `approved` é como a PinguPag diz pago. */
    case 'APPROVED':
    /*
     * OS OUTROS JEITOS DE DIZER "PAGO" (11/10/2026). Duas vendas de R$ 74 pagas
     * na ZuckPay ficaram `pending` aqui: a consulta respondeu 200, com um status
     * que não era nenhum dos de cima, e o `default` lá embaixo transformou
     * dinheiro recebido em "ainda não pagou" — sem entrega e sem evento. Estes
     * são os sinônimos que os gateways brasileiros usam; todos só chegam aqui
     * vindos da CONSULTA ao gateway, nunca do corpo de um aviso.
     */
    case 'COMPLETED':
    case 'CONFIRMED':
    case 'SUCCEEDED':
    case 'SUCCESS':
    case 'PAGO':
    case 'APROVADO':
    case 'CONCLUIDO':
    case 'CONCLUIDA':
      return 'completed';
    case 'EXPIRADO':
    case 'EXPIRED':
      return 'expired';
    case 'REFUSED':
    /* A Pagou.ai escreve `canceled` (um L só). Sem este case, PIX cancelado lá
       ficaria `pending` aqui para sempre e entraria na fila de lembrete. */
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled';
    case 'REFUNDED':
    case 'CHARGEBACK':
    /* `CHARGEDBACK` (com D) é a grafia da AvenPay. As duas existem aqui porque
       um `case` a menos vira faturamento contando dinheiro que já voltou. */
    case 'CHARGEDBACK':
      return 'refunded';
    /*
     * `MED` é a disputa do PIX ainda em análise no Banco Central — o dinheiro
     * está na conta e pode sair. NÃO é estorno (seria apagar receita que ainda
     * é real) e não pode virar `pending` (a venda foi paga e o produto saiu).
     * Fica como paga, que é o que ela é hoje; se virar estorno, o próximo aviso
     * chega como `CHARGEDBACK` e corrige.
     */
    case 'MED':
      return 'completed';
    case 'PROCESSING':
      return 'pending';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * O nome da ADQUIRENTE na resposta do gateway, se ela vier.
 *
 * A BUSCA É POR LISTA DE CANDIDATOS, e não por um caminho fixo, porque o nome
 * do campo muda por provedor e por versão da API — e este projeto já trocou de
 * gateway uma vez (PixGo → ZuckPay). Um caminho fixo cravado na v3 da ZuckPay
 * volta a devolver `null` no dia da próxima troca, sem ninguém perceber: o
 * painel simplesmente pararia de mostrar a adquirente, e "não informado" é
 * exatamente o que ele mostra quando está tudo bem.
 *
 * NÃO ACHAR É O CASO NORMAL e devolve `null`. Chutar o nome do gateway aqui
 * seria pior que não mostrar nada — daria ao dono uma resposta falsa numa
 * pergunta que ele faz justamente quando o dinheiro não bate.
 *
 * O teto de 60 caracteres é contra resposta estranha do gateway virar um campo
 * gigante dentro de cada venda: a memória é um JSON por pedido, e o painel lê
 * ~200 de uma vez.
 */
function acharAdquirente(dados: unknown): string | null {
  if (!dados || typeof dados !== 'object') return null;
  const raiz = dados as Record<string, unknown>;
  /* `acquirer_name` antes de `acquirer`: quando os dois vêm, o primeiro é o
     nome legível e o segundo costuma ser um código interno do gateway. */
  for (const campo of ['acquirer_name', 'acquirer', 'adquirente', 'psp', 'provider', 'processor', 'bank']) {
    const valor = raiz[campo];
    if (typeof valor === 'string' && valor.trim()) return valor.trim().slice(0, 60);
    /* Alguns devolvem objeto: `{ acquirer: { name: "..." } }`. */
    if (valor && typeof valor === 'object') {
      const dentro = valor as Record<string, unknown>;
      const nome = dentro.name ?? dentro.nome ?? dentro.label;
      if (typeof nome === 'string' && nome.trim()) return nome.trim().slice(0, 60);
    }
  }
  return null;
}

/**
 * O `amount_liquid` da ZuckPay — o que sobrou depois da taxa dela.
 *
 * A COBRANÇA É CRIADA EM REAIS (`valor: 74`), então a resposta deveria voltar
 * em reais também. "Deveria" não basta para número que vira faturamento: um
 * gateway que responda em centavos faria a venda de R$ 74 entrar como R$ 6.690
 * no painel, e ninguém desconfia de um número que só está grande.
 *
 * A CONFERÊNCIA É CONTRA O VALOR DO PRÓPRIO PEDIDO, que já se sabe: líquido
 * maior que o bruto é impossível — taxa não paga o vendedor. Quando isso
 * aparece, o mais provável é a unidade, e cem é o único fator que existe aqui;
 * se dividir por cem também não couber, o campo é descartado. Nulo faz a tela
 * dizer que não sabe, e não saber é melhor que mentir sobre dinheiro.
 */
function acharValorLiquido(dados: unknown, valorDoPedido: number): number | null {
  if (!dados || typeof dados !== 'object') return null;
  /*
   * A PAGOU.AI devolve a taxa em `fee`, e em CENTAVOS: `net_amount` é o que
   * será liquidado, `estimated_fee` é a taxa. Aqui a unidade é conhecida (a doc
   * diz centavos, e a cobrança foi criada em centavos), então divide-se por
   * cem direto — e a mesma conferência contra o bruto protege de surpresa.
   */
  const taxaPagou = (dados as Record<string, unknown>).fee;
  if (taxaPagou && typeof taxaPagou === 'object') {
    const liquidoEmCentavos = Number((taxaPagou as Record<string, unknown>).net_amount);
    const emReaisP = liquidoEmCentavos / 100;
    if (Number.isFinite(emReaisP) && emReaisP > 0 && emReaisP <= valorDoPedido) return Math.round(emReaisP * 100) / 100;
  }
  const bruto = (dados as Record<string, unknown>).amount_liquid;
  const n = typeof bruto === 'number' ? bruto : Number(String(bruto ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= valorDoPedido) return Math.round(n * 100) / 100;
  const emReais = n / 100;
  if (emReais > 0 && emReais <= valorDoPedido) return Math.round(emReais * 100) / 100;
  console.warn('[status] amount_liquid fora de escala:', n, 'para pedido de', valorDoPedido);
  return null;
}

const brl = (valor: number): string => `R$ ${valor.toFixed(2).replace('.', ',')}`;

/** `***.444.777-**` — o que a tela mostra para a pessoa se reconhecer. */
function mascararCpf(cpf: string): string {
  const digitos = String(cpf ?? '').replace(/\D+/g, '');
  if (digitos.length !== 11) return '';
  return `***.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-**`;
}

function montarPedido(
  id: string,
  oferta: string,
  ids: string[],
  status: string,
  extras: {
    pixCode?: string | null;
    pixImagem?: string | null;
    expiraEmSegundos?: number | null;
    pagoEm?: string | null;
    pedidoPai?: string | null;
    nome?: string;
    email?: string;
    cpf?: string;
  } = {},
): Record<string, unknown> {
  const itens = ids.map((itemId) => ({
    id: itemId,
    title: CATALOGO[itemId]?.titulo ?? itemId,
    amount: CATALOGO[itemId]?.preco ?? 0,
    amountFormatted: brl(CATALOGO[itemId]?.preco ?? 0),
  }));
  const total = itens.reduce((soma, item) => soma + item.amount, 0);

  return {
    id,
    offer: oferta,
    status,
    amount: total,
    amountFormatted: brl(total),
    items: itens,
    pix: extras.pixCode
      ? {
          code: extras.pixCode,
          imageUrl: extras.pixImagem ?? null,
          expiresAt: extras.expiraEmSegundos
            ? new Date(Date.now() + extras.expiraEmSegundos * 1000).toISOString()
            : null,
        }
      : null,
    paidAt: extras.pagoEm ?? null,
    parentOrderId: extras.pedidoPai ?? null,
    customer: {
      name: extras.nome ?? '',
      email: extras.email ?? '',
      documentMasked: mascararCpf(extras.cpf ?? ''),
    },
    createdAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* As três rotas                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `quemChamou` carrega o IP e o User-Agent de QUEM ESTA COMPRANDO.
 *
 * Eles so existem nesta requisicao. Quando o pagamento confirma, quem fala com
 * o servidor e a ZuckPay -- o IP dali e o do gateway, e mandar isso ao Meta e
 * pior que nao mandar nada: casa a venda com o servidor errado.
 */
/**
 * O WHATSAPP QUE RECEBE OS PEDIDOS DE BOLETO (13/10/2026, pedido do dono).
 *
 * Boleto aqui NÃO é emitido por máquina: pouca gente pede, então o dono emite à
 * mão (na Kiwify) e manda pelo WhatsApp. O site só faz duas coisas: guarda o
 * pedido, com CPF e e-mail, e leva a pessoa à conversa com este número.
 *
 * É TAMBÉM O INTERRUPTOR. Sem `BOLETO_WHATSAPP` na Vercel, `/ofertas` responde
 * `boleto: false`, a tela mostra o botão de PIX de sempre e esta rota recusa.
 * Publicar o código não liga nada; quem liga é o dono, pondo o número.
 * Só dígitos, com 55 e DDD (12 ou 13).
 */
function numeroDoBoleto(): string {
  const numero = String(process.env.BOLETO_WHATSAPP ?? '').replace(/\D+/g, '');
  return /^55\d{10,11}$/.test(numero) ? numero : '';
}

async function criarPedido(
  res: ServerResponse,
  corpo: Record<string, any>,
  quemChamou: { ua?: string; ip?: string } = {},
): Promise<void> {
  const oferta = String(corpo.offer ?? '');
  if (!CATALOGO[oferta]) return erro(res, 400, 'INVALID_OFFER', 'Produto indisponível. Recarregue a página e tente de novo.');

  /*
   * NAO SE COBRA POR AQUILO QUE NAO SE PODE ENTREGAR.
   *
   * Ultima barreira do upsell e do downsell: mesmo que a tela apareça por
   * engano -- pagina velha em cache, alguem chamando a API na mao -- aqui a
   * cobranca nao nasce. A tela pode errar; isto nao pode.
   */
  if (ADDONS.has(oferta) && !ofertaEntregavel(oferta)) {
    console.error(`[catalogo] ${oferta} recusado: DELIVERY_URL_${oferta.toUpperCase()} vazia`);
    return erro(res, 409, 'OFFER_UNAVAILABLE', 'Esta oferta não está disponível agora. Nada foi cobrado.');
  }

  /*
   * SÓ ENTRA BUMP QUE EXISTE NO CATÁLOGO, e a oferta principal nunca se repete
   * na lista. Sem esta filtragem, um `bumps: ["main","main","main"]` forjado no
   * DevTools triplicaria o valor — ou, pior, um id desconhecido entraria como
   * R$ 0,00 e a pessoa levaria um produto de graça.
   */
  const bumps: string[] = Array.isArray(corpo.bumps)
    ? [...new Set(corpo.bumps.map(String))].filter((id) => CATALOGO[id] && id !== oferta && id !== 'main' && id !== 'main_volta')
        /* Bônus a R$ 9,90 só acompanha a oferta de saída. */
        .filter((id) => !id.endsWith('_volta') || oferta === 'main_volta')
        /* Uma contribuição de gratidão por pedido: a primeira que vier. */
        .filter((id, i, todos) => !id.startsWith('semente_') || todos.findIndex((x) => x.startsWith('semente_')) === i)
    : [];
  const ids = [oferta, ...bumps];
  const total = ids.reduce((soma, id) => soma + CATALOGO[id].preco, 0);

  const cliente = (corpo.customer ?? {}) as Record<string, string>;
  /* Sem `<`/`>` nem caracteres de controle: o nome vai para a página /pagar,
     para o WhatsApp e para o painel. Nome de gente não tem nada disso. */
  let nome = [...String(cliente.name ?? '')].filter((c) => c !== '<' && c !== '>' && c.charCodeAt(0) >= 32).join('').trim();
  let email = String(cliente.email ?? '').trim();
  let telefone = String(cliente.phone ?? '').replace(/\D+/g, '');

  /*
   * O UPSELL HERDA O CLIENTE DO PEDIDO PAI. Sem isto, ele NUNCA vendeu.
   *
   * O contrato de src/lib/api.ts sempre disse que o upsell e o downsell mandam
   * `parentOrderId` no lugar do cliente, e que a API copiaria do pedido pai --
   * porque pedir nome e e-mail de novo no meio da compra e onde a pessoa
   * desiste. A funcao nunca copiou: o campo era so ecoado de volta na resposta.
   *
   * Resultado, desde que ela entrou no ar: TODO upsell e TODO downsell morriam
   * em 400 MISSING_CUSTOMER, e a tela mandava "preencha seu nome e e-mail" para
   * quem ACABOU de pagar -- numa tela que nao tem esses campos. Cem por cento da
   * receita de back-end, sempre. Achado em 05/09/2026, com a campanha rodando.
   *
   * A tela tambem passou a mandar o cliente (InlineCheckout.tsx), e isso e o
   * conserto principal, porque nao depende da memoria estar ligada. Este aqui e
   * a segunda rede: se um dia a tela parar de mandar, o upsell continua vendendo.
   */
  if ((!nome || !email) && corpo.parentOrderId) {
    const pai = await lerVenda(String(corpo.parentOrderId));
    if (pai) {
      nome = nome || pai.nome || '';
      email = email || pai.email || '';
      telefone = telefone || pai.telefone || '';
    }
  }

  /*
   * O E-MAIL É OBRIGATÓRIO — MENOS PARA O QUE VIAJA DE CAIXA (19/09/2026).
   *
   * Ele existe porque é por ele que o produto digital chega: sem e-mail, quem
   * pagou não recebe o acesso, e isso é venda feita e produto não entregue.
   *
   * Nas ofertas de frete (`SERVICOS`, o presente de São Miguel em `/presente`)
   * não há nada para mandar por e-mail: o que chega é um objeto, pelo correio,
   * e o que a entrega precisa é ENDEREÇO e WhatsApp. Exigir um dado que não vai
   * ser usado só acrescenta um campo entre a pessoa e o pagamento — decisão do
   * dono, tomada com isto na mesa: essas vendas nascem SEM e-mail, e no painel
   * a coluna fica vazia.
   *
   * O NOME CONTINUA OBRIGATÓRIO PARA TODOS: ele vai na cobrança, na etiqueta e
   * no painel.
   */
  /*
   * NO FUNIL `/novo` O E-MAIL TAMBÉM É DISPENSADO (10/10/2026). Conferido no
   * código nesse dia: este servidor NÃO ENVIA E-MAIL NENHUM — a entrega é na
   * tela e pelo WhatsApp. O campo era um terceiro obstáculo entre a pessoa e o
   * PIX, pedindo um dado que ninguém usa. O funil novo colhe nome e WhatsApp
   * antes da VSL, e o checkout abre pronto. Para o gateway que exige e-mail vai
   * o de `emailParaOGateway`, como já ia para todo mundo na SpyPag e na ZuckPay.
   *
   * DESDE 12/10/2026 NENHUM FUNIL EXIGE E-MAIL (pedido do dono: o campo saiu do
   * checkout inteiro). Quem ainda mandar um — página aberta antes do deploy,
   * `/pedido` — tem o e-mail guardado na venda como antes.
   */
  if (!nome) {
    return erro(res, 400, 'MISSING_CUSTOMER', 'Preencha seu nome para receber o acesso.');
  }

  /*
   * ==========================================================================
   * O WHATSAPP É OBRIGATÓRIO, E A AVENPAY É QUEM EXIGE (25/09/2026)
   * ==========================================================================
   *
   * MEDIDO direto na API deles, campo por campo, no dia da troca de gateway:
   *
   *     phone: ""            -> 502 "Provider error."
   *     sem o campo phone    -> 502 "Provider error."
   *     phone preenchido     -> cobrança criada
   *
   * A ZuckPay aceitava vazio; a AvenPay não. E o erro dela é OPACO: um 502 sem
   * nome de campo, que este servidor traduz para "o banco não respondeu agora".
   * Quem estivesse comprando leria isso, tentaria de novo, leria de novo, e
   * desistiria — com o clique do anúncio já pago e ninguém sabendo o motivo.
   *
   * No funil principal o formulário já pede WhatsApp, então isto quase nunca
   * dispara. Ele existe pelo caminho de `/presente`, onde o e-mail foi
   * dispensado (ver o comentário acima) e o telefone podia vir vazio.
   *
   * DEZ DÍGITOS é o mínimo de um número brasileiro (DDD + 8). Com o `55` na
   * frente chegam 12 ou 13, e os dois passam — a checagem é de piso, não de
   * formato, porque formato de telefone é onde se barra cliente de verdade.
   */
  if (telefone.length < 10) {
    return erro(res, 400, 'MISSING_PHONE', 'Preencha seu WhatsApp com DDD — é por ele que a entrega chega.');
  }

  /*
   * O CPF NÃO VEM DO FORMULÁRIO — ele é preenchido aqui. Ver CPF_DO_PAGADOR,
   * no topo deste arquivo, para o que essa decisão custa e como reduzir o risco.
   *
   * O que o cliente mandar em `customer.document` é ACEITO se for um CPF de 11
   * dígitos: se um dia o campo voltar à tela, o dado real vence o sintético sem
   * precisar mexer aqui.
   */
  const cpfInformado = String(cliente.document ?? '').replace(/\D+/g, '');
  const cpf = cpfInformado.length === 11 ? cpfInformado : cpfParaACobranca();
  /* O CPF que a PESSOA digitou, e só se os dígitos verificadores fecham. É o
     único que vai para a Pagou.ai — ver `cobrarPixNaPagouAi`. */
  const cpfReal =
    cpfInformado.length === 11 &&
    !/^(\d)\1{10}$/.test(cpfInformado) &&
    digitosVerificadores(cpfInformado.slice(0, 9)) === cpfInformado.slice(9)
      ? cpfInformado
      : '';

  const externalId = montarExternalId(ids);

  /*
   * O CARIMBO DO ANÚNCIO VIAJA COM A COBRANÇA.
   *
   * A ZuckPay aceita `utm_*`, `fbc`, `fbp`, `fbclid`, `gclid`, `ttclid`, `src`
   * e `sck` no corpo, guarda em `tracking_params` e devolve no webhook. É o que
   * permite saber qual anúncio pagou por cada venda sem rastreio próprio no
   * site — e é de graça, basta repassar o que o front mandar.
   */
  const CAMPOS_DE_RASTREIO = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'fbc', 'fbp', 'fbclid', 'gclid', 'ttclid', 'wbraid', 'gbraid', 'click_id', 'src', 'sck',
  ] as const;
  const rastreio: Record<string, string> = {};
  const carimbo = (corpo.tracking ?? {}) as Record<string, unknown>;
  for (const campo of CAMPOS_DE_RASTREIO) {
    const valor = carimbo[campo];
    if (typeof valor === 'string' && valor.trim() !== '') rastreio[campo] = valor.trim().slice(0, 500);
  }

  /*
   * ==========================================================================
   * O CARIMBO TAMBÉM SAI DO `attrib`, E ISSO NÃO É REDUNDÂNCIA
   * ==========================================================================
   *
   * MEDIDO EM 25/09/2026, lendo na API da AvenPay a cobrança que o nosso
   * próprio checkout acabara de criar: **`utms: null`**.
   *
   * A CAUSA: `tracking` é um bloco que o front NUNCA MANDOU. Ele manda
   * `attrib` (ver src/lib/atribuicao.ts) — e `attrib` usa outros nomes:
   * `origem` no lugar de `utm_source`, `criativo` no lugar de `utm_content`.
   * O laço acima lia um objeto que só existe no contrato, não no tráfego.
   *
   * Passou despercebido enquanto era a ZuckPay porque lá isso era enfeite: a
   * atribuição de verdade sempre veio do nosso Redis. Com a AvenPay continua
   * sendo — `veioDoTikTok` lê o `attrib` gravado, não o gateway. Mas o painel
   * DELES fica cego, e um dia alguém vai conferir uma venda por lá e achar que
   * o tráfego não tem origem.
   *
   * `tracking` VENCE quando existir: se um dia o front passar a mandá-lo, ele é
   * o dado mais específico. Isto aqui só preenche o que ficou vazio.
   */
  const marcas = (corpo.attrib ?? {}) as Record<string, unknown>;
  const DE_ATTRIB: Array<[string, string]> = [
    ['utm_source', 'origem'],
    ['utm_medium', 'conjunto'],
    ['utm_campaign', 'campanha'],
    ['utm_content', 'criativo'],
    ['utm_term', 'termo'],
    ['fbclid', 'fbclid'],
    ['ttclid', 'ttclid'],
    ['gclid', 'gclid'],
    ['fbc', 'fbc'],
    ['fbp', 'fbp'],
  ];
  for (const [campo, deOndeVem] of DE_ATTRIB) {
    if (rastreio[campo]) continue;
    const valor = marcas[deOndeVem];
    if (typeof valor === 'string' && valor.trim() !== '') rastreio[campo] = valor.trim().slice(0, 500);
  }

  /*
   * AQUI FICAVA O TETO DE COBRANÇAS POR IP (30/hora). REMOVIDO EM 19/09/2026,
   * a pedido: quem volta à tela e gera o PIX de novo TEM de conseguir gerar.
   *
   * O teto existia por um motivo real — um script gerou pedidos com telefones
   * alheios sem parar, e cada um vira cobrança real no gateway, entra na fila
   * do WhatsApp (o robô manda PIX para quem nunca pediu, e o número é banido) e
   * empurra venda paga de verdade para fora da lista de 200 que o painel lê.
   * Nada disso deixou de ser verdade: o que mudou é que barrar comprador de
   * volta custa mais caro que o abuso.
   *
   * O IP SEGUE GRAVADO NO PEDIDO (`quemChamou.ip`, logo abaixo) — ele não é
   * trava, é o que o Meta usa para casar a venda com o anúncio junto do
   * User-Agent e do `fbc`. Tirar isso não soltaria ninguém; só pioraria a
   * atribuição.
   *
   * Se o abuso voltar, o lugar de barrar NÃO é o IP: é telefone/CPF repetido
   * com pedido ainda pendente, que separa o comprador do script.
   */

  /*
   * QUAL GATEWAY COBRA: o que estiver ligado no painel (SpyPag ou ZuckPay).
   * Nenhum ligado e completo — inclusive sem PUBLIC_BASE_URL, porque sem o
   * aviso nada descobre que o PIX foi pago — é recusa com 503, antes de
   * qualquer cobrança nascer. Ver o bloco OS GATEWAYS DE PIX, no topo.
   */
  /*
   * BOLETO: O PEDIDO É GUARDADO E A PESSOA VAI AO WHATSAPP. Nenhum gateway é
   * chamado e nenhuma cobrança nasce aqui.
   *
   * A venda fica `pending` com `pagamento: 'boleto'`, e é isso que faz o resto
   * funcionar sem código novo: quando o boleto compensar, o dono toca em "Ela
   * pagou por fora" no painel (`/admin/orders/<id>/pago`) e o evento de compra
   * sai com o clique do anúncio que esta venda guardou AGORA. Sem `pixCopiaECola`
   * o robô não manda lembrete de PIX para ela, e sem `gateway` a conferência de
   * pendentes não a consulta em lugar nenhum.
   *
   * CPF E E-MAIL SÃO EXIGIDOS, e o CPF tem de fechar os dígitos: boleto com CPF
   * errado é recusado pelo banco, e o dono só descobriria depois de emitir.
   *
   * A MENSAGEM DO WHATSAPP LEVA NOME, CPF E E-MAIL (decisão do dono, 13/10/2026:
   * "tem que ir com o nome, o CPF, o e-mail para ser colocado no boleto"). A
   * primeira versão levava só o código e o valor, e o dono tinha de abrir o
   * painel a cada pedido para copiar os dados. É a exceção consciente à regra
   * 3: o link é do WhatsApp, quem o abre é a própria pessoa, no aparelho dela,
   * e o texto é a mensagem que ELA envia. Nada disso passa por URL nossa.
   */
  if (corpo.metodo === 'boleto') {
    const numero = numeroDoBoleto();
    if (!numero) return erro(res, 503, 'BOLETO_OFF', 'O boleto não está disponível agora. Você pode contribuir pelo PIX.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return erro(res, 400, 'MISSING_EMAIL', 'Informe um e-mail válido: o boleto é emitido nele.', 'email');
    }
    if (!cpfReal) return erro(res, 400, 'DOCUMENT_REQUIRED', 'Informe um CPF válido: o banco exige para emitir o boleto.', 'document');

    const id = `BOL-${randomBytes(9).toString('hex').toUpperCase()}`;
    const codigo = id.slice(0, 10);
    const attribDoBoleto = (corpo.attrib && typeof corpo.attrib === 'object')
      ? Object.fromEntries(
          Object.entries(corpo.attrib as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string' && v)
            .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 300)]),
        )
      : undefined;
    await gravarVenda({
      id, nome, email, telefone, itens: ids, valor: total,
      status: 'pending', criadoEm: new Date().toISOString(), pagoEm: null,
      attrib: attribDoBoleto,
      pagamento: 'boleto', cpf: cpfReal,
      funil: corpo.funil === 'pedido' ? 'pedido' : corpo.funil === 'novo' ? 'novo' : corpo.funil === 'sinais' ? 'sinais' : undefined,
      metaEnviadoEm: null, ua: quemChamou.ua, ip: quemChamou.ip,
    });
    await avisarNoCelular('pix', { nome, valor: total, itens: ids, attrib: attribDoBoleto, pagamento: 'boleto' });
    const cpfFormatado = cpfReal.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    const texto = [
      'Olá! Quero contribuir com BOLETO.',
      '',
      `Pedido: ${codigo}`,
      `Valor: ${brl(total)}`,
      `Nome: ${nome}`,
      `CPF: ${cpfFormatado}`,
      `E-mail: ${email}`,
    ].join('\n');
    return json(res, 201, {
      success: true,
      data: {
        id, boleto: true, codigo, amount: total, amountFormatted: brl(total),
        whatsapp: `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`,
      },
    });
  }

  let ativo = await gatewayAtivo();
  /*
   * A ROTA DE TESTE `/pagou` (03/10/2026): o pedido diz `gateway: "p"` e a
   * cobrança nasce na Pagou.ai MESMO COM O INTERRUPTOR DELA DESLIGADO — é o que
   * deixa o dono testar o gateway novo sem tirar do ar o que está validado na
   * página principal. Só a letra `p` é aceita, e só com a chave já salva no
   * painel: não é um seletor de gateway aberto ao navegador.
   */
  if (corpo.gateway === 'p') {
    const doP = await lerGateway('pagouai');
    if (!doP.token || !urlDoAviso('pagouai', doP)) {
      return erro(res, 503, 'GATEWAY_NOT_CONFIGURED', 'Este pagamento ainda não foi configurado. Nenhuma cobrança foi gerada.');
    }
    ativo = { id: 'pagouai', c: doP };
  }
  if (!ativo) {
    console.error('[gateway] nenhum gateway ligado e completo no painel. Cobranca recusada.');
    return erro(res, 503, 'GATEWAY_NOT_CONFIGURED', 'O pagamento está temporariamente indisponível. Nenhuma cobrança foi gerada.');
  }

  /*
   * A PAGOU.AI EXIGE O DOCUMENTO DO PAGADOR (`DOCUMENT_REQUIRED`, na primeira
   * cobrança real, em 03/10/2026 — a doc diz opcional). E o CPF sintético de
   * `cpfParaACobranca` NÃO vai para ela: é o CPF que a pessoa digitou, ou
   * nada. O `field` faz o checkout mostrar o campo, que na página principal
   * fica escondido.
   */
  if (ativo.id === 'pagouai' && !cpfReal) {
    return erro(res, 400, 'MISSING_DOCUMENT', 'Informe o seu CPF para gerar o PIX — o banco exige.', 'document');
  }

  const { ok, status, dados } =
    ativo.id === 'spypag'
      ? await cobrarPixNaSpyPag(ativo.c, { total, nome, cpf, titulo: CATALOGO[oferta].titulo })
      : ativo.id === 'pagouai'
        ? await cobrarPixNaPagouAi(ativo.c, { total, nome, email, cpf: cpfReal, telefone, titulo: CATALOGO[oferta].titulo, externalId })
        : ativo.id === 'beehive'
          ? await cobrarPixNaBeehive(ativo.c, { total, nome, email, cpf, telefone, titulo: CATALOGO[oferta].titulo, ip: quemChamou.ip })
        : ativo.id === 'pingupag'
          ? await cobrarPixNaPinguPag(ativo.c, { total, nome, email, cpf, telefone, titulo: CATALOGO[oferta].titulo, rastreio })
        : await cobrarPixNaZuckPay(ativo.c, {
          total,
          nome,
          cpf,
          telefone,
          titulo: CATALOGO[oferta].titulo,
          externalId,
          rastreio,
        });
  const validadeS =
    typeof (dados.calendar as Record<string, unknown> | undefined)?.expiration === 'number'
      ? Number((dados.calendar as Record<string, unknown>).expiration)
      : VALIDADE_DO_PIX_EM_SEGUNDOS;

  if (!ok) {
    /*
     * 429 é o teto de 5 requisições por 30 minutos declarado na documentação
     * deles. Dizer "tente novamente" sem mais nada faria a pessoa martelar o
     * botão e queimar o resto da cota.
     */
    if (status === 429) {
      return erro(res, 429, 'RATE_LIMITED', 'Muitas tentativas seguidas. Espere um minuto e toque de novo — nada foi cobrado.');
    }
    /*
     * A MENSAGEM DO GATEWAY NÃO CHEGA A QUEM ESTÁ COMPRANDO.
     *
     * Ela chegava, e em 04/09/2026 o dono fotografou o resultado: a tela do
     * checkout, com R$ 88,00 e o botão de pagar, mostrando **"Erro interno do
     * servidor."** — a mensagem da ZuckPay, repassada crua. Para quem está
     * comprando isso diz duas coisas erradas ao mesmo tempo: que o defeito é
     * DESTE site, e — pior — não diz que NADA FOI COBRADO. Quem já tinha o app
     * do banco aberto fica sem saber se pode tentar de novo.
     *
     * O texto do gateway continua existindo: vai para o log da função, que é
     * onde ele serve para alguma coisa. Para a tela vai o que a pessoa precisa
     * saber — que não foi cobrada, e o que fazer agora.
     */
    if (typeof dados.message === 'string' && dados.message) {
      console.error('[gateway] recusou a cobranca:', status, dados.message);
    }
    const doGateway = status >= 500 || status === 0;
    return erro(
      res,
      doGateway ? 502 : 400,
      'GATEWAY_ERROR',
      doGateway
        ? 'O banco não respondeu agora. Nada foi cobrado — espere alguns segundos e toque de novo.'
        : 'Não foi possível gerar o PIX agora. Nada foi cobrado — confira seus dados e tente de novo.',
    );
  }

  const transacao = String(dados.transactionId ?? '');
  const pixCode = String(dados.pix_code ?? dados.qrcode ?? '');
  if (!transacao || !pixCode) {
    return erro(res, 502, 'GATEWAY_ERROR', 'O gateway não devolveu a chave PIX. Tente novamente.');
  }

  /*
   * A VENDA É GRAVADA ANTES DA RESPOSTA SAIR, mas sem `await` que a segure.
   *
   * É a única janela em que o carimbo do anúncio existe: daqui a pouco a pessoa
   * sai do site e só volta o aviso de pagamento da ZuckPay, que não sabe nada
   * de anúncio. Se a memória estiver fora, `gravarVenda` não faz nada e a venda
   * segue normal -- o PIX nasce, o QR aparece, a entrega funciona. O que se
   * perde é o painel e a atribuição, nunca o dinheiro.
   */
  const attrib = (corpo.attrib && typeof corpo.attrib === 'object')
    ? Object.fromEntries(
        Object.entries(corpo.attrib as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' && v)
          .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 300)]),
      )
    : undefined;

  /*
   * `await`, PELA MESMA RAZAO DA CONSULTA DE STATUS: numa funcao sem servidor a
   * maquina e congelada quando a resposta sai, e o que foi disparado sem espera
   * pode nunca acontecer. Uma venda que nao e gravada aqui nao existe no painel
   * e nao tem como virar `Purchase` depois -- o carimbo do anuncio so passa por
   * aqui uma vez.
   *
   * `gravarVenda` ja engole o proprio erro e tem teto de 4 s, entao esperar nao
   * arrisca a cobranca que acabou de nascer.
   */
  await gravarVenda({
    id: transacao,
    nome,
    email,
    telefone,
    itens: ids,
    valor: total,
    status: 'pending',
    criadoEm: new Date().toISOString(),
    pagoEm: null,
    /* Quase sempre `null` nesta hora: o PIX ainda não foi liquidado, e quem
       liquida só se sabe na confirmação. Vem junto quando o gateway informa. */
    adquirente: acharAdquirente(dados),
    attrib,
    /* É por este campo que a tela do QR e a varredura sabem que NÃO PODEM
       perguntar o status ao gateway. Ver o bloco da AvenPay, no topo. */
    gateway: ativo.id,
    funil: corpo.funil === 'pedido' ? 'pedido' : corpo.funil === 'novo' ? 'novo' : corpo.funil === 'sinais' ? 'sinais' : undefined,
    /* Guardado para o lembrete de PIX em aberto poder levar o código junto. */
    pixCopiaECola: pixCode,
    pixValidadeS: validadeS,
    metaEnviadoEm: null,
    ua: quemChamou.ua,
    ip: quemChamou.ip,
  });

  /* O aviso de PIX gerado no celular do dono. Depois de gravar, e com teto
     próprio de 2,5 s: nunca segura nem derruba a cobrança que acabou de nascer. */
  await avisarNoCelular('pix', { nome, valor: total, itens: ids, attrib, gateway: ativo.id });

  const calendario = (dados.calendar ?? {}) as Record<string, unknown>;
  json(res, 201, {
    success: true,
    data: montarPedido(transacao, oferta, ids, traduzirStatus(dados.status), {
      pixCode,
      pixImagem: typeof dados.qrcode_image === 'string' ? dados.qrcode_image : null,
      expiraEmSegundos: typeof calendario.expiration === 'number' ? calendario.expiration : VALIDADE_DO_PIX_EM_SEGUNDOS,
      pedidoPai: corpo.parentOrderId ? String(corpo.parentOrderId) : null,
      nome,
      email,
      cpf,
    }),
  });
}

/**
 * A PÁGINA DE PAGAMENTO DELA — `/pagar/<id>`.
 *
 * O link é da PESSOA, não do produto: ela abre, toca num botão e sai um código
 * novo, vivo. É a resposta ao código que vence em 20 minutos enquanto a
 * mensagem espera não lida no WhatsApp.
 *
 * SERVIDA PELA FUNÇÃO, e não pelo site. O front mora na Hostinger e é estático;
 * uma tela nova lá significa build, `.htaccess` e um segundo lugar onde a
 * variável de ambiente pode faltar — foi assim que o checkout ficou girando
 * para sempre em 04/09/2026. Aqui é um `GET`, no mesmo arquivo que já cobra.
 *
 * TUDO EMBUTIDO: nada de fonte externa, nada de framework, nada de CDN. Quem
 * abre isto está com o app do banco na outra aba, muitas vezes em 3G ruim, e
 * cada arquivo a mais é uma chance de a tela aparecer branca.
 *
 * O QUE A PÁGINA NÃO MOSTRA: e-mail, telefone, CPF, nem sobrenome. O link viaja
 * pelo WhatsApp e pode ser encaminhado; o que ele revela tem de ser o mínimo
 * para a pessoa se reconhecer — primeiro nome, o que pediu, e quanto é.
 */
function paginaDePagamento(id: string, v: Venda | null): string {
  const primeiro = String(v?.nome ?? '').trim().split(/\s+/)[0] ?? '';
  const itens = (v?.itens ?? ['main']).map((i) => CATALOGO[i]?.titulo ?? i);
  const total = v?.valor ?? 0;
  const escapar = (t: string) =>
    String(t).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

  /*
   * `<` VIRA `<` ANTES DE ENTRAR NO <script>. JSON.stringify não escapa
   * `<`, então um nome ou id contendo `</script><script>` fecharia a tag e
   * rodaria código no domínio do painel (auditoria de 15/09/2026). Dentro de
   * uma string JS `<` é o mesmo `<` — o navegador lê igual, só não o vê
   * como HTML. U+2028/2029 são quebras de linha para o JS e não para o JSON.
   */
  /* A barra invertida escrita como código 92: uma ferramenta que "corrige" escapes já quebrou esta linha uma vez (15/09). */
  const BARRA = String.fromCharCode(92);
  const dados = JSON.stringify({
    id,
    achou: Boolean(v),
    jaPago: v?.status === 'completed',
    primeiro,
    itens,
    total,
    totalFormatado: brl(total),
  })
    .replace(/</g, BARRA + 'u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), BARRA + 'u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), BARRA + 'u2029');

  /*
   * CUIDADO AO EDITAR: o script do navegador mora dentro deste template
   * literal. Uma barra invertida sozinha (um `\n` dentro de string do cliente)
   * é consumida AQUI e chega ao navegador como quebra de linha de verdade —
   * string aberta, erro de sintaxe, e a página fica em branco sem nenhum aviso.
   * Escreva duas barras. Aconteceu no CRM em 08/09/2026 e custou meia hora.
   */
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Sua contribuição — Mensagem Celestial</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: 20px 16px 48px;
    background: #17120E; color: #F3E9DD;
    font: 18px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .caixa { max-width: 520px; margin: 0 auto; }
  .marca { font-size: 15px; letter-spacing: .14em; text-transform: uppercase; color: #C9A227; text-align: center; margin-bottom: 22px; }
  h1 { font-size: 25px; line-height: 1.25; margin: 0 0 14px; font-weight: 700; }
  p { margin: 0 0 14px; }
  .fraco { color: #B9A991; font-size: 16px; }
  .cartao { background: #211A14; border: 1px solid #3A2E24; border-radius: 14px; padding: 18px; margin: 0 0 20px; }
  .item { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 16px; }
  .total { display: flex; justify-content: space-between; border-top: 1px solid #3A2E24; margin-top: 10px; padding-top: 12px; font-size: 21px; font-weight: 700; }
  /* 60px de altura e 20px de fonte: o alvo tem de ser confortavel para o dedo
     de quem tem 65 anos, que e o publico desta operacao. */
  button {
    display: block; width: 100%; min-height: 60px; padding: 16px;
    font: 700 20px/1.3 inherit; color: #17120E; background: #C9A227;
    border: 0; border-radius: 12px; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  button.calmo { background: #2E2419; color: #F3E9DD; border: 1px solid #4A3B2C; font-size: 17px; min-height: 52px; }
  .oculto { display: none !important; }
  #qr { display: block; width: 220px; height: 220px; margin: 0 auto 16px; background: #fff; border-radius: 12px; padding: 8px; }
  /* O codigo quebra em qualquer ponto: sem isto ele estoura a largura e a
     pagina inteira rola de lado no celular. */
  #codigo {
    font: 13px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    background: #0F0B08; border: 1px solid #3A2E24; border-radius: 10px;
    padding: 12px; margin: 0 0 14px; word-break: break-all; color: #D8CBB8; user-select: all;
  }
  .aviso { background: #2A1F12; border: 1px solid #6B4E1E; border-radius: 10px; padding: 13px; font-size: 16px; color: #EBD9B4; }
  .bom { background: #14251A; border-color: #2E6B3E; color: #CFE9D4; }
  .ruim { background: #2A1614; border-color: #7A2E28; color: #F1CFCB; }
  .passos { margin: 16px 0 0; padding-left: 22px; font-size: 16px; color: #C9BBA6; }
  .passos li { margin-bottom: 7px; }
</style>
</head>
<body>
<div class="caixa">
  <div class="marca">Mensagem Celestial</div>

  <div id="naoachou" class="oculto">
    <h1>Não encontrei este pedido</h1>
    <p class="fraco">O link pode estar incompleto. Chame no WhatsApp que a gente resolve na hora.</p>
  </div>

  <div id="pago" class="oculto">
    <h1>Sua contribuição já foi confirmada</h1>
    <div class="aviso bom">A oração completa e consagrada e o áudio guiado chegam no seu WhatsApp. Se ainda não chegaram, é só chamar por lá.</div>
  </div>

  <div id="principal" class="oculto">
    <h1 id="titulo">Sua contribuição</h1>
    <p class="fraco">O código do PIX vale por poucos minutos. Se o seu venceu, gere um novo aqui — sem custo nenhum a mais.</p>

    <div class="cartao">
      <div id="itens"></div>
      <div class="total"><span>Total</span><span id="total"></span></div>
    </div>

    <div id="antes">
      <button id="gerar">Gerar meu código PIX</button>
    </div>

    <div id="depois" class="oculto">
      <img id="qr" alt="QR Code do PIX">
      <div id="codigo"></div>
      <button id="copiar">Copiar código</button>
      <ol class="passos">
        <li>Abra o aplicativo do seu banco.</li>
        <li>Procure <b>PIX</b> e depois <b>Pix Copia e Cola</b>.</li>
        <li>Cole o código, confira o valor e confirme.</li>
      </ol>
      <p class="fraco" style="margin-top:16px">Assim que a contribuição cair, esta tela avisa sozinha.</p>
      <button id="denovo" class="calmo">Gerar outro código</button>
    </div>

    <div id="recado" class="aviso oculto" style="margin-top:16px"></div>
  </div>
</div>

<script>
(function () {
  var D = ${dados};
  var $ = function (i) { return document.getElementById(i); };
  var mostrar = function (i) { $(i).classList.remove('oculto'); };
  var esconder = function (i) { $(i).classList.add('oculto'); };

  if (!D.achou) { mostrar('naoachou'); return; }
  if (D.jaPago) { mostrar('pago'); return; }

  mostrar('principal');
  $('titulo').textContent = D.primeiro ? D.primeiro + ', sua contribuição' : 'Sua contribuição';
  $('total').textContent = D.totalFormatado;
  D.itens.forEach(function (t) {
    var l = document.createElement('div');
    l.className = 'item';
    l.textContent = t;
    $('itens').appendChild(l);
  });

  var recado = function (texto, classe) {
    var r = $('recado');
    r.textContent = texto;
    r.className = 'aviso' + (classe ? ' ' + classe : '');
  };

  var idAtual = D.id;
  var relogio = null;

  /* O QR vem do gateway como imagem; se ele nao mandar, o copia-e-cola sozinho
     resolve — e e o caminho que a maioria usa no celular de qualquer jeito. */
  var desenhar = function (dados) {
    idAtual = dados.id || idAtual;
    var pix = dados.pix || {};
    if (pix.imageUrl) { $('qr').src = pix.imageUrl; $('qr').classList.remove('oculto'); }
    else { $('qr').classList.add('oculto'); }
    $('codigo').textContent = pix.code || '';
    esconder('antes');
    mostrar('depois');
    recado('', '');
    $('recado').classList.add('oculto');
    if (relogio) clearInterval(relogio);
    relogio = setInterval(conferir, 6000);
  };

  var gerar = function (botao) {
    botao.disabled = true;
    var antes = botao.textContent;
    botao.textContent = 'Gerando...';
    fetch('/api/orders/' + encodeURIComponent(idAtual) + '/renovar', { method: 'POST' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) {
        botao.disabled = false;
        botao.textContent = antes;
        if (r.j && r.j.data && r.j.data.jaPago) { esconder('principal'); mostrar('pago'); return; }
        if (!r.ok || !r.j || !r.j.success) {
          mostrar('recado');
          recado((r.j && r.j.message) || 'Não consegui gerar agora. Nada foi cobrado — toque de novo em instantes.', 'ruim');
          return;
        }
        desenhar(r.j.data);
      })
      .catch(function () {
        botao.disabled = false;
        botao.textContent = antes;
        mostrar('recado');
        recado('Sem conexão agora. Nada foi cobrado — confira a internet e toque de novo.', 'ruim');
      });
  };

  $('gerar').addEventListener('click', function () { gerar($('gerar')); });
  $('denovo').addEventListener('click', function () { gerar($('denovo')); });

  $('copiar').addEventListener('click', function () {
    var texto = $('codigo').textContent;
    var fim = function () {
      $('copiar').textContent = 'Código copiado';
      setTimeout(function () { $('copiar').textContent = 'Copiar código'; }, 2500);
    };
    /* navigator.clipboard nao existe fora de HTTPS nem em navegador velho, e
       este publico usa muito WebView antigo. O caminho do textarea funciona nos
       dois, entao ele fica como rede. */
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(fim, function () { velho(texto, fim); });
    } else { velho(texto, fim); }
  });

  function velho(texto, fim) {
    var a = document.createElement('textarea');
    a.value = texto;
    a.setAttribute('readonly', '');
    a.style.position = 'fixed';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.select();
    try { document.execCommand('copy'); fim(); } catch (e) { /* resta selecionar a mao */ }
    document.body.removeChild(a);
  }

  /* Pergunta de 6 em 6 segundos, e para assim que confirma. Falha de consulta
     nao muda a tela: quem pagou nao pode ver "deu erro" por causa da rede. */
  function conferir() {
    fetch('/api/orders/' + encodeURIComponent(idAtual))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var s = j && j.data && j.data.status;
        if (s === 'paid' || s === 'completed' || s === 'approved') {
          if (relogio) clearInterval(relogio);
          esconder('principal');
          mostrar('pago');
        }
      })
      .catch(function () {});
  }
})();
</script>
</body>
</html>`;
}

async function consultarPedido(res: ServerResponse, id: string): Promise<void> {
  /*
   * ==========================================================================
   * ESTA ROTA NÃO FALA COM O GATEWAY. NUNCA.
   * ==========================================================================
   *
   * Ela é chamada EM LAÇO pela tela do QR — medido em 24/09/2026: 227 vezes num
   * pedido de 14 minutos. A AvenPay PROÍBE consulta de status ("strictly
   * prohibited... may result in temporary or permanent IP block"), e IP
   * bloqueado é o funil inteiro parado, não uma métrica errada.
   *
   * Quem descobre que o PIX foi pago é o webhook, que grava `status` e `pagoEm`
   * no Redis. Aqui só se LÊ. A tela continua idêntica, com o mesmo ciclo — e na
   * prática mais rápida: uma leitura de Redis no lugar de uma ida à internet.
   */
  const gravada = await lerVenda(id);
  if (!gravada) return erro(res, 404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');

  const itens = gravada.itens?.length ? gravada.itens : ['main'];
  json(res, 200, {
    success: true,
    data: montarPedido(id, itens[0] ?? 'main', itens, gravada.status, {
      pagoEm: gravada.pagoEm ?? null,
      /* Ver `codigoPixGuardado`: a tela que perdeu o código o recupera aqui,
         em vez de ficar presa em "Preparando seu código PIX…". */
      ...codigoPixGuardado(gravada),
    }),
  });
}

/**
 * O CÓDIGO DO PIX VOLTA EM TODA CONSULTA, e não só na criação.
 *
 * ACHADO EM 25/09/2026, num pedido real de R$ 88: a tela ficou presa em
 * "Preparando seu código PIX…" para sempre, com 41 consultas seguidas voltando
 * `pix: null`. O pedido existia, o código existia gravado — só não voltava.
 *
 * A CAUSA É UM DESENHO QUE PARECIA RAZOÁVEL: o copia-e-cola saía UMA vez, na
 * resposta da criação, e a tela guardava. Quem recarregasse a página, voltasse
 * pelo histórico, ou tivesse a aba descartada pelo celular por falta de memória
 * (comum em aparelho de R$ 700, que é o deste público) perdia o código — e a
 * consulta, que era a única coisa que ainda respondia, devolvia `pix: null`. A
 * pessoa fica olhando um "preparando" que nunca termina, com a cobrança já
 * criada no gateway e o clique do anúncio já pago.
 *
 * O CÓDIGO JÁ ESTAVA GRAVADO — `pixCopiaECola` existe desde o lembrete de PIX
 * em aberto. Era só devolvê-lo.
 *
 * O VENCIMENTO É RECALCULADO a partir de `criadoEm`, porque o que a tela precisa
 * é quanto FALTA, e não quanto durava. Passado o prazo, não se inventa validade
 * nenhuma: sem `expiresAt` a tela mostra o código sem relógio, o que é melhor
 * que um contador negativo — e o PIX costuma ser aceito depois do prazo.
 */
const VALIDADE_DO_PIX_EM_SEGUNDOS = 1200;
function codigoPixGuardado(venda: Venda | null | undefined): { pixCode?: string; expiraEmSegundos?: number } {
  const codigo = venda?.pixCopiaECola?.trim();
  if (!codigo) return {};
  const nasceu = Date.parse(venda?.criadoEm ?? '');
  const faltam = Number.isFinite(nasceu)
    ? Math.floor((nasceu + (venda?.pixValidadeS ?? VALIDADE_DO_PIX_EM_SEGUNDOS) * 1000 - Date.now()) / 1000)
    : 0;
  return faltam > 0 ? { pixCode: codigo, expiraEmSegundos: faltam } : { pixCode: codigo };
}

async function consultarAcesso(res: ServerResponse, id: string): Promise<void> {
  /*
   * MESMA REGRA DA TELA DO QR: nenhuma ida ao gateway. Esta é a rota que libera
   * o produto, então ela chega junto com a euforia do pagamento e costuma ser
   * recarregada várias vezes seguidas — exatamente o padrão que a AvenPay
   * chama de polling e pune com bloqueio de IP.
   */
  const venda = await lerVenda(id);
  if (!venda) return erro(res, 404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');

  if (venda.status !== 'completed') {
    return json(res, 402, {
      success: false,
      error: 'PAYMENT_REQUIRED',
      message: 'O pagamento ainda não foi confirmado.',
      data: { status: venda.status },
    });
  }
  return await entregarAcesso(res, venda);
}

/**
 * UM CÓDIGO NOVO PARA O MESMO PEDIDO.
 *
 * O PIX morre em 20 minutos, e quem compra pelo WhatsApp lê a
 * mensagem quando pode. Em 08/09/2026 Mara Luzia abriu o lembrete 54 minutos
 * depois: o banco recusou, e para ela o site é que estava quebrado. Ela avisou.
 * Quem não avisa, some — e some achando que quase caiu num golpe.
 *
 * A cobrança não se "renova" no gateway: o `id` do pedido É o id do pagamento
 * na AvenPay, então um código novo é uma cobrança nova, com id novo. O que dá
 * para preservar é o resto, e é o que importa:
 *
 *   O CARIMBO DO ANÚNCIO (`attrib`) VIAJA JUNTO. Sem isso a venda renovada
 *   nasceria órfã, e o criativo que a trouxe levaria zero — o painel inteiro se
 *   apoia nesse campo, e ele só é capturado uma vez, no site.
 *
 *   E O PEDIDO VELHO É APAGADO. Sem isso a mesma pessoa vira dois "PIX gerado"
 *   no painel: a conta de conversão despenca sozinha e o robô teria duas filas
 *   de lembrete para a mesma senhora. Só o que está `pending` é apagado, e só
 *   DEPOIS de o novo nascer — se o gateway recusar, nada se perde.
 *
 * `ua` e `ip` são os desta requisição de propósito: quem está clicando agora é
 * ELA, então são os dados certos para o `Purchase` do Meta. Os do pedido antigo
 * são de horas atrás.
 */
async function renovarPedido(
  res: ServerResponse,
  id: string,
  quemChamou: { ua?: string; ip?: string } = {},
): Promise<void> {
  const antiga = await lerVenda(id);
  if (!antiga) {
    return erro(res, 404, 'ORDER_NOT_FOUND', 'Não encontrei este pedido. Chame no WhatsApp que a gente resolve.');
  }
  if (antiga.status === 'completed') {
    /* Ela já pagou e não sabe. Dizer isso é melhor do que cobrar de novo. */
    return json(res, 200, { success: true, data: { jaPago: true } });
  }

  /*
   * O ESPELHO EXISTE PARA NÃO DUPLICAR NENHUMA TRAVA.
   *
   * `criarPedido` carrega o catálogo de preços, a filtragem de bumps forjados,
   * o CPF do pagador, o tratamento de 429 e a gravação com índice. Reescrever
   * qualquer pedaço disso aqui seria criar um segundo caminho de cobrança que
   * envelhece separado — e o primeiro que ficasse para trás cobraria errado.
   * Então ela é chamada de verdade, e este objeto só guarda o que ela responde.
   */
  const capturado: { status: number; corpo: any } = { status: 0, corpo: null };
  const espelho = {
    statusCode: 0,
    setHeader() {},
    end(texto: string) {
      capturado.status = (espelho as { statusCode: number }).statusCode;
      try {
        capturado.corpo = JSON.parse(String(texto));
      } catch {
        capturado.corpo = null;
      }
    },
  } as unknown as ServerResponse;

  const itens = Array.isArray(antiga.itens) && antiga.itens.length ? antiga.itens : ['main'];
  const attrib = (antiga.attrib ?? {}) as Record<string, string>;

  await criarPedido(
    espelho,
    {
      /* Quem tinha o PIX de R$ 27 da oferta de saída continua com ele. */
      offer: itens.includes('main_volta') ? 'main_volta' : 'main',
      /* `criarPedido` já descarta id desconhecido e a própria oferta principal. */
      bumps: itens.filter((i) => i !== 'main' && i !== 'main_volta'),
      customer: { name: antiga.nome, email: antiga.email, phone: antiga.telefone },
      attrib,
      /* O que o gateway guarda e devolve no webhook. Só o que existe no
         antigo. O `ttclid` e as UTMs entram porque são eles que casam a
         venda renovada com o anúncio que a trouxe. */
      tracking: {
        ...(attrib.fbc ? { fbc: attrib.fbc } : {}),
        ...(attrib.fbp ? { fbp: attrib.fbp } : {}),
        ...(attrib.fbclid ? { fbclid: attrib.fbclid } : {}),
        ...(attrib.ttclid ? { ttclid: attrib.ttclid } : {}),
        ...(attrib.origem ? { utm_source: attrib.origem } : {}),
        ...(attrib.campanha ? { utm_campaign: attrib.campanha } : {}),
        ...(attrib.conjunto ? { utm_medium: attrib.conjunto } : {}),
        ...(attrib.criativo ? { utm_content: attrib.criativo } : {}),
      },
    },
    quemChamou,
  );

  const novo = capturado.corpo?.data?.id;
  if (!capturado.corpo?.success || !novo) {
    /* Repassa o erro que `criarPedido` já escreveu na língua de quem compra. */
    return json(res, capturado.status || 502, capturado.corpo ?? {
      success: false,
      error: 'GATEWAY_ERROR',
      message: 'Não consegui gerar o código agora. Nada foi cobrado — tente de novo em instantes.',
    });
  }

  /*
   * O CARIMBO DO LEMBRETE TAMBÉM VIAJA — senão a mesma senhora recebe duas
   * vezes (erro visto em 12/10/2026).
   *
   * O pedido velho é APAGADO logo abaixo, e com ele ia embora a única prova de
   * que o lembrete dela já saiu. O novo nascia limpo, com `status: pending` e
   * sem `whatsappLembreteEm` — exatamente a condição que `tarefaDaVenda`
   * procura — e 4 minutos depois o robô mandava o segundo lembrete.
   *
   * O caminho até aqui é quase sempre O PRÓPRIO LEMBRETE: a pessoa abre a
   * mensagem, o PIX de 20 minutos já morreu, ela clica para gerar outro. Quem
   * renova é quem já foi avisada. Então o normal era duplicar, não a exceção.
   */
  if (antiga.whatsappLembreteEm) {
    await atualizarVenda(novo, { whatsappLembreteEm: antiga.whatsappLembreteEm });
  }

  /*
   * Relê antes de apagar: entre a leitura lá em cima e agora passaram alguns
   * segundos, e o webhook da ZuckPay pode ter marcado o antigo como pago nesse
   * intervalo. Apagar um pedido pago é apagar o registro de que dinheiro entrou.
   */
  const conferida = await lerVenda(id);
  if (conferida && conferida.status === 'pending' && !conferida.metaEnviadoEm) {
    await apagarVenda(id);
  }

  return json(res, 201, capturado.corpo);
}

/**
 * A RESPOSTA QUE LIBERA O PRODUTO, a partir do registro gravado.
 *
 * Existe separada porque agora há dois caminhos até aqui: o da ZuckPay, que
 * ainda confere com o gateway, e o da AvenPay, que lê só o nosso registro
 * (ela proíbe consulta). A montagem dos links é a mesma nos dois, e duplicá-la
 * seria duplicar o defeito de "pagou e não recebeu" no dia em que um dos lados
 * mudasse.
 */
async function entregarAcesso(res: ServerResponse, venda: Venda): Promise<void> {
  return montarEntrega(res, venda.id, venda.itens ?? []);
}

function montarEntrega(res: ServerResponse, id: string, ids: string[]): void {
  json(res, 200, {
    success: true,
    data: {
      released: true,
      orderId: id,
      contents: (ids.length ? ids : ['main']).map((itemId) => ({
        itemId,
        title: CATALOGO[itemId]?.titulo ?? itemId,
        description: DESCRICOES[itemId] ?? '',
        /*
         * Vazio aqui é "cliente pagou e não recebeu" — o pior defeito que este
         * sistema pode ter, e ele começa em silêncio, com uma variável de
         * ambiente esquecida antes do produto entrar no ar.
         */
        url: SERVICOS.has(itemDeEntrega(itemId)) ? null : linkDeEntrega(itemId) || null,
      })),
      pendingOrders: [],
    },
  });
}

/* -------------------------------------------------------------------------- */
/* O handler                                                                   */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* WhatsApp — o número e o texto                                              */
/* -------------------------------------------------------------------------- */

/**
 * O TELEFONE NO FORMATO QUE O WHATSAPP ENTENDE, ou `null` se não der.
 *
 * O formulário aceita o que a pessoa digitar: "(11) 91234-5678", "11912345678",
 * "+55 11 91234-5678". O WhatsApp quer só dígitos com o código do país.
 *
 * `null` NÃO é erro — é "não dá para mandar". Quem digitou o telefone errado
 * não pode virar mensagem para o número de outra pessoa: número de 10 ou 11
 * dígitos vira brasileiro; qualquer outro tamanho é recusado aqui em vez de
 * ser "consertado" no chute.
 */
export function paraWhatsApp(bruto: string): string | null {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  /* Já veio com o 55 na frente: 55 + DDD (2) + número (8 ou 9). */
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) return digitos;
  return null;
}

/**
 * O TEXTO DA ENTREGA.
 *
 * Mora aqui, e não no robô, por dois motivos: o catálogo dos títulos está
 * aqui, e assim a bateria de `scripts/testar-api-zuckpay.mjs` consegue conferir
 * o texto sem abrir navegador nenhum.
 *
 * SEM EMOJI DE PROPAGANDA e sem link encurtado: mensagem que parece disparo de
 * marketing é o que faz o número ser denunciado. Esta é a entrega de uma compra
 * que a pessoa acabou de fazer, e o texto tem de parecer isso.
 */
/**
 * O TEXTO DO LEMBRETE DE PIX EM ABERTO.
 *
 * Ele carrega o codigo, e essa e a decisao que faz a diferenca: sem o
 * copia-e-cola, o lembrete pede que a pessoa VOLTE ao site, ache o pedido e
 * gere tudo de novo -- tres passos a mais entre ela e o pagamento, num momento
 * em que ela ja estava saindo.
 *
 * O QUE ELE NAO FAZ, DE PROPOSITO:
 *
 *   - nao inventa urgencia falsa ("ultimas vagas"). O prazo do PIX e real e ja
 *     e urgencia suficiente; mentir sobre isso e o que faz a pessoa denunciar;
 *   - nao pede NENHUM dado. Mensagem com codigo de pagamento pedindo confirmar
 *     senha, CPF ou clicar em link e o formato exato do golpe -- e quem recebe
 *     denuncia o numero, com razao;
 *   - nao manda link. Codigo copiavel e mais direto e nao parece phishing;
 *   - diz para ignorar se ja pagou. A confirmacao pode estar em transito, e
 *     acusar de "nao pagou" quem acabou de pagar e o pior jeito de comecar.
 *
 * O codigo vai numa LINHA SOZINHA: no WhatsApp, "manter pressionado > copiar"
 * pega a linha inteira. Codigo no meio do paragrafo e copiado pela metade.
 */
/**
 * O QUE FAZER COM ESTA VENDA: entregar, lembrar, ou nada.
 *
 * ESTA FUNCAO E PURA E EXPORTADA DE PROPOSITO. A decisao que ela toma e a mais
 * perigosa do sistema inteiro -- errar aqui e mandar mensagem para quem nao
 * devia, e no WhatsApp isso nao se desfaz: vira denuncia, e o numero
 * denunciado e o mesmo que entrega o produto de quem PAGOU.
 *
 * Dentro da rota ela dependeria da memoria e do relogio, e nao daria para
 * testar. Fora, `scripts/testar-api-zuckpay.mjs` cobre cada limite com o tempo
 * na mao.
 *
 * OS TRES LIMITES, E O QUE CADA UM IMPEDE:
 *
 *   entrega, 7 dias   No dia em que o robo for ligado, TODA venda antiga
 *                     estaria na fila. Cada pessoa que comprou semanas atras
 *                     receberia uma mensagem do nada.
 *
 *   lembrete, piso    DOIS minutos desde 13/10/2026, a pedido do dono: antes
 *                     eram quatro, e com a ronda do robo de 30 s o lembrete
 *                     chegava perto dos 4min30 -- tempo de a pessoa fechar o
 *                     app do banco e ir fazer outra coisa. Abaixo de dois ela
 *                     ainda esta com o teclado aberto digitando, e a mensagem
 *                     atrapalha em vez de ajudar; o minimo aceito e 1.
 *
 *   lembrete, teto    O PIX da ZuckPay expira em 20 minutos. Lembrete depois
 *                     disso carrega um codigo MORTO: a pessoa tenta pagar, o
 *                     banco recusa, e recuperacao de venda vira desconfianca.
 *                     O teto tambem e o que impede o disparo do primeiro dia.
 */
/**
 * A FALHA FOI NOSSA OU DELA?
 *
 * "Não consegui falar com o OpenWA" e "este número não tem WhatsApp" chegam
 * aqui pelo mesmo caminho, como texto, e são coisas opostas. A segunda é
 * definitiva — insistir só repete o erro. A primeira é temporária, e desistir
 * dela é abandonar um cliente que pagou por causa de um contêiner parado.
 *
 * A LISTA É DE PADRÕES DE REDE, e não de mensagens específicas do OpenWA: o
 * `fetch` do Node diz `fetch failed` para tudo, e a causa real vem no `cause`,
 * que não atravessa o JSON até aqui. Errar para o lado de "é infraestrutura"
 * é o lado certo de errar: no máximo se tenta de novo daqui a 5 minutos.
 *
 * EXPORTADA PARA TER TESTE. A decisão que ela toma decide se um cliente que
 * pagou recebe o produto ou não.
 */
export function falhaDeInfraestrutura(texto: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|socket hang up|network|timeout|timed out|aborted|502|503|504|Bad Gateway|Service Unavailable|Gateway Time/i.test(
    String(texto ?? ''),
  );
}

export function tarefaDaVenda(
  v: Venda,
  agora: number,
  pisoMinutos = 2,
): 'entrega' | 'lembrete' | 'boleto' | null {
  if (!paraWhatsApp(v.telefone)) return null;
  /*
   * SEM NOME DE GENTE, O ROBÔ NÃO FALA (13/10/2026, decisão do dono).
   *
   * Toda mensagem automática deste sistema abre chamando a pessoa pelo nome —
   * é o que faz ela ver que existe um cadastro dela do outro lado. Quando o
   * campo não traz um nome, a mesma frase vira a prova de que é máquina: o
   * pedido BOL-8CB576 tinha o pedido de oração inteiro escrito ali, e a
   * saudação sairia como "Eu amanhã, que o Arcanjo Miguel abençoe...".
   *
   * CALAR É A DECISÃO CERTA, E NÃO UM DESISTIR. Quem escreve um recado no
   * campo do nome está FALANDO com a gente, com palavras próprias — essa
   * pessoa merece resposta de gente, e é o que o dono mandou fazer. No CRM ela
   * aparece em "Sem resposta", que é exatamente a fila do atendente.
   *
   * A ENTREGA PASSA POR CIMA DISSO. Quem pagou recebe o produto, com nome
   * estranho ou sem nome nenhum: segurar a entrega por causa da aparência de
   * um campo de texto é "pagou e não recebeu", o pior defeito que este sistema
   * pode ter. A saudação do lembrete é marketing; a entrega é obrigação.
   */
  const temNomeUsavel = pareceNome(v.nome);
  /*
   * Numero errado ou sem WhatsApp falha SEMPRE. Sem teto, o pedido voltaria a
   * cada 30 s para sempre, e o robo passaria o dia repetindo o mesmo erro.
   *
   * O TETO SO VALE PARA FALHA DE ENTREGA, e e o ultimo erro que decide. Se a
   * ultima resposta foi de infraestrutura -- OpenWA fora do ar, rede caida --
   * o WhatsApp nem chegou a ser consultado, e aquelas tentativas nao dizem
   * nada sobre o numero da pessoa: dizem que a NOSSA maquina estava desligada.
   *
   * ISTO TAMBEM RESSUSCITA O QUE JA MORREU, e essa e metade do motivo de ser
   * assim. A venda de R$ 88 de 08/09/2026 esta gravada com `tentativas: 3` e
   * `erro: "fetch failed"`; sem esta linha, corrigir o desenho nao entregaria
   * o produto dela -- o conserto valeria so para as proximas, e a cliente que
   * ja pagou continuaria esperando para sempre.
   *
   * O custo de errar aqui e o pedido voltar a cada 5 minutos (o adiamento
   * abaixo) ate o servico voltar. O custo de nao ter e um cliente que pagou e
   * nunca recebe.
   */
  const ultimaFalhaFoiNossa = falhaDeInfraestrutura(v.whatsappErro ?? '');
  if (!ultimaFalhaFoiNossa && (v.whatsappTentativas ?? 0) >= 3) return null;

  /*
   * ESPERA ENTRE TENTATIVAS, e sem ela o teto de 3 nao vale nada: o robo bate
   * de 20 em 20 s, entao as tres tentativas aconteceriam em UM MINUTO, todas
   * contra a mesma condicao. Foi assim que a venda de R$ 88 de 08/09 morreu --
   * o Docker estava parado, e o pedido gastou as tres chances em minutos
   * contra um servico que voltaria depois.
   */
  if (v.whatsappAdiadoAte) {
    const ate = Date.parse(v.whatsappAdiadoAte);
    if (Number.isFinite(ate) && agora < ate) return null;
  }

  if (v.status === 'completed' && !v.whatsappEnviadoEm) {
    const pagoEm = v.pagoEm ? Date.parse(v.pagoEm) : Number.NaN;
    if (Number.isFinite(pagoEm) && agora - pagoEm <= 7 * 24 * 60 * 60 * 1000) return 'entrega';
    return null;
  }

  if (temNomeUsavel && v.status === 'pending' && !v.whatsappLembreteEm && v.pixCopiaECola) {
    const criadoEm = Date.parse(v.criadoEm);
    if (!Number.isFinite(criadoEm)) return null;
    const idade = agora - criadoEm;
    const piso = Math.min(Math.max(pisoMinutos, 1), 15) * 60 * 1000;
    const teto = 15 * 60 * 1000;
    if (idade >= piso && idade <= teto) return 'lembrete';
  }

  /*
   * O PRIMEIRO ATENDIMENTO DE QUEM ESCOLHEU BOLETO (13/10/2026).
   *
   * A JANELA É LARGA, E É O CONTRÁRIO DO LEMBRETE. O lembrete corre contra um
   * código que morre em 20 minutos; aqui não há nada vencendo — o boleto ainda
   * não existe, quem o emite é o dono, à mão. Então o teto é de UM DIA: se o
   * robô ou o OpenWA passarem a tarde fora do ar, a pessoa continua merecendo
   * resposta quando eles voltarem. Com o teto de 15 minutos do lembrete, ela
   * ficaria sem atendimento nenhum e sem ninguém saber.
   *
   * O PISO É UM MINUTO, FIXO. Ela chega ao WhatsApp com a mensagem já digitada
   * pelo site e aperta enviar; responder no mesmo segundo é a coisa mais
   * robótica que existe, e esperar os dois minutos do lembrete é demais para
   * quem está com o aplicativo aberto na mão, olhando a conversa.
   */
  if (temNomeUsavel && v.status === 'pending' && v.pagamento === 'boleto' && !v.whatsappBoletoEm) {
    const criadoEm = Date.parse(v.criadoEm);
    if (!Number.isFinite(criadoEm)) return null;
    const idade = agora - criadoEm;
    if (idade >= 60 * 1000 && idade <= 24 * 60 * 60 * 1000) return 'boleto';
  }

  return null;
}

/**
 * UM LEMBRETE POR PESSOA, E NÃO POR PEDIDO (12/10/2026).
 *
 * ---------------------------------------------------------------------------
 * O DEFEITO QUE ISTO CONSERTA
 * ---------------------------------------------------------------------------
 * `tarefaDaVenda` é pura e vê UM pedido: a trava dela (`whatsappLembreteEm`)
 * só sabe se AQUELE pedido já foi avisado. Mas a mesma senhora gera PIX duas,
 * três vezes — volta ao site, preenche de novo, gera outro código — e cada
 * tentativa é um pedido NOVO, com id novo e carimbo em branco. Pela regra de
 * pedido, os dois mereciam lembrete. Para ela, era o robô repetindo a mesma
 * mensagem. Foi o dono que viu, olhando a conversa.
 *
 * ---------------------------------------------------------------------------
 * A TRAVA É O TELEFONE
 * ---------------------------------------------------------------------------
 * É o que a pessoa tem de único aqui — e tem de ser o NORMALIZADO por
 * `paraWhatsApp`, senão "81 93147309" e "5581931473090" passam por duas
 * pessoas diferentes, que é o mesmo defeito com outra cara.
 *
 * A JANELA DE UM DIA separa "ela está tentando agora" de "ela voltou outro
 * dia". Dentro do dia insistir não ajuda: ela já leu, e o segundo lembrete só
 * prova que é máquina falando. Perder um lembrete custa um empurrão; mandar
 * duplicado custa a confiança dela na mensagem — então o padrão erra para o
 * lado de mandar de menos.
 *
 * ENTREGA NÃO ENTRA NA TRAVA. Quem pagou dois pedidos tem direito aos dois
 * produtos, e segurar o segundo seria "pagou e não recebeu" — o pior defeito
 * que este sistema pode ter. A trava de entrega continua sendo por pedido.
 *
 * ---------------------------------------------------------------------------
 * A ORDEM DA LISTA IMPORTA
 * ---------------------------------------------------------------------------
 * Quando dois pedidos da mesma pessoa caem na janela de 4 a 15 minutos ao
 * mesmo tempo, o PRIMEIRO da lista é o que vai. `listarVendas` devolve do mais
 * novo para o mais velho, e é o certo: o PIX mais novo é o que ainda está vivo
 * — o de 20 minutos atrás já expirou, e mandar o código morto é pior do que
 * não mandar nada.
 *
 * EXPORTADA PARA TER TESTE, como a `tarefaDaVenda`: a decisão que ela toma
 * decide se a pessoa recebe uma mensagem ou duas.
 */
export function tarefasDaFila(
  vendas: Venda[],
  agora: number,
  pisoMinutos = 2,
  janelaHoras = 24,
): { venda: Venda; tarefa: 'entrega' | 'lembrete' | 'boleto'; telefone: string }[] {
  const janela = Math.max(janelaHoras, 0) * 60 * 60 * 1000;

  /* Quando cada telefone foi avisado pela última vez, pela base inteira. */
  const avisadoEm = new Map<string, number>();
  for (const v of vendas) {
    if (!v.whatsappLembreteEm) continue;
    const t = paraWhatsApp(v.telefone);
    if (!t) continue;
    const quando = Date.parse(v.whatsappLembreteEm);
    if (!Number.isFinite(quando)) continue;
    if (quando > (avisadoEm.get(t) ?? 0)) avisadoEm.set(t, quando);
  }

  const tarefas: { venda: Venda; tarefa: 'entrega' | 'lembrete' | 'boleto'; telefone: string }[] = [];
  for (const venda of vendas) {
    const tarefa = tarefaDaVenda(venda, agora, pisoMinutos);
    if (!tarefa) continue;
    const telefone = paraWhatsApp(venda.telefone);
    if (!telefone) continue;

    if (tarefa === 'lembrete') {
      const ultimo = avisadoEm.get(telefone);
      if (ultimo !== undefined && agora - ultimo < janela) continue;
      /*
       * RESERVA O TELEFONE JÁ, antes de o robô mandar — senão os dois pedidos
       * saem no MESMO lote e a trava gravada chega tarde.
       *
       * A reserva vive só nesta chamada. Se o envio falhar, nada é gravado, e
       * na volta de 30 s o outro pedido pode tentar — o que é o certo: a
       * pessoa continua sem ter recebido nada.
       */
      avisadoEm.set(telefone, agora);
    }

    tarefas.push({ venda, tarefa, telefone });
  }
  return tarefas;
}

/**
 * SENHOR, SENHORA OU VOCÊ — e por que isso não é detalhe.
 *
 * MEDIDO em 08/09/2026 na própria base: de 27 pedidos, 14 são de mulheres
 * (Maria aparece cinco vezes, mais Fátima, Cenira, Carminha, Regina). Uma
 * mensagem fixa em "o senhor" trata METADE das compradoras no masculino —
 * numa copy que fala de fé, de casa e de filhos, e para um público de 45+ onde
 * o tratamento é justamente o sinal de respeito.
 *
 * NA DÚVIDA, NEUTRO. Errar o gênero é pior que não usar nenhum: "você" é
 * apenas mais frio, "o senhor" para uma senhora é desatenção na cara. Por isso
 * só afirma quando o nome é claro, e cai em "você" quando não é.
 *
 * O pedido NÃO traz sexo — o formulário pede três campos e nenhum deles é
 * esse, de propósito. Sobra o primeiro nome, que em português carrega o sinal
 * na terminação. As duas listas existem porque a regra do "-a" tem exceções
 * conhecidas nos dois sentidos.
 */
const MASCULINOS_TERMINADOS_EM_A = new Set([
  'luca', 'juca', 'zeca', 'kaua', 'kauã', 'noa', 'nicola', 'josua', 'jonaida', 'agripa',
]);
const FEMININOS_SEM_A_NO_FIM = new Set([
  'lourdes', 'ines', 'inês', 'mercedes', 'raquel', 'isabel', 'ester', 'esther', 'judite',
  'edite', 'dulce', 'alice', 'rute', 'ruth', 'beatriz', 'doris', 'iris', 'íris', 'lilian',
  'marlene', 'irene', 'nadir', 'noemi', 'noemí', 'jaqueline', 'evelin', 'carmem', 'miriam',
  /*
   * ACRESCENTADOS EM 13/10/2026, e os dois primeiros grupos são defeitos de
   * tipo diferente.
   *
   * TERMINADOS EM -E caíam no NEUTRO: "você" para uma senhora de 60 anos é só
   * frio, mas é uma oportunidade perdida de acertar o respeito. `Ivone` é da
   * base real — ela recebeu lembrete e pagou em 12/10/2026.
   *
   * TERMINADOS EM -O E -ÃO eram tratados como SENHOR, que é o erro grave:
   * `Conceição` e `Socorro` são nomes marianos, dos mais comuns entre as
   * compradoras deste funil, e a regra do "-o" os mandava para o masculino com
   * confiança. "O senhor Maria da Conceição" numa mensagem que fala de fé e de
   * casa é desatenção na cara de quem está comprando.
   */
  'ivone', 'ivonete', 'cleide', 'neide', 'nair', 'jucilene', 'iracilde',
  'conceicao', 'conceição', 'socorro', 'remedios', 'remédios',
]);

export function tratamentoDe(nome: string): 'senhor' | 'senhora' | 'neutro' {
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (!primeiro) return 'neutro';
  if (FEMININOS_SEM_A_NO_FIM.has(primeiro)) return 'senhora';
  if (MASCULINOS_TERMINADOS_EM_A.has(primeiro)) return 'senhor';
  if (/a$/.test(primeiro)) return 'senhora';
  if (/o$/.test(primeiro)) return 'senhor';
  /* Terminações que não decidem nada (Jose, Luiz, Nelson, Windsor, Adriane):
   * neutro, porque um chute aqui acerta pouco mais que a moeda. */
  return 'neutro';
}

/**
 * TIRA DO CAMPO DO NOME O QUE NÃO É NOME.
 *
 * ---------------------------------------------------------------------------
 * O CASO QUE CRIOU ESTA FUNÇÃO (13/10/2026, MPV-975AE85059A6F0AA7B, R$ 74)
 * ---------------------------------------------------------------------------
 * Ela escreveu: "Maria Rejane de Souza Magalhães.  998222" — o nome certo, e
 * depois um pedaço do próprio telefone, provavelmente porque o teclado do
 * celular continuou no campo errado.
 *
 * A primeira versão de `pareceNome` reprovava QUALQUER dígito, e com isso o
 * robô se recusou a falar com uma cliente legítima: o lembrete dela não saiu,
 * e os 15 minutos do PIX venceram enquanto o dono perguntava por quê. A régua
 * estava certa na intenção e grossa demais na prática.
 *
 * ---------------------------------------------------------------------------
 * LIMPAR É MELHOR QUE RECUSAR
 * ---------------------------------------------------------------------------
 * Dentro de "Maria Rejane de Souza Magalhães.  998222" existe um nome perfeito.
 * Jogar a venda fora por causa do lixo colado no fim é pior do que qualquer
 * mensagem imperfeita — e a limpeza devolve exatamente o que a pessoa quis
 * escrever.
 *
 * O QUE ISTO NÃO SALVA, E NÃO DEVE SALVAR: o recado inteiro no campo do nome
 * (o BOL-8CB576, com o pedido de oração escrito ali). Ele não tem dígito
 * nenhum, sai daqui igual ao que entrou, e continua reprovado por `pareceNome`
 * no tamanho — que é o certo: ali a pessoa está FALANDO, e merece gente.
 */
export function limparNome(bruto: string): string {
  return String(bruto ?? '')
    /* Os dígitos e o que vier grudado neles: "Magalhães.  998222" e
       "Maria (11) 98765" perdem o número e ficam com o nome. */
    .replace(/[0-9]+/g, ' ')
    /* Pontuação órfã que sobra depois do número ou da abreviação: o ponto final
       de "Magalhães." viraria "Magalhães ." na saudação. Hífen e apóstrofo
       FICAM -- "Sant'Ana" e "Maria-Clara" são nomes de verdade. */
    .replace(/[.,;:()[\]{}/\\|_*+=<>"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    /*
     * E O HÍFEN OU APÓSTROFO QUE FICOU SOZINHO. Eles sobrevivem à linha de cima
     * de propósito — "Sant'Ana" e "Maria-Clara" são nomes de verdade — mas
     * "Maria (11) 98765-4321" vira "Maria -" se ninguém varrer o que restou.
     * A régua: pedaço sem nenhuma letra não é pedaço de nome.
     */
    .split(' ')
    .filter((pedaco) => /[a-zà-ÿ]/i.test(pedaco))
    .join(' ');
}

/**
 * ISSO AQUI É UM NOME, OU A PESSOA ESCREVEU UM RECADO NO CAMPO ERRADO?
 *
 * ---------------------------------------------------------------------------
 * O CASO QUE CRIOU ESTA FUNÇÃO (13/10/2026, pedido BOL-8CB576, R$ 74)
 * ---------------------------------------------------------------------------
 * Uma senhora preencheu o campo NOME do checkout com isto:
 *
 *   "Eu quero a oração toda do arcanjo Miguel que ele é o meu anjo meu anjo
 *    sagrado é Arcanjo Miguel quero a oração dele me fale como eu posso
 *    depositar esse dinheiro aí eu faço amanhã"
 *
 * Ela não errou: para ela aquele era o lugar de falar com a gente. E o robô
 * ia cumprimentá-la por `nomeESobrenome`, que devolve a PRIMEIRA e a ÚLTIMA
 * palavra — "Eu amanhã, que o Arcanjo Miguel abençoe sua família e sua casa".
 *
 * Uma mensagem assim não é só feia: ela PROVA que é máquina, para uma pessoa
 * que acabou de pedir ajuda com palavras próprias. O dono viu a conversa no
 * CRM e decidiu na hora: "quando o lead mandar uma mensagem assim, que o bot
 * não vai entender o que é que ela está dizendo, você não responde — deixa que
 * o atendente humano responde".
 *
 * ---------------------------------------------------------------------------
 * POR QUE AS REGRAS SÃO DE FORMA, E NÃO DE CONTEÚDO
 * ---------------------------------------------------------------------------
 * Tentar entender o que ela escreveu é o caminho errado: toda lista de
 * palavras-suspeitas erra para os dois lados, e o preço de errar aqui é
 * recusar-se a falar com uma cliente de nome comprido. Então a régua mede só
 * TAMANHO e CARACTERES — um recado tem dezenas de palavras, um nome não.
 *
 * OS LIMITES SÃO FOLGADOS DE PROPÓSITO. Nome brasileiro é longo: "Maria
 * Aparecida de Fátima dos Santos Silva Júnior" são oito palavras e 48
 * caracteres, e tem de passar. O caso real tinha 33 palavras e 178 caracteres
 * — a distância entre os dois é tão grande que não precisa de precisão.
 *
 * DÍGITO, @ E PONTO DE INTERROGAÇÃO reprovam direto: nome de gente não tem
 * nenhum dos três, e quem escreve telefone, e-mail ou pergunta no campo do
 * nome está fazendo a mesma coisa que a senhora do BOL-8CB576.
 */
export function pareceNome(bruto: string): boolean {
  /* JULGA O NOME JA LIMPO: o numero colado no fim nao e motivo para calar com
     uma cliente -- ver `limparNome` para o caso que ensinou isso. */
  const limpo = limparNome(bruto);
  if (limpo.length < 2) return false;
  if (limpo.length > 80) return false;
  if (limpo.split(/\s+/).length > 8) return false;
  if (/[@?!]/.test(limpo)) return false;
  /* Sem nenhuma letra não é nome -- "..." ou "---" chegam assim de vez em
     quando, de quem só quer passar da tela. */
  if (!/[a-zà-ÿ]/i.test(limpo)) return false;
  return true;
}

/**
 * NOME E SOBRENOME (11/10/2026, pedido do dono) — a mensagem abria só com o
 * primeiro nome, e "Maria" sozinho é o que qualquer disparo em massa escreve.
 * Com o sobrenome, a pessoa vê que existe um cadastro dela do outro lado.
 *
 * NÃO É O NOME INTEIRO: "Maria de Lourdes Alcântara, a paz de Deus" soa a
 * cartório, e o tom aqui é maternal. É o PRIMEIRO + o ÚLTIMO.
 *
 * As partículas são o detalhe que estraga se ignorado. Nomes brasileiros
 * carregam `de`, `da`, `do`, `dos`, `das` e `e` no meio, e às vezes no fim de
 * um sobrenome composto ("Lindaura Brás Silva do Carmo"). Pegar a última
 * palavra crua funciona; pegar a penúltima quando a última é partícula evita
 * "Fulana do". Nome de uma palavra só continua sendo uma palavra só.
 */
function nomeESobrenome(bruto: string): string {
  const PARTICULAS = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'di', 'du', 'del', "d'"]);
  const partes = String(bruto ?? '')
    .trim()
    .split(/\s+/)
    .filter((p) => p && !/^[.,;]+$/.test(p));
  if (!partes.length) return 'Olá';
  const primeiro = partes[0];
  /* Do fim para o começo, o primeiro pedaço que não seja partícula. */
  for (let i = partes.length - 1; i > 0; i--) {
    if (!PARTICULAS.has(partes[i].toLowerCase())) {
      return partes[i] === primeiro ? primeiro : `${primeiro} ${partes[i]}`;
    }
  }
  return primeiro;
}

export function mensagemDeLembrete(nome: string, valor: number, codigo: string): string {
  const primeiroNome = String(nome ?? '').trim().split(/\s+/)[0] || 'Olá';
  const nomeCompleto = nomeESobrenome(nome);
  const reais = `R$ ${valor.toFixed(2).replace('.', ',')}`;
  const t = tratamentoDe(nome);
  const sujeito = t === 'senhora' ? 'A senhora' : t === 'senhor' ? 'O senhor' : 'Você';
  const objeto = t === 'senhora' ? 'a senhora' : t === 'senhor' ? 'o senhor' : 'você';
  /*
   * TEXTO APROVADO PELO DONO EM 08/09/2026, e conferido no número de teste
   * antes de entrar aqui. NÃO REESCREVER SEM ELE MANDAR.
   *
   * O que mudou da versão anterior, e por quê:
   *
   *   "PDF"                -> "a oração completa e consagrada" + "o áudio
   *                           guiado". Quem compra tem 45+ e é devoto; "PDF"
   *                           e "arquivo" soam a produto de internet, não a
   *                           oração. Palavra proibida na conversa com o
   *                           cliente, por decisão do dono.
   *   "pagamento"          -> "contribuição". Mesma razão.
   *   "seu PIX está em     -> a abertura agora explica O QUE a pessoa recebe
   *    aberto"                antes de cobrar. A versão velha começava
   *                           cobrando, e cobrança sem contexto de um número
   *                           desconhecido é o que faz denunciar.
   *
   * O QUE NÃO MUDA, E NÃO PODE MUDAR: o código sai numa LINHA SOZINHA. No
   * WhatsApp, "manter pressionado > copiar" pega a linha inteira; código no
   * meio do parágrafo é copiado pela metade e o banco recusa. A bateria
   * `testar-api-zuckpay.mjs` reprova se isso quebrar.
   */
  return [
    /*
     * TOM MATERNAL (11/10/2026, pedido do dono) — a versão de 08/09 abria
     * repreendendo ("muita gente pede errado, pede com pressa, pede só quando
     * a casa já está um caos. Por isso nada anda"). Para um público de 50+ que
     * acabou de hesitar no pagamento, culpa não convence: acolhimento sim.
     * A linha virou "aconteceu, e eu guardei seu pedido aqui".
     *
     * Os emojis são poucos e no fim da frase, nunca no lugar de palavra: quem
     * lê com vista cansada precisa do texto legível, e emoji no meio da frase
     * quebra a leitura em voz alta que muita gente desse público faz.
     */
    /* A ABERTURA leva nome e sobrenome; o "Me diga, Maria" lá embaixo fica só
       com o primeiro. Repetir o nome inteiro duas vezes na mesma mensagem soa
       a formulário, e o meio do texto é onde o tom maternal mora. */
    `${nomeCompleto}, a paz de Deus na sua casa. 🙏🏻`,
    '',
    'Aqui é a Mensagem Celestial. 🕊️',
    '',
    `${sujeito} tem um anjo da guarda, e ele está só esperando ser chamado. Não é história de criança: é doutrina da Igreja. E tem São Miguel Arcanjo, príncipe da milícia celeste, aquele da oração "defendei-nos no combate". ✨`,
    '',
    `O que ${objeto} vai receber é o passo a passo pra INVOCAR o auxílio dos santos anjos na sua vida: a oração completa e consagrada, o jeito certo, o horário, e o ÁUDIO GUIADO pra rezar junto mesmo cansado, mesmo sem enxergar bem a letra. 🎧`,
    '',
    `Eu vi que ${objeto} chegou até o fim do pedido e ele ficou no meio do caminho. Acontece, e está tudo bem — eu guardei ${t === 'senhora' ? 'o da senhora' : t === 'senhor' ? 'o do senhor' : 'o seu'} aqui. ❤️`,
    '',
    `Sua contribuição é de ${reais}. 🙏🏻`,
    '',
    'PIX do seu pedido:',
    '',
    codigo,
    '',
    /*
     * A URGÊNCIA AQUI É VERDADEIRA, e por isso pode ser dita: o código morre
     * mesmo (o PIX vence em ~20 min, e por isso o teto da janela é 15). Nada
     * de relógio inventado nem "últimas vagas" — a regra da casa é que o que
     * a mensagem promete tem de ser verdade no código.
     */
    `⏰ Esse código vale por poucos minutos. Depois que vencer, ${objeto} precisa começar o pedido de novo.`,
    '',
    /*
     * A COMUNIDADE (11/10/2026, pedido do dono). Escrito como CONVITE, não
     * como promessa de prêmio: "entra na comunidade, onde fazemos sorteios"
     * em vez de "você concorre a X". Promoção comercial com distribuição de
     * prêmios é regulada no Brasil (autorização SECAP), e prometer odds a
     * quem paga é o que a regra alcança. O dono foi avisado disso.
     *
     * A comunidade AINDA NÃO EXISTE no WhatsApp — nem a API oficial nem o
     * OpenWA criam uma (medido em 11/10: `POST /groups` responde 501). O dono
     * cria no aplicativo. Enquanto não existir, esta linha é uma dívida: quem
     * pagar vai cobrar o convite.
     */
    '❤️ E quem contribui entra na nossa Comunidade da Mensagem Sagrada, onde rezamos juntos e fazemos sorteios entre os membros.',
    '',
    /*
     * A COPY APROVADA TEM UMA LINHA "Ou conclui aqui: <link>", E ELA NÃO ESTÁ
     * AQUI — de propósito, e a decisão precisa do dono para voltar.
     *
     * `scripts/testar-api-zuckpay.mjs` (12c) proíbe `http` nesta mensagem:
     * código de pagamento acompanhado de link é a forma EXATA do golpe que
     * circula por WhatsApp, e quem recebe denuncia. O número denunciado é o
     * mesmo que entrega o produto de quem pagou.
     *
     * E o link não resolveria nada hoje: `/pedido` é variante da página de
     * anúncio, então quem clica volta ao começo do funil e gera um PIX novo do
     * zero. Quando existir a página do pedido (`/p/<id>`), que mostra o código
     * vivo ou gera outro sem recomeçar, aí a linha vale a discussão de novo.
     */
    `Assim que confirmar sua contribuição, a oração completa e consagrada + o áudio guiado entram neste WhatsApp. ${sujeito} começa hoje. Santo Anjo do Senhor, meu zeloso guardador.`,
  ].join('\n');
}

/**
 * A TERCEIRA MENSAGEM: "SE JÁ PAGOU, DESCONSIDERE E ME MANDE O COMPROVANTE."
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELA SAIU DE DENTRO DO LEMBRETE (13/10/2026, pedido do dono)
 * ---------------------------------------------------------------------------
 * Esta frase existe desde 11/10, mas era a ÚLTIMA LINHA do texto — e o texto é
 * a mensagem que vem ANTES do QR. Então a ordem de leitura era:
 *
 *   1. o texto longo, terminando em "se já pagou, me mande o comprovante"
 *   2. o QR com o código
 *
 * Quem já tinha pagado lia o pedido do comprovante no meio de um parágrafo,
 * seis linhas acima do fim, e DEPOIS recebia um código de pagamento. A última
 * coisa na tela era uma cobrança — e para quem já pagou isso lê como "o
 * sistema não viu meu dinheiro". A reação a isso é desconfiança, não
 * comprovante.
 *
 * Agora ela é a terceira e última mensagem: quem já pagou lê "desconsidere"
 * por último, e quem não pagou tem o código como penúltima coisa, ainda à mão.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA NÃO DIZ
 * ---------------------------------------------------------------------------
 * NÃO PROMETE PRAZO, de propósito: quem responde vai ser atendido à mão, e
 * prometer "na hora" cria uma dívida que o dono talvez não consiga pagar num
 * domingo à noite.
 *
 * E NÃO LEVA LINK. Código de pagamento acompanhado de link é a forma exata do
 * golpe que circula por WhatsApp, e o número denunciado seria o mesmo que
 * entrega o produto de quem pagou.
 *
 * ---------------------------------------------------------------------------
 * POR QUE A REDE AINDA PRECISA EXISTIR
 * ---------------------------------------------------------------------------
 * O aviso do gateway se perde de vez em quando, e quando se perde a venda fica
 * `pending` para sempre. Em 08/09/2026 uma varredura achou R$ 168 pagos que
 * ninguém sabia. O comprovante é a única rede que não depende do webhook.
 */
export function mensagemDeComprovante(nome: string): string {
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] || 'Olá';
  const t = tratamentoDe(nome);
  const objeto = t === 'senhora' ? 'a senhora' : t === 'senhor' ? 'o senhor' : 'você';
  const posse = t === 'senhora' ? 'o da senhora' : t === 'senhor' ? 'o do senhor' : 'o seu';

  return [
    `${primeiro}, se ${objeto} JÁ fez a contribuição, desconsidere o código acima. 🙏🏻`,
    '',
    `Me mande o comprovante aqui que eu confiro no sistema e libero ${posse} acesso: a oração completa e consagrada, o áudio guiado e tudo o que ${objeto} pediu. ❤️`,
  ].join('\n');
}

/**
 * O PRIMEIRO ATENDIMENTO DE QUEM ESCOLHEU BOLETO — EM PEDAÇOS.
 *
 * ---------------------------------------------------------------------------
 * POR QUE É UMA LISTA, E NÃO UM TEXTO
 * ---------------------------------------------------------------------------
 * Pedido do dono em 13/10/2026: "não enviar a mensagem toda junta, enviar tipo
 * humanizada — um pedaço, depois outro, depois outro". Cada item desta lista é
 * UMA mensagem no WhatsApp, e o robô respira entre elas.
 *
 * Não é enfeite. Um bloco de oito linhas que cai de uma vez, com saudação,
 * explicação e pergunta dentro, é reconhecível como automático à distância — e
 * a pessoa do outro lado tem 50+ anos e lê devagar. Em pedaços, a pergunta do
 * fim chega quando ela já leu o começo, que é como gente conversa.
 *
 * ---------------------------------------------------------------------------
 * POR QUE A PERGUNTA É O MELHOR DIA
 * ---------------------------------------------------------------------------
 * O boleto NÃO é emitido por máquina aqui: a pessoa cai no WhatsApp com uma
 * mensagem pronta, e o dono emite na Kiwify à mão. O que falta para ele emitir
 * é a DATA — boleto emitido cedo demais vence antes de ela ter o dinheiro, e
 * boleto vencido é a venda perdida com o trabalho todo já feito.
 *
 * Quem fazia essa pergunta era o dono, à mão. Em 13/10/2026, 06:25, uma pessoa
 * escreveu pedindo boleto de R$ 88 e foi respondida em dois minutos com
 * exatamente isto — "qual seria o melhor dia pra você fazer sua contribuição?".
 * Esta função é aquela resposta, que agora não depende de alguém estar acordado.
 *
 * ---------------------------------------------------------------------------
 * CURTA, E ISSO FOI MEDIDO NA CONVERSA
 * ---------------------------------------------------------------------------
 * A primeira versão tinha quatro pedaços e explicava tudo: que o boleto sai no
 * nome e no CPF dela, que o dono cuidaria pessoalmente, e que a emissão sai um
 * dia antes da data escolhida. O dono cortou no mesmo dia: "eu quero uma
 * mensagem mais breve... bota o preço e pronto, não precisa falar mais nada".
 *
 * Ele está certo, e o motivo é a pergunta. Esta conversa existe para arrancar
 * UMA informação — a data. Cada frase a mais antes dela é uma chance de a
 * pessoa ler o conjunto, achar que é aviso automático e não responder nada. O
 * que ela precisa saber agora é só: quem está falando, quanto é, e o que
 * responder.
 *
 * O QUE SAIU DAQUI FOI PARA DEPOIS, não para o lixo. "Eu emito o boleto um dia
 * antes da data que você escolher" é a RESPOSTA à data que ela der — decisão do
 * dono: "ela vai dizer o melhor dia e tu vai falar que você vai gerar o boleto
 * quando tiver perto do dia". Dito antes da pergunta, era explicação; dito
 * depois, é confirmação. E essa parte ainda não existe: depende de o robô LER a
 * resposta dela, que ele não faz hoje.
 *
 * IRMÃ OU IRMÃO vem de `tratamentoDe`, a mesma régua do lembrete, e no NEUTRO
 * a palavra simplesmente não aparece: "irmão" para uma senhora é pior do que
 * não chamar de nada. Metade desta base é de mulheres — está medido.
 */
export function mensagensDoBoleto(nome: string, valor: number): string[] {
  const nomeCompleto = nomeESobrenome(nome);
  const t = tratamentoDe(nome);
  const objeto = t === 'senhora' ? 'a senhora' : t === 'senhor' ? 'o senhor' : 'você';
  /* "para A irmã" / "para O irmão" — o artigo vem junto, senão a frase sai
     torta no masculino. No neutro a palavra não aparece: ver o cabeçalho. */
  const quem = t === 'senhora' ? 'a irmã' : t === 'senhor' ? 'o irmão' : objeto;

  return [
    `${nomeCompleto}, que o Arcanjo Miguel abençoe sua família e sua casa. 🙏🏻`,

    `Vi que ${objeto} escolheu contribuir pelo BOLETO. Sua contribuição é de ${brl(valor)}.`,

    /*
     * A PERGUNTA VAI SOZINHA, no último pedaço. Pergunta no meio de um texto
     * com outras frases não é respondida: a pessoa lê o conjunto, acha que é
     * aviso e não responde nada.
     */
    `Me diga qual o melhor dia para ${quem} pagar o boleto. 🗓️`,
  ];
}

export function mensagemDeEntrega(nome: string, itens: { titulo: string; url: string | null }[]): string {
  const primeiroNome = String(nome ?? '').trim().split(/\s+/)[0] || 'Olá';
  const linhas = [`${primeiroNome}, aqui está o que você acabou de receber:`, ''];

  for (const item of itens) {
    linhas.push(`• ${item.titulo}`);
    if (item.url) linhas.push(`  ${item.url}`);
    else linhas.push('  (a confirmação vai por aqui mesmo)');
  }

  linhas.push('', 'Se precisar de qualquer coisa, é só responder esta mensagem.');
  return linhas.join('\n');
}

/**
 * O CORPO CRU, byte a byte como chegou.
 *
 * Existe para a assinatura da Kiwify: ela assina o TEXTO que mandou, e
 * `JSON.parse` seguido de `JSON.stringify` devolve outro texto (ordem de
 * chaves, espaços, escapes). Conferir HMAC em cima do reserializado reprova
 * webhook legítimo — e, pior, reprova sempre, então parece configuração errada.
 */
function lerCorpoCru(req: IncomingMessage): Promise<string> {
  return new Promise((resolver) => {
    let bruto = '';
    req.on('data', (pedaco) => {
      bruto += pedaco;
      if (bruto.length > 64_000) bruto = bruto.slice(0, 64_000);
    });
    req.on('end', () => resolver(bruto));
    req.on('error', () => resolver(''));
  });
}

function lerCorpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolver) => {
    let bruto = '';
    req.on('data', (pedaco) => {
      bruto += pedaco;
      /* Teto de tamanho: corpo grande em rota de pagamento é abuso, não pedido. */
      if (bruto.length > 64_000) bruto = bruto.slice(0, 64_000);
    });
    req.on('end', () => {
      try {
        resolver(bruto ? (JSON.parse(bruto) as Record<string, unknown>) : {});
      } catch {
        resolver({});
      }
    });
    req.on('error', () => resolver({}));
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  aplicarCors(req, res);

  /*
   * O PREFLIGHT vem ANTES de tudo, inclusive da checagem de credencial.
   *
   * O navegador manda um `OPTIONS` antes do POST para perguntar se pode. Se
   * essa pergunta receber 503 por falta de chave, o pedido de verdade nem é
   * tentado — e o erro que aparece na tela é "Failed to fetch", que não diz
   * nada a quem for investigar.
   */
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  /*
   * SEM CREDENCIAL, NADA DE COBRANÇA — e o erro é explícito.
   *
   * O caminho alternativo seria deixar a chamada seguir e falhar com 401 lá no
   * gateway, o que aparece na tela como "não foi possível gerar o PIX": a
   * pessoa acha que o site quebrou, e quem for investigar procura no lugar
   * errado. Recusar aqui aponta direto para a variável que falta.
   */
  const url = new URL(req.url ?? '/', 'http://local');
  const caminho = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const metodo = req.method ?? 'GET';

  /*
   * O PAINEL E OS AVISOS PASSAM MESMO SEM GATEWAY (30/09/2026).
   *
   * Com a SpyPag, a credencial pode morar no Redis e ser ligada PELO PAINEL —
   * barrar o painel aqui seria trancar a chave dentro do carro. E o aviso de
   * pagamento de um PIX criado antes de desligar tudo ainda tem de entrar:
   * dinheiro que chegou não espera o interruptor.
   */
  const passaSemGateway = caminho.startsWith('/admin/') || caminho.startsWith('/webhooks/');
  if (!passaSemGateway && !(await gatewayAtivo())) {
    return erro(
      res,
      503,
      'GATEWAY_NOT_CONFIGURED',
      'O pagamento está temporariamente indisponível. Nenhuma cobrança foi gerada.',
    );
  }

  try {
    if (metodo === 'POST' && caminho === '/orders') {
      return await criarPedido(res, await lerCorpo(req), {
        ua: String(req.headers['user-agent'] ?? '').slice(0, 400) || undefined,
        /*
         * `x-forwarded-for` traz a cadeia inteira ("cliente, proxy1, proxy2").
         * O PRIMEIRO e o da pessoa; os outros sao infraestrutura. Pegar o
         * ultimo mandaria o IP da Vercel ao Meta em toda venda.
         */
        ip: ipDe(req) || undefined,
      });
    }

    const acesso = caminho.match(/^\/orders\/([^/]+)\/access$/);
    if (metodo === 'GET' && acesso) return await consultarAcesso(res, decodeURIComponent(acesso[1]));

    const pedido = caminho.match(/^\/orders\/([^/]+)$/);
    if (metodo === 'GET' && pedido) return await consultarPedido(res, decodeURIComponent(pedido[1]));

    /*
     * ROTA ABERTA, e é o desenho. Quem tem o link é quem recebeu a mensagem, e
     * o id é aleatório de 32 caracteres — adivinhar um é impossível na prática.
     * Exigir senha aqui seria exigir cadastro de quem só quer terminar de
     * pagar, que é o passo onde se perde gente.
     *
     * O pior abuso possível é alguém gerar cobrança PARA SI MESMO num pedido
     * cujo link já tem. Não expõe dado, não move dinheiro para lugar nenhum, e
     * a pessoa dona do pedido continua podendo pagar.
     */
    const paraRenovar = caminho.match(/^\/orders\/([^/]+)\/renovar$/);
    if (metodo === 'POST' && paraRenovar) {
      return await renovarPedido(res, decodeURIComponent(paraRenovar[1]), {
        ua: String(req.headers['user-agent'] ?? '').slice(0, 400) || undefined,
        ip: ipDe(req) || undefined,
      });
    }

    /*
     * `/pagar/<id>` chega aqui SEM o prefixo `/api`, pela reescrita do
     * `vercel.json`. É link para pessoa ler no WhatsApp: `/api/` no meio de um
     * endereço mandado para quem tem 65 anos parece coisa de técnico, e link
     * estranho não é tocado.
     */
    const paraPagar = caminho.match(/^\/pagar\/([^/]+)$/);
    if (metodo === 'GET' && paraPagar) {
      const idDela = decodeURIComponent(paraPagar[1]);
      /* Id de pedido é 32 caracteres de [a-f0-9]. Qualquer outra coisa na URL
         não é pedido — é alguém testando o que a página faz com HTML. */
      if (!/^[\w.-]{1,64}$/.test(idDela)) return erro(res, 404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');
      const venda = await lerVenda(idDela);
      res.statusCode = venda ? 200 : 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      /* Nunca em cache: a página carrega o estado do pedido dentro dela, e uma
       * cópia velha diria "em aberto" para quem já pagou. */
      res.setHeader('Cache-Control', 'no-store');
      return void res.end(paginaDePagamento(idDela, venda));
    }

    /*
     * O WEBHOOK É ACEITO E DESCARTADO, de propósito.
     *
     * A ZuckPay reenvia o aviso de pagamento até receber 200; sem esta rota,
     * cada venda vira uma fila de reentregas falhando no painel deles. Mas sem
     * banco não há onde marcar "pago" — quem descobre a confirmação é a
     * consulta de status do navegador. Responder 200 e seguir é honesto: o
     * aviso chegou, e não havia o que fazer com ele.
     *
     * QUANDO HOUVER ONDE GRAVAR, é aqui que a confirmação passa a chegar
     * primeiro — e aí dá para reduzir o polling, ou eliminá-lo.
     */
    /*
     * A CONTAGEM DO FUNIL. Rota de escrita, aberta -- e de proposito.
     *
     * Quem chega na tela 1 nao tem sessao, nao tem conta e nao digitou nada:
     * exigir credencial aqui seria exigir credencial para existir. O que ela
     * aceita e minimo (uma etapa de uma lista fechada e um identificador
     * aleatorio), nao guarda dado de ninguem, e o pior abuso possivel e alguem
     * inflar um numero do RELATORIO DO DONO -- nao ha dinheiro nem dado do
     * outro lado.
     *
     * Responde 204 sempre, inclusive quando ignora: o navegador manda isto com
     * `keepalive` no meio da troca de tela, e resposta de erro ali so geraria
     * ruido no console de quem esta comprando.
     */
    /*
     * O LEAD DO FUNIL `/novo`. Pública, como `/eventos`, e com o mesmo teto
     * por IP: um script não enche a lista de contatos falsos. Responde 204
     * sempre — a tela não espera por isto, e não há o que dizer a quem chamou.
     */
    if (metodo === 'POST' && caminho === '/leads') {
      try {
        if (!(await passouDoLimite(`leads:${ipDe(req) || 'sem-ip'}`, 60, 3600))) {
          await gravarLead(await lerCorpo(req));
        }
      } catch {
        /* contato que não foi gravado não pode travar o funil */
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (metodo === 'POST' && caminho === '/eventos') {
      try {
        /* Rota aberta e barata de chamar. O teto é LARGO de propósito: desde
           16/09 cada sessão manda ~10 batidas (etapas do funil + o espelho dos
           eventos para a CAPI), e o tráfego do TikTok chega por operadora de
           celular — centenas de pessoas atrás de UM IP. 600/h descartaria evento
           de visitante real em hora de pico, em silêncio; 3000/h ainda barra um
           script e deixa ~300 sessões/hora passarem pelo mesmo IP. */
        if (await passouDoLimite(`eventos:${ipDe(req) || 'sem-ip'}`, 3000, 3600)) {
          res.statusCode = 204;
          res.end();
          return;
        }
        const corpoEvento = await lerCorpo(req);
        await marcarEtapa(String(corpoEvento.sessao ?? ''), String(corpoEvento.etapa ?? ''), corpoEvento.funil, corpoEvento.ad);
        /*
         * O ESPELHO DO PIXEL. Quando o corpo traz `evento` + `eventId`, o mesmo
         * evento que o navegador acabou de disparar sai também pela CAPI, com o
         * MESMO id — o Meta junta os dois e conta uma vez.
         *
         * `await` E NÃO "dispara e esquece": numa função serverless o processo
         * CONGELA assim que a resposta sai, e uma promessa solta morre no meio
         * do caminho — o evento simplesmente não chegaria ao Meta, sem erro
         * nenhum no log. Quem espera é o servidor, não o visitante: o navegador
         * manda isto com `keepalive` e segue a vida sem aguardar resposta.
         */
        if (corpoEvento.evento && corpoEvento.eventId) {
          /*
           * O MESMO EVENTO, O MESMO `eventId`, DUAS PLATAFORMAS — e cada uma
           * junta com o disparo do próprio pixel no navegador. Ver
           * `enviarEventoAoTikTok`: ele só manda quando a visita veio do TikTok,
           * e o `enviarEventoAoMeta` logo abaixo continua como estava.
           */
          await enviarEventoAoTikTok({
            nome: String(corpoEvento.evento),
            eventId: String(corpoEvento.eventId),
            params: (corpoEvento.params ?? {}) as Record<string, unknown>,
            attrib: (corpoEvento.attrib ?? {}) as Record<string, string>,
            url: corpoEvento.url ? String(corpoEvento.url).slice(0, 500) : undefined,
            email: corpoEvento.email ? String(corpoEvento.email).slice(0, 160) : undefined,
            telefone: corpoEvento.telefone ? String(corpoEvento.telefone).slice(0, 30) : undefined,
            ip: ipDe(req) || undefined,
            ua: String(req.headers['user-agent'] ?? '').slice(0, 400) || undefined,
          });
          await enviarEventoAoMeta({
            nome: String(corpoEvento.evento),
            eventId: String(corpoEvento.eventId),
            params: (corpoEvento.params ?? {}) as Record<string, unknown>,
            attrib: (corpoEvento.attrib ?? {}) as Record<string, string>,
            url: corpoEvento.url ? String(corpoEvento.url).slice(0, 500) : undefined,
            email: corpoEvento.email ? String(corpoEvento.email).slice(0, 160) : undefined,
            telefone: corpoEvento.telefone ? String(corpoEvento.telefone).slice(0, 30) : undefined,
            ip: ipDe(req) || undefined,
            ua: String(req.headers['user-agent'] ?? '').slice(0, 400) || undefined,
          });
        }
      } catch {
        /* contagem nunca atrapalha */
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    /*
     * ========================================================================
     * O WEBHOOK DA KIWIFY — POR ENQUANTO ELE SÓ ESCUTA
     * ========================================================================
     *
     * POR QUE ESTA ROTA NASCEU SURDA-MUDA (19/09/2026): o botão de cartão do
     * checkout manda para a Kiwify (`pay.kiwify.com.br`), e quem paga no cartão
     * HOJE NÃO EXISTE para este servidor — não entra no painel, não vira
     * `Purchase`, não conta no ROAS. O conserto é a Kiwify avisar aqui.
     *
     * MAS A KIWIFY NÃO PUBLICA O FORMATO DO PAYLOAD. A documentação dela manda
     * pedir ao suporte, e as duas páginas públicas não trazem nem os nomes dos
     * campos nem como a assinatura é calculada. Escrever `corpo.order_status`
     * no chute e sair disparando `Purchase` é como se inventa venda que não
     * existe — ou se perde venda que existe, calado.
     *
     * ENTÃO ESTA VERSÃO NÃO GRAVA NADA E NÃO MANDA NADA. Ela responde 200 (a
     * Kiwify reprova a URL que não responde) e ESCREVE NO LOG o desenho do que
     * chegou: os nomes dos campos, os tipos, e só os valores que não são de
     * pessoa. Com o resultado do botão "Testar Webhook" na mão, a versão que
     * grava é escrita em cima de fato, não de suposição.
     *
     * O QUE É REGISTRADO, DE PROPÓSITO, DE PESSOA: nada. Nome, e-mail, telefone
     * e documento viram só o nome do campo — o log da Vercel não é lugar de
     * dado de cliente, e a regra 3 do NOTAS.md vale aqui também.
     */
    if (caminho === '/webhooks/kiwify') {
      /* A Kiwify valida a URL antes de salvar, e nem sempre com POST. Mesmo
         motivo do webhook da ZuckPay: 404 aqui reprova a URL que está certa. */
      if (metodo !== 'POST') return json(res, 200, { success: true });

      const cru = await lerCorpoCru(req);

      /*
       * SEM O TOKEN, A ROTA VOLTA A SER SÓ OUVIDO. Não é degradação silenciosa:
       * a linha no log diz exatamente o que falta, e nada é gravado — melhor
       * perder a medição de uma venda de cartão do que aceitar venda forjada.
       */
      if (!KIWIFY_TOKEN) {
        console.warn('[kiwify] recebido sem KIWIFY_TOKEN configurado — nada foi gravado. Tamanho do corpo:', cru.length);
        return json(res, 200, { success: true });
      }

      const assinatura = String(url.searchParams.get('signature') ?? '');
      const esperada = createHmac('sha1', KIWIFY_TOKEN).update(cru).digest('hex');
      if (!segredoConfere(assinatura, esperada)) {
        console.error('[kiwify] ASSINATURA NAO CONFERE — chamada recusada.');
        return erro(res, 401, 'BAD_SIGNATURE', 'Assinatura inválida.');
      }

      let corpo: Record<string, unknown> = {};
      try {
        corpo = JSON.parse(cru) as Record<string, unknown>;
      } catch {
        return json(res, 200, { success: true });
      }

      /*
       * SÓ VENDA APROVADA VIRA VENDA AQUI. O mesmo endereço recebe
       * `pix_created`, `carrinho_abandonado` e companhia se alguém marcar mais
       * eventos na Kiwify um dia — e nenhum deles é dinheiro que entrou.
       */
      if (String(corpo.order_status ?? '') !== 'paid') {
        return json(res, 200, { success: true });
      }

      const cliente = (corpo.Customer ?? {}) as Record<string, unknown>;
      const comissoes = (corpo.Commissions ?? {}) as Record<string, unknown>;
      const rastreio = (corpo.TrackingParameters ?? {}) as Record<string, unknown>;

      /* `charge_amount` vem em CENTAVOS (8902 = R$ 89,02). Dividir é obrigatório:
         gravar 8902 poria um Purchase de oitenta e nove MIL reais no Meta. */
      const valor = Number(comissoes.charge_amount ?? 0) / 100;
      const liquido = Number(comissoes.my_commission ?? 0) / 100;

      /* O prefixo separa a venda de cartão da venda de PIX na memória, e serve
         de `event_id`: a Kiwify pode reenviar o mesmo pedido, e o Meta e o
         TikTok descartam o repetido porque o id é o mesmo. */
      const id = `kw-${String(corpo.order_id ?? '').replace(/[^\w-]/g, '')}`;
      if (!id || id === 'kw-' || !Number.isFinite(valor) || valor <= 0) {
        console.error('[kiwify] payload aprovado mas sem id ou sem valor — ignorado.');
        return json(res, 200, { success: true });
      }

      /* Já existe? Então isto é reenvio da Kiwify. Nada a fazer — e, sobretudo,
         nada a mandar de novo para o Meta ou para o TikTok. */
      const jaTinha = await lerVenda(id);
      if (jaTinha) {
        console.warn('[kiwify] reenvio do pedido', id, '— ignorado, já estava gravado.');
        return json(res, 200, { success: true });
      }

      /*
       * A ATRIBUIÇÃO VEM DO `TrackingParameters`, e é ele que faz a venda de
       * cartão colar no criativo. `utm_content` é o id do anúncio, como no
       * resto do funil; `sck` e `s1` são os dois campos livres da Kiwify, e é
       * neles que o checkout enfia o `fbclid` e o `ttclid` — sem isso o Meta
       * não casa a venda com o clique, porque ele casa por clique e não por UTM.
       */
      const texto = (v: unknown): string | undefined => {
        const s = String(v ?? '').trim();
        return s && s !== 'null' ? s.slice(0, 200) : undefined;
      };
      const attrib: Record<string, string> = {};
      const por = (chave: string, valorBruto: unknown) => {
        const s = texto(valorBruto);
        if (s) attrib[chave] = s;
      };
      por('origem', rastreio.utm_source);
      por('campanha', rastreio.utm_campaign);
      por('conjunto', rastreio.utm_medium);
      por('criativo', rastreio.utm_content);
      por('termo', rastreio.utm_term);
      por('fbclid', rastreio.sck);
      por('ttclid', rastreio.s1);

      const venda: Venda = {
        id,
        nome: texto(cliente.full_name) ?? '',
        email: texto(cliente.email) ?? '',
        telefone: texto(cliente.mobile) ?? '',
        itens: [itemDaKiwify((corpo.Product as Record<string, unknown> | undefined)?.product_id)],
        valor,
        status: 'completed',
        criadoEm: texto(corpo.created_at) ?? new Date().toISOString(),
        pagoEm: texto(corpo.approved_date) ?? new Date().toISOString(),
        adquirente: 'Kiwify (cartão)',
        valorLiquido: Number.isFinite(liquido) && liquido > 0 ? liquido : null,
        attrib,
        metaEnviadoEm: null,
        /* Ver `semUpsell` na interface `Venda`: cartão recebe o entregável pelo
           WhatsApp e NÃO recebe oferta de upsell. */
        semUpsell: true,
        ip: texto(cliente.ip),
      };

      /*
       * `await` NOS DOIS, e pela mesma razão de sempre nesta função: assim que
       * a resposta sai o processo congela, e promessa solta morre no meio — a
       * venda não seria gravada e o Purchase não chegaria a lugar nenhum.
       */
      const aceito = await enviarCompra({
        id: venda.id,
        valor: venda.valor,
        /* Código neutro, como em todo evento deste projeto: em 22/08/2026 a
           conta levou aviso de bloqueio por mandar ao Meta dado que revelava
           crença de quem visitava. Ver a regra 8 do NOTAS.md. */
        itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
        email: venda.email,
        telefone: venda.telefone,
        nome: venda.nome,
        attrib: venda.attrib,
        criadoEm: venda.criadoEm,
        ip: venda.ip,
        quando: Math.floor(Date.parse(venda.pagoEm ?? '') / 1000) || undefined,
      });
      await gravarVenda({ ...venda, metaEnviadoEm: aceito ? new Date().toISOString() : null });

      console.warn('[kiwify] venda de CARTAO gravada:', id, brl(valor), 'criativo:', attrib.criativo ?? 'sem utm', 'evento aceito:', aceito);
      return json(res, 200, { success: true });
    }

    /*
     * ========================================================================
     * O WEBHOOK DA AVENPAY — a ÚNICA coisa que sabe que o PIX foi pago
     * ========================================================================
     *
     * Na ZuckPay o aviso é um GATILHO: ele chega e o servidor CONFERE com o
     * gateway antes de acreditar. Aqui não existe conferir — a consulta é
     * proibida (ver o bloco da AvenPay, no topo). O aviso é a fonte da verdade.
     *
     * É POR ISSO QUE A ASSINATURA É OBRIGATÓRIA AQUI, e não opcional como a
     * documentação deles permite. Sem ela, qualquer um que descubra este
     * endereço manda `{"status":"PAID"}` e leva o produto: a venda entra no
     * painel, o `CompletePayment` sai para o TikTok (envenenando a otimização
     * com uma compra que não existiu) e o robô entrega o material no WhatsApp.
     *
     * `X-Signature` é HMAC-SHA256 do CORPO CRU, em **base64** — não hex, que é
     * o formato da Kiwify. Por isso o corpo é lido cru (`lerCorpoCru`) antes de
     * virar JSON: reserializar muda um byte e a assinatura deixa de bater.
     */
    /*
     * O AVISO DA ZUCKPAY — de volta em 30/09/2026, do jeito que rodou até 25/09.
     *
     * O AVISO É UM GATILHO, NÃO UMA FONTE DE VERDADE. Não há assinatura para
     * conferir, e o número do pedido está no DevTools de quem comprou: acreditar
     * no `status` do corpo deixaria qualquer um mandar `{"status":"PAID"}` com
     * o próprio id e levar o produto, carimbando um Purchase falso. O corpo diz
     * QUAL pedido olhar; quem diz o que aconteceu é `GET /v3/pix/status`, com a
     * chave salva no painel — uma consulta por aviso que fala de dinheiro,
     * nunca em laço.
     *
     * NÃO OLHA O INTERRUPTOR: PIX criado antes de desligar ainda é pago.
     *
     * O GET TAMBÉM RESPONDE 200: o painel deles valida a URL antes de salvar,
     * e nem sempre com POST (medido em 04/09/2026).
     */
    /*
     * A PAGOU.AI ENTRA PELA MESMA PORTA, porque o desenho é o mesmo: aviso sem
     * assinatura, e a verdade vem de perguntar ao gateway. O que muda é onde
     * cada um põe as coisas — a Pagou.ai embrulha tudo em `data`, e o status
     * vem em minúsculas (`paid`, `canceled`, `chargedback`).
     */
    /*
     * E A PINGUPAG TAMBÉM (07/10/2026). O que muda nela: o pedido é achado pela
     * NOSSA referência (`external_id`), porque o `transaction_id` do aviso não é
     * o mesmo da criação; e a consulta devolve uma LISTA, da qual vale o primeiro.
     */
    /*
     * E A BEEHIVE (09/10/2026). O aviso dela traz o NÚMERO da transação; o
     * mapa do Redis diz qual venda é, e a consulta é feita por esse número.
     * A resposta tem de ser da MESMA transação que se perguntou.
     */
    if (
      caminho === '/webhooks/zuckpay' ||
      caminho === '/webhooks/pagouai' ||
      caminho === '/webhooks/pingupag' ||
      caminho === '/webhooks/beehive'
    ) {
      if (metodo !== 'POST') return json(res, 200, { success: true, data: { ok: true } });
      const idGw: IdGateway =
        caminho === '/webhooks/pagouai'
          ? 'pagouai'
          : caminho === '/webhooks/pingupag'
            ? 'pingupag'
            : caminho === '/webhooks/beehive'
              ? 'beehive'
              : 'zuckpay';
      try {
        const aviso = await lerCorpo(req);
        const bloco = (idGw === 'pagouai' || idGw === 'beehive' ? (aviso.data ?? {}) : aviso) as Record<string, unknown>;
        /* Só na Beehive: o número DELA, que não é o id da nossa venda. */
        const numeroB = idGw === 'beehive' ? String(bloco.id ?? aviso.objectId ?? '').replace(/\D+/g, '') : '';
        /*
         * O FORMATO DO AVISO DA ZUCKPAY NUNCA FOI VISTO — só deduzido. Em
         * 11/10/2026 ela registrou dezenas de avisos entregues com 200 e nenhuma
         * venda foi marcada por eles. Por isso a leitura procura o status e o id
         * também um nível abaixo (`data`, `transaction`, `payment`), e o log
         * guarda OS NOMES dos campos de cada aviso — nunca os valores, que têm
         * nome e CPF de cliente.
         */
        const dentro = (idGw === 'zuckpay'
          ? (bloco.data ?? bloco.transaction ?? bloco.payment ?? bloco.pix ?? {})
          : {}) as Record<string, unknown>;
        const situacaoAvisada = [
          bloco.status, bloco.event_type, aviso.event, bloco.type, bloco.event_name, bloco.evento,
          dentro.status, dentro.event,
        ].filter((s) => typeof s === 'string').join(' ').toUpperCase();
        if (idGw === 'zuckpay') {
          console.warn(
            '[zuckpay] aviso recebido. campos:', Object.keys(bloco).slice(0, 30).join(','),
            '| dentro:', Object.keys(dentro).slice(0, 30).join(','),
            '| situacao:', JSON.stringify(situacaoAvisada.slice(0, 80)),
            '| com chave:', Boolean(url.searchParams.get('k')),
          );
        }
        const idPedido =
          idGw === 'beehive'
            ? numeroB
              ? String((await redis(['GET', chaveDaBeehive(numeroB)])) ?? '')
              : ''
            : idGw === 'pingupag'
            ? String(bloco.external_id ?? bloco.store_reference ?? '')
            : String(
                bloco.transactionId ?? bloco.transaction_id ?? dentro.transactionId ?? dentro.transaction_id ?? bloco.id ?? dentro.id ?? '',
              );
        const falaDeDinheiro =
          /PAID|APPROVED|APROVAD|REFUND|REEMBOLS|CHARGEBACK|CHARGEDBACK|REFUSED|RECUSAD|DECLINED|EXPIR|CANCEL/.test(
            situacaoAvisada,
          );
        if (!idPedido || !falaDeDinheiro) return json(res, 200, { success: true });

        const venda = await lerVenda(idPedido);
        /* Cobrança de outro sistema na mesma conta, ou aviso de teste. */
        if (!venda) return json(res, 200, { success: true });

        const gw = await lerGateway(idGw, true);
        if ((!SEM_CLIENT_ID.has(idGw) && !gw.clientId) || !gw.token) {
          console.error(`[${idGw}] aviso recebido sem chave salva no painel — nao da para conferir:`, idPedido);
          return erro(res, 503, 'UNVERIFIED', 'Não consegui confirmar agora. Reenvie.');
        }
        const consulta = await chamarGateway(
          idGw,
          gw,
          idGw === 'pagouai'
            ? `/v2/transactions/${encodeURIComponent(idPedido)}`
            : idGw === 'beehive'
              ? `/transactions/${numeroB}`
            : idGw === 'pingupag'
              ? `/gateway/v1/query?action=list_transactions&external_id=${encodeURIComponent(idPedido)}`
            : `/v3/pix/status?transactionId=${encodeURIComponent(idPedido)}`,
          { metodo: 'GET' },
        );
        /* A PinguPag responde uma LISTA; lista vazia é "não achei" e não pode
           virar status nenhum — `ok` cai e o gateway reenvia. */
        const listaG = idGw === 'pingupag' && Array.isArray(consulta.dados) ? (consulta.dados as unknown[]) : null;
        /* Na Beehive a resposta tem de ser da transação que se perguntou, e os
           nomes dela são traduzidos para os que o resto da rotina já lê:
           `paidAt` -> `paid_at`, e o líquido de `fee.netAmount` (centavos). */
        const daBeehive = idGw === 'beehive' ? (consulta.dados as Record<string, unknown>) : null;
        const ok =
          consulta.ok &&
          (idGw !== 'pingupag' || Boolean(listaG?.length)) &&
          (idGw !== 'beehive' || String(daBeehive?.id ?? '') === numeroB);
        const dados = (
          idGw === 'pagouai'
            ? (consulta.dados.data ?? {})
            : idGw === 'pingupag'
              ? (listaG?.[0] ?? {})
              : daBeehive
                ? {
                    ...daBeehive,
                    paid_at: daBeehive.paidAt,
                    amount_liquid: (daBeehive.fee as Record<string, unknown> | null | undefined)?.netAmount,
                    acquirer: daBeehive.acquirerType,
                  }
                : consulta.dados
        ) as Record<string, unknown>;
        if (!ok) {
          /*
           * NÃO DEU PARA CONFERIR: 503 PARA O GATEWAY REENVIAR. O 200 diria
           * "recebi e tratei" para um aviso que ninguém tratou, e o gateway
           * nunca mais mandaria.
           */
          console.error(`[${idGw}] nao consegui confirmar com o gateway:`, idPedido, '— pedindo reenvio');
          return erro(res, 503, 'UNVERIFIED', 'Não consegui confirmar agora. Reenvie.');
        }

        /*
         * O STATUS PODE VIR EMBRULHADO (`data.status`, `transaction.status`) —
         * e quando não é reconhecido, O LOG DIZ O QUE VEIO. Até 11/10/2026 um
         * status desconhecido virava `pending` em silêncio: o aviso respondia
         * 200, nada mudava, e não havia uma linha de log para dizer por quê.
         * Só os nomes dos campos e o valor do status: nada de dado de cliente.
         */
        const embrulho = (
          dados.status === undefined || dados.status === null
            ? ((dados.data ?? dados.transaction ?? dados.pix ?? {}) as Record<string, unknown>)
            : dados
        ) as Record<string, unknown>;
        const statusBruto = embrulho.status ?? embrulho.situacao ?? embrulho.payment_status;
        const situacaoDaConsulta = traduzirStatus(statusBruto);
        /*
         * A CONSULTA ATRASADA NÃO SEGURA MAIS A VENDA. Se o aviso diz "pago",
         * veio pela URL com a NOSSA chave e a consulta só não confirmou ainda
         * (responde pendente), a venda é marcada agora — é o que faz o evento
         * sair no segundo do pagamento. Qualquer outra resposta da consulta
         * (estornado, cancelado, expirado) continua mandando.
         */
        const avisoProvado =
          idGw === 'zuckpay' &&
          /PAID|APPROVED|APROVAD/.test(situacaoAvisada) &&
          !/REFUND|REEMBOLS|CHARGEBACK|REFUSED|RECUSAD/.test(situacaoAvisada) &&
          segredoConfere(String(url.searchParams.get('k') ?? ''), chaveDaUrlSpyPag(gw.token));
        const situacaoReal = situacaoDaConsulta === 'pending' && avisoProvado ? 'completed' : situacaoDaConsulta;
        if (situacaoDaConsulta === 'pending' && avisoProvado) {
          console.warn('[zuckpay] aviso com chave confere: venda marcada sem esperar a consulta. pedido:', idPedido);
        }
        if (situacaoReal === 'pending' && !/^(PENDING|PENDENTE|WAITING_PAYMENT|PROCESSING|CREATED)$/i.test(String(statusBruto ?? ''))) {
          console.warn(
            `[${idGw}] status NAO RECONHECIDO na consulta:`,
            JSON.stringify(String(statusBruto ?? '').slice(0, 40)),
            'campos:',
            Object.keys(dados).slice(0, 25).join(','),
            'pedido:',
            idPedido,
          );
        }
        /*
         * O AVISO DIZ "PAGO" E A CONSULTA NÃO CONFIRMA: isso tem de aparecer no
         * log. Em 11/10/2026 duas vendas pagas no painel da ZuckPay ficaram
         * `pending` aqui com a consulta respondendo 200, e sem esta linha não
         * havia como saber o que ela tinha respondido.
         */
        if (/PAID|APPROVED|APROVAD/.test(situacaoAvisada) && situacaoReal !== 'completed') {
          console.warn(
            `[${idGw}] aviso diz PAGO, consulta diz:`,
            JSON.stringify(String(statusBruto ?? '(sem status)').slice(0, 40)),
            'HTTP', consulta.status,
            'campos:', Object.keys(dados).slice(0, 25).join(','),
            'pedido:', idPedido,
          );
          /* Fica anotado para a conferência voltar a perguntar — ver `avisoPagoEm`. */
          if (venda.status === 'pending' && !venda.avisoPagoEm) {
            await atualizarVenda(idPedido, { avisoPagoEm: new Date().toISOString() }, venda);
          }
        }
        const pagoEm =
          typeof dados.confirmed_date === 'string'
            ? dados.confirmed_date
            : typeof dados.paid_at === 'string'
              ? dados.paid_at
              : null;

        if (situacaoReal === 'completed' && (venda.status !== 'completed' || !venda.metaEnviadoEm)) {
          const aceito = venda.metaEnviadoEm
            ? true
            : await enviarCompra({
                id: venda.id,
                valor: venda.valor,
                itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
                email: venda.email,
                telefone: venda.telefone,
                nome: venda.nome,
                attrib: venda.attrib,
                criadoEm: venda.criadoEm,
                ua: venda.ua,
                ip: venda.ip,
                quando: pagoEm ? Math.floor(new Date(pagoEm).getTime() / 1000) : undefined,
              });
          await atualizarVenda(
            idPedido,
            {
              status: 'completed',
              /* O gravado manda: cada reenvio empurraria a hora para a frente
                 e a janela de 7 dias da entrega nunca fecharia. */
              pagoEm: venda.pagoEm ?? pagoEm ?? new Date().toISOString(),
              metaEnviadoEm: venda.metaEnviadoEm ?? (aceito ? new Date().toISOString() : null),
              adquirente: venda.adquirente ?? acharAdquirente(dados),
              valorLiquido: venda.valorLiquido ?? acharValorLiquido(dados, venda.valor),
            },
            venda,
          );
          console.warn(`[${idGw}] venda PAGA:`, idPedido, brl(venda.valor), 'evento aceito:', aceito);
        } else if (
          (situacaoReal === 'refunded' || situacaoReal === 'cancelled' || situacaoReal === 'expired') &&
          venda.status !== situacaoReal
        ) {
          /* O `metaEnviadoEm` NÃO é apagado: o evento já saiu, e limpar o
             carimbo faria o botão de reenvio mandar a venda estornada de novo. */
          await atualizarVenda(idPedido, { status: situacaoReal }, venda);
          console.warn(`[${idGw}] pedido`, idPedido, '->', situacaoReal, '(confirmado pelo gateway)');
        }
        return json(res, 200, { success: true });
      } catch (falha) {
        /* Defeito de código não melhora com reenvio: 200, e o log grita. */
        console.error(`[${idGw}] erro ao tratar aviso:`, (falha as Error)?.message);
        return json(res, 200, { success: true });
      }
    }

    /*
     * O AVISO DA SPYPAG. Mesmo desenho do da AvenPay, logo abaixo — as duas
     * portas, a trava do `metaEnviadoEm`, o 200 para pedido desconhecido —
     * com o que muda: a assinatura é HMAC-SHA256 do corpo cru com o PRÓPRIO
     * TOKEN, no `X-Webhook-Signature`, e o id é `data.transaction_uuid`.
     *
     * LÊ O REDIS FRESCO, e não o cache, e NÃO olha o interruptor: quem desligou
     * a SpyPag com PIX em aberto continua recebendo esses pagamentos.
     */
    if (caminho === '/webhooks/spypag') {
      if (metodo !== 'POST') return json(res, 200, { success: true, data: { ok: true } });

      const cru = await lerCorpoCru(req);
      const spy = await lerGateway('spypag', true);
      if (!spy.token) {
        console.error('[spypag] aviso recebido sem token salvo no painel — nada foi gravado. Tamanho:', cru.length);
        return json(res, 200, { success: true });
      }

      const assinatura = String(req.headers['x-webhook-signature'] ?? '');
      const digerido = createHmac('sha256', spy.token).update(cru).digest();
      const assinaturaConfere =
        Boolean(assinatura) &&
        (segredoConfere(assinatura, digerido.toString('hex')) ||
          segredoConfere(assinatura, digerido.toString('base64')));
      const chaveDaUrlConfere = segredoConfere(String(url.searchParams.get('k') ?? ''), chaveDaUrlSpyPag(spy.token));

      if (!assinaturaConfere && !chaveDaUrlConfere) {
        console.error('[spypag] aviso RECUSADO:', assinatura ? 'assinatura nao confere' : 'sem assinatura', '/ chave na URL nao confere');
        return erro(res, 401, 'BAD_SIGNATURE', 'Assinatura inválida.');
      }
      if (assinatura && !assinaturaConfere) {
        console.error('[spypag] ATENCAO: aceito pela chave da URL, mas o X-Webhook-Signature NAO confere.');
      }

      let aviso: Record<string, unknown> = {};
      try {
        aviso = JSON.parse(cru) as Record<string, unknown>;
      } catch {
        return json(res, 200, { success: true });
      }
      const bloco = (aviso.data ?? {}) as Record<string, unknown>;
      const idPedido = String(bloco.transaction_uuid ?? '');
      const evento = String(aviso.event ?? '');
      const estado = String(bloco.status ?? '').toLowerCase();
      /*
       * SÓ `deposit.completed` (ou status `completed`) É DINHEIRO. Saque e
       * "aguardando pagamento" chegam pela mesma rota e não mexem em venda.
       */
      const situacao =
        evento === 'deposit.completed' || estado === 'completed'
          ? 'completed'
          : evento === 'transaction.failed' || estado === 'failed'
            ? 'failed'
            : null;
      if (!idPedido || !situacao || evento.startsWith('withdrawal.')) return json(res, 200, { success: true });

      const venda = await lerVenda(idPedido);
      if (!venda) {
        console.warn('[spypag] aviso de pedido que nao existe aqui:', idPedido, situacao);
        return json(res, 200, { success: true });
      }

      if (situacao !== 'completed') {
        /* Falha nunca desfaz venda paga: um aviso atrasado fora de ordem
           apagaria faturamento que existe. */
        if (venda.status === 'pending') {
          await atualizarVenda(idPedido, { status: situacao }, venda);
          console.warn('[spypag] pedido', idPedido, 'passou para', situacao);
        }
        return json(res, 200, { success: true });
      }

      const valorAvisado = Number(bloco.amount);
      if (Number.isFinite(valorAvisado) && Math.abs(valorAvisado - venda.valor) > 0.01) {
        console.error('[spypag] ATENCAO: valor pago', valorAvisado, 'diferente do pedido', venda.valor, idPedido);
      }

      const pagoEm = typeof aviso.created_at === 'string' ? aviso.created_at : new Date().toISOString();
      if (venda.status !== 'completed') {
        await atualizarVenda(idPedido, { status: 'completed', pagoEm }, venda);
      }

      const aceito = venda.metaEnviadoEm
        ? true
        : await enviarCompra({
            id: venda.id,
            valor: venda.valor,
            itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
            email: venda.email,
            telefone: venda.telefone,
            nome: venda.nome,
            attrib: venda.attrib,
            criadoEm: venda.criadoEm,
            ua: venda.ua,
            ip: venda.ip,
            quando: Math.floor(Date.parse(pagoEm) / 1000) || undefined,
          });
      if (aceito && !venda.metaEnviadoEm) {
        await atualizarVenda(idPedido, { metaEnviadoEm: new Date().toISOString() });
      }

      console.warn('[spypag] venda PAGA:', idPedido, brl(venda.valor), 'evento aceito:', aceito);
      return json(res, 200, { success: true });
    }

    if (caminho === '/webhooks/avenpay') {
      /* Mesmo motivo do GET da ZuckPay, logo abaixo: o painel do gateway
         valida a URL antes de salvar, e nem sempre com POST. */
      if (metodo !== 'POST') return json(res, 200, { success: true, data: { ok: true } });

      const cru = await lerCorpoCru(req);

      if (!AVEN_WEBHOOK_SECRET && !AVEN_WEBHOOK_URL_KEY) {
        /*
         * SEM O SEGREDO A ROTA NÃO ACREDITA EM NINGUÉM. Não grava, não entrega,
         * e diz no log exatamente o que falta. É a mesma escolha do webhook da
         * Kiwify: perder a medição de uma venda é ruim; aceitar venda forjada
         * é pior, e aqui seria pior ainda, porque aqui não há segunda checagem.
         */
        console.error('[avenpay] aviso recebido sem AVEN_WEBHOOK_SECRET nem AVEN_WEBHOOK_URL_KEY — nada foi gravado. Tamanho:', cru.length);
        return json(res, 200, { success: true });
      }

      /*
       * DUAS PORTAS, e o motivo de haver duas.
       *
       * A ASSINATURA VALE EM BASE64 E EM HEX. A documentação diz base64, mas o
       * segredo que o painel entrega é hexadecimal de 64 caracteres, e gateway
       * que escreve o segredo em hex costuma escrever a assinatura em hex
       * também. Conferir os dois custa duas comparações e evita o pior defeito
       * possível aqui: TODA venda recusada por diferença de formato.
       *
       * A CHAVE NA URL (`?k=`) É A RESERVA. A tela de cadastro de webhook deles
       * (25/09/2026) tem três campos — nome, tipo e URL — e nenhum lugar onde
       * um segredo apareça, então o aviso pode chegar sem assinatura nenhuma.
       * E se o segredo estiver errado, a porta da assinatura fecha para SEMPRE:
       * dinheiro entrando, nenhuma venda confirmada, nenhuma entrega, nenhum
       * evento. A chave na URL também é segredo compartilhado — quem não
       * conhece o endereço não abre nem esta.
       *
       * O QUE NÃO SE FAZ AQUI: confiar em "o pedido existe no nosso Redis". O
       * id do pagamento volta para o navegador de quem comprou — qualquer
       * comprador mandaria `{"status":"PAID"}` com o próprio id e levaria o
       * produto sem pagar.
       */
      const assinatura = String(req.headers['x-signature'] ?? '');
      const digerido = createHmac('sha256', AVEN_WEBHOOK_SECRET).update(cru).digest();
      const assinaturaConfere =
        Boolean(assinatura) &&
        (segredoConfere(assinatura, digerido.toString('base64')) ||
          segredoConfere(assinatura, digerido.toString('hex')));

      const chaveDaUrlConfere =
        Boolean(AVEN_WEBHOOK_URL_KEY) &&
        segredoConfere(String(url.searchParams.get('k') ?? ''), AVEN_WEBHOOK_URL_KEY);

      if (!assinaturaConfere && !chaveDaUrlConfere) {
        console.error(
          '[avenpay] aviso RECUSADO:',
          assinatura ? 'assinatura nao confere' : 'sem assinatura',
          '/ chave na URL:',
          AVEN_WEBHOOK_URL_KEY ? 'nao confere' : 'nao configurada',
        );
        return erro(res, 401, 'BAD_SIGNATURE', 'Assinatura inválida.');
      }
      /* Passou pela URL mas a assinatura veio e não bateu: o segredo está
         errado. A venda é processada (o aviso é legítimo) e o log grita. */
      if (assinatura && !assinaturaConfere) {
        console.error('[avenpay] ATENCAO: aceito pela chave da URL, mas o X-Signature NAO confere. Confira AVEN_WEBHOOK_SECRET.');
      }

      let aviso: Record<string, unknown> = {};
      try {
        aviso = JSON.parse(cru) as Record<string, unknown>;
      } catch {
        return json(res, 200, { success: true });
      }

      const idPedido = String(aviso.id ?? '');
      const situacao = traduzirStatus(aviso.status);
      if (!idPedido) return json(res, 200, { success: true });

      const venda = await lerVenda(idPedido);
      /* Cobrança de outro sistema na mesma conta, ou aviso de teste: não é
         erro, e responder 200 evita que o gateway fique reenviando. */
      if (!venda) {
        console.warn('[avenpay] aviso de pedido que nao existe aqui:', idPedido, situacao);
        return json(res, 200, { success: true });
      }

      /*
       * ESTORNO E CHARGEBACK ENTRAM COMO ESTÃO, sem mexer no `CompletePayment`.
       * Desfazer o evento no TikTok não é possível, e marcar a venda é o que
       * faz o painel parar de contar aquele dinheiro como faturamento.
       */
      if (situacao !== 'completed') {
        if (venda.status !== situacao) {
          await atualizarVenda(idPedido, { status: situacao }, venda);
          console.warn('[avenpay] pedido', idPedido, 'passou para', situacao);
        }
        return json(res, 200, { success: true });
      }

      const pagoEm = typeof aviso.paidAt === 'string' ? aviso.paidAt : new Date().toISOString();

      /*
       * A TRAVA É `metaEnviadoEm`, E NÃO O STATUS. A AvenPay reenvia o aviso
       * até receber 200, e o mesmo pedido pode chegar duas vezes. O `event_id`
       * do TikTok já é o número do pedido — ele descartaria o repetido —, mas
       * não custa nada não mandar.
       */
      if (venda.status !== 'completed') {
        await atualizarVenda(idPedido, { status: 'completed', pagoEm }, venda);
      }

      const aceito = venda.metaEnviadoEm
        ? true
        : await enviarCompra({
            id: venda.id,
            valor: venda.valor,
            itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
            email: venda.email,
            telefone: venda.telefone,
            nome: venda.nome,
            attrib: venda.attrib,
            criadoEm: venda.criadoEm,
            ua: venda.ua,
            ip: venda.ip,
            /* A hora do PAGAMENTO, e não a de agora: é por ela que a
               plataforma procura o clique que gerou a venda. */
            quando: Math.floor(Date.parse(pagoEm) / 1000) || undefined,
          });

      if (aceito && !venda.metaEnviadoEm) {
        await atualizarVenda(idPedido, { metaEnviadoEm: new Date().toISOString() });
      }

      console.warn('[avenpay] venda PAGA:', idPedido, brl(venda.valor), 'evento aceito:', aceito);
      return json(res, 200, { success: true });
    }

    /*
     * ========================================================================
     * O PAINEL. Rota de leitura, protegida por senha que mora só na Vercel.
     * ========================================================================
     *
     * A senha vai no CABEÇALHO, nunca na URL: endereço entra em histórico, em
     * log de servidor e no `referer` de tudo que a página carregar depois -- e
     * esta lista tem nome, e-mail e telefone de quem comprou.
     *
     * SEM `ADMIN_TOKEN` DEFINIDO, AS ROTAS NÃO EXISTEM. É melhor o painel não
     * abrir do que abrir para o mundo: quem descobrisse o endereço leria a
     * carteira de clientes inteira.
     */
    if (caminho.startsWith('/admin/')) {
      const senha = (process.env.ADMIN_TOKEN ?? '').trim();
      if (!senha) return erro(res, 404, 'NOT_FOUND', 'Rota não encontrada.');

      /*
       * A CHAVE DO CRON ABRE UMA PORTA SÓ, e é de propósito.
       *
       * O agendador da Vercel não tem como mandar o `x-admin-token`: ele
       * assina com `Authorization: Bearer $CRON_SECRET`. Aceitar essa
       * assinatura no bloco inteiro daria à chave do relógio o mesmo poder da
       * senha do painel — ler a carteira de clientes, apagar pedido, pausar
       * anúncio no Meta. Ela vale para a varredura, e para mais nada.
       *
       * Sem `CRON_SECRET` preenchido não há caminho nenhum por aqui: string
       * vazia nunca casa, porque `veioDoCron` exige o segredo antes de comparar.
       */
      const segredoDoCron = (process.env.CRON_SECRET ?? '').trim();
      const veioDoCron =
        Boolean(segredoDoCron) &&
        caminho === '/admin/conferir-pendentes' &&
        segredoConfere(String(req.headers.authorization ?? ''), `Bearer ${segredoDoCron}`);

      /*
       * SENHA ERRADA CONTA, SENHA CERTA NÃO. Só a falha incrementa: o painel
       * legítimo atualiza dezenas de vezes por hora e não pode ser barrado
       * por usar a própria senha. Mais de 20 erros em 15 min por IP → 429,
       * que é o que transforma "tentar todas" em "tentar 20".
       */
      const chaveFalhas = `admin-falhas:${ipDe(req) || 'sem-ip'}`;
      const falhas = Number((await redis(['GET', `limite:${chaveFalhas.replace(/[^\w.:-]/g, '')}`])) ?? 0);
      if (falhas > 20) {
        return erro(res, 429, 'RATE_LIMITED', 'Muitas tentativas de senha. Aguarde 15 minutos.');
      }
      if (!veioDoCron && !segredoConfere(String(req.headers['x-admin-token'] ?? ''), senha)) {
        await passouDoLimite(chaveFalhas, 20, 900);
        return erro(res, 401, 'UNAUTHORIZED', 'Senha inválida.');
      }

      /*
       * CONFERIR PENDENTES — a rede para quando o aviso não marca a venda.
       *
       * O painel chamava `/admin/conferir-pendentes` e a autenticação acima já
       * contava com ele, mas NINGUÉM ATENDIA: a rota caía no 404 do fim do
       * arquivo. O botão "Conferir PIX no gateway" existia e nunca funcionou.
       *
       * POR QUE É NECESSÁRIA, e não é redundância do webhook: em 11/10/2026 a
       * ZuckPay registrou 25 avisos entregues com HTTP 200 e uma venda de
       * R$ 47 continuou `pending` aqui — o aviso chegou numa versão que ainda
       * não reconhecia o status que a consulta devolvia. O webhook é uma
       * tentativa única; se ela passa batido, o dinheiro some do painel, não
       * entra na fila de entrega e nunca vira evento no TikTok.
       *
       * ELA NÃO ACREDITA EM NADA: para cada pendente, PERGUNTA ao gateway. Só
       * marca o que o gateway confirma, usando a mesma `traduzirStatus` do
       * aviso — uma regra só, nos dois caminhos.
       */
      if (caminho === '/admin/conferir-pendentes') {
        if (metodo !== 'POST') return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST.');

        const DE_GATEWAY: Partial<Record<string, IdGateway>> = {
          zuckpay: 'zuckpay', pagouai: 'pagouai', pingupag: 'pingupag',
          beehive: 'beehive', spypag: 'spypag',
        };
        /* Do mais novo para o mais velho, e com teto: a função tem 60s, e cada
           pendente custa uma ida ao gateway. Quem não couber hoje entra na
           próxima volta — a rotina roda de novo. */
        /*
         * `?so=avisados` É A VOLTA BARATA, a que roda de minuto em minuto: só os
         * pedidos que o gateway DISSE que foram pagos e a consulta ainda não
         * confirmou (`avisoPagoEm`), das últimas 48 horas. Quase sempre são zero
         * idas ao gateway. Sem o parâmetro é a varredura completa — a do botão
         * do painel —, que custa até 40 consultas e não pode rodar em laço: o
         * teto da ZuckPay é baixo.
         */
        const soAvisados = url.searchParams.get('so') === 'avisados';
        /* `?so=recentes` é a volta do agendador da VPS (servico-whatsapp/
           conferir-pagamentos.sh, de 3 em 3 minutos): os PIX das últimas 3 horas
           e os que o gateway avisou. PIX mais velho que isso já venceu. */
        const soRecentes = url.searchParams.get('so') === 'recentes';
        const haTresHoras = Date.now() - 3 * 60 * 60 * 1000;
        const haDoisDias = Date.now() - 48 * 60 * 60 * 1000;
        const pendentes = (await listarVendas())
          .filter((v) => v.status === 'pending' && DE_GATEWAY[String(v.gateway ?? '')])
          .filter((v) => !soAvisados || (v.avisoPagoEm && Date.parse(v.avisoPagoEm) > haDoisDias))
          .filter(
            (v) =>
              !soRecentes ||
              Date.parse(v.criadoEm) > haTresHoras ||
              Boolean(v.avisoPagoEm && Date.parse(v.avisoPagoEm) > haDoisDias),
          )
          .sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm))
          .slice(0, 40);

        const recuperadas: { id: string; nome: string; valor: number }[] = [];
        let olhados = 0;

        for (const venda of pendentes) {
          const idGw = DE_GATEWAY[String(venda.gateway)] as IdGateway;
          try {
            const gw = await lerGateway(idGw, true);
            if ((!SEM_CLIENT_ID.has(idGw) && !gw.clientId) || !gw.token) continue;
            olhados++;
            const consulta = await chamarGateway(
              idGw,
              gw,
              idGw === 'pagouai'
                ? `/v2/transactions/${encodeURIComponent(venda.id)}`
                : idGw === 'pingupag'
                  ? `/gateway/v1/query?action=list_transactions&external_id=${encodeURIComponent(venda.id)}`
                  : `/v3/pix/status?transactionId=${encodeURIComponent(venda.id)}`,
              { metodo: 'GET' },
            );
            if (!consulta.ok) continue;
            const listaG = idGw === 'pingupag' && Array.isArray(consulta.dados) ? (consulta.dados as unknown[]) : null;
            const dados = (
              idGw === 'pagouai' ? (consulta.dados.data ?? {}) : idGw === 'pingupag' ? (listaG?.[0] ?? {}) : consulta.dados
            ) as Record<string, unknown>;
            const embrulho = (
              dados.status === undefined || dados.status === null
                ? ((dados.data ?? dados.transaction ?? dados.pix ?? {}) as Record<string, unknown>)
                : dados
            ) as Record<string, unknown>;
            const statusBruto = embrulho.status ?? embrulho.situacao ?? embrulho.payment_status;
            const situacaoReal = traduzirStatus(statusBruto);
            if (situacaoReal !== 'completed') {
              if (!/^(PENDING|PENDENTE|WAITING_PAYMENT|PROCESSING|CREATED)$/i.test(String(statusBruto ?? ''))) {
                console.warn('[conferir] status nao reconhecido:', JSON.stringify(String(statusBruto ?? '').slice(0, 40)), 'pedido:', venda.id);
              }
              continue;
            }
            const pagoEm =
              typeof dados.confirmed_date === 'string' ? dados.confirmed_date
                : typeof dados.paid_at === 'string' ? dados.paid_at : null;
            /* O evento só sai se ainda não saiu: `metaEnviadoEm` é o carimbo
               que impede a mesma venda de contar duas vezes no TikTok. */
            const aceito = venda.metaEnviadoEm
              ? true
              : await enviarCompra({
                  id: venda.id, valor: venda.valor,
                  itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
                  email: venda.email, telefone: venda.telefone, nome: venda.nome,
                  attrib: venda.attrib, criadoEm: venda.criadoEm, ua: venda.ua, ip: venda.ip,
                  quando: pagoEm ? Math.floor(new Date(pagoEm).getTime() / 1000) : undefined,
                });
            await atualizarVenda(
              venda.id,
              {
                status: 'completed',
                pagoEm: venda.pagoEm ?? pagoEm ?? new Date().toISOString(),
                metaEnviadoEm: venda.metaEnviadoEm ?? (aceito ? new Date().toISOString() : null),
                adquirente: venda.adquirente ?? acharAdquirente(dados),
                valorLiquido: venda.valorLiquido ?? acharValorLiquido(dados, venda.valor),
              },
              venda,
            );
            recuperadas.push({ id: venda.id, nome: venda.nome, valor: venda.valor });
            console.warn('[conferir] venda PAGA recuperada:', venda.id, brl(venda.valor), 'evento aceito:', aceito);
          } catch (falha) {
            /* Um gateway fora do ar não pode derrubar a varredura dos outros. */
            console.error('[conferir] erro em', venda.id, (falha as Error)?.message);
          }
        }
        return json(res, 200, { success: true, data: { olhados, recuperadas } });
      }

      /*
       * O INTERRUPTOR — a única escrita deste projeto fora daqui.
       *
       * Está atrás da MESMA senha do painel, e o que ela aceita é fechado a dois
       * valores em `mudarStatusNoMeta`. Ver o comentário de lá: o mesmo endereço
       * da Graph API que pausa também apaga.
       */
      if (metodo === 'POST' && caminho === '/admin/meta/status') {
        const corpo = await lerCorpo(req);
        const r = await mudarStatusNoMeta(String(corpo.id ?? ''), String(corpo.status ?? ''));
        if (!r.ok) return erro(res, 400, 'META_REFUSED', r.erro ?? 'O Meta recusou.');
        return json(res, 200, { success: true, data: { id: corpo.id, status: corpo.status } });
      }

      /*
       * ========================================================================
       * A SEGUNDA CHANCE DO `Purchase` — a venda que o Meta nunca recebeu
       * ========================================================================
       *
       * POR QUE ISTO PRECISOU EXISTIR: em 06/09/2026, DUAS das cinco vendas
       * pagas estavam com `metaEnviadoEm` nulo. R$ 121 que entraram na conta e
       * que o Gerenciador nunca soube — nos criativos CV9 e CV1, justamente
       * dois dos três que convertem.
       *
       * A CAUSA NÃO É UM ERRO DE LÓGICA, é a falta de uma segunda tentativa.
       * O `Purchase` sai de dois lugares, e os DOIS são de uma vez só:
       *
       *   1. a consulta de status, enquanto o QR está na tela — e quem paga PIX
       *      no app do banco fecha a aba, então essa consulta pode nunca voltar;
       *   2. o webhook da ZuckPay, que chega uma vez.
       *
       * Se o Meta recusar ou a rede falhar naquele instante, `enviarCompra`
       * devolve `false`, o código grava `metaEnviadoEm: null` esperando uma
       * próxima passagem — e a próxima passagem não vem. A venda fica perdida
       * para a atribuição para sempre.
       *
       * ISSO PIORA COM ESCALA, e é por isso que virou rota: a mesma fração de
       * falha que hoje some com R$ 121 some com R$ 1.210 quando o gasto
       * multiplicar, e o robô do Meta passa a otimizar em cima de um
       * faturamento que não é o real.
       *
       * POR QUE UM BOTÃO, E NÃO UM RETRY ESCONDIDO DENTRO DO `GET /admin/orders`:
       * reenviar é efeito colateral, e efeito colateral em rota de leitura é o
       * tipo de coisa que dispara sozinha quando alguém deixa o painel aberto
       * numa aba. Aqui é explícito, o dono vê quantas estão faltando, e o
       * `event_id` é o número do pedido — o Meta descarta o repetido, então
       * clicar duas vezes não vira venda dobrada.
       */
      if (metodo === 'POST' && caminho === '/admin/meta/reenviar') {
        /*
         * A PERGUNTA É "TEM PARA ONDE MANDAR?", E NÃO "O META ESTÁ LIGADO?"
         * (24/09/2026). Este botão é a segunda chance da venda que não chegou à
         * plataforma — e checar só o Meta o matava justamente quando ele saiu do
         * ar: a venda do TikTok ficava sem recuperação nenhuma.
         *
         * Quem decide o destino de cada venda continua sendo `enviarCompra`,
         * pela origem. Aqui só se confere que existe ao menos um destino vivo.
         */
        if (!metaLigado && !tiktokLigado) {
          return erro(res, 503, 'META_OFF', 'Nenhuma plataforma de medição está configurada.');
        }
        const vendas = await listarVendas();
        const faltando = vendas.filter((v) => v.status === 'completed' && !v.metaEnviadoEm);
        /*
         * Teto de 20 por chamada. São 20 s de função e cada envio é uma ida ao
         * Meta; sem teto, uma fila grande estoura o tempo e não reenvia NENHUMA
         * -- pior que reenviar as 20 primeiras e pedir outro clique.
         */
        const lote = faltando.slice(0, 20);
        let aceitas = 0;
        for (const venda of lote) {
          const aceito = await enviarCompra({
            id: venda.id,
            valor: venda.valor,
            itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
            email: venda.email,
            telefone: venda.telefone,
            nome: venda.nome,
            attrib: venda.attrib,
            criadoEm: venda.criadoEm,
            ua: venda.ua,
            ip: venda.ip,
            /* A hora do PAGAMENTO: é por ela que o Meta procura o clique. */
            quando: venda.pagoEm ? Math.floor(new Date(venda.pagoEm).getTime() / 1000) : undefined,
          });
          if (aceito) {
            aceitas += 1;
            await atualizarVenda(venda.id, { metaEnviadoEm: new Date().toISOString() }, venda);
          }
        }
        return json(res, 200, {
          success: true,
          data: { faltavam: faltando.length, tentadas: lote.length, aceitas },
        });
      }

      /*
       * ========================================================================
       * MARCAR COMO PAGA — quando o dinheiro entrou por fora do gateway
       * ========================================================================
       *
       * A ZuckPay só sabe do que passou por ela. Quando o PIX vence e a pessoa
       * paga por outro caminho — uma chave direta, um comprovante no WhatsApp —
       * a venda existe no mundo e não existe aqui. E o que se perde não é só o
       * número do painel:
       *
       *   A ENTREGA não sai, porque a fila do robô olha `status === completed`.
       *   Quem pagou fica esperando, e foi o dono quem recebeu o dinheiro.
       *
       *   O `Purchase` NÃO VAI AO META, e este é o caro. O clique foi pago, a
       *   venda aconteceu, e o robô do Meta não aprende com ela — o criativo
       *   fica com o custo e sem o resultado, e a otimização mira errado.
       *
       * POR QUE NÃO É UM BOTÃO PERIGOSO: ele não move dinheiro, não fala com o
       * gateway e não cria cobrança. Ele registra uma decisão de quem opera, e
       * exige o motivo por escrito — sem motivo, recusa. É a diferença entre um
       * registro de conciliação e um número inventado.
       *
       * IDEMPOTENTE de propósito: venda já paga devolve 200 sem mexer em nada.
       * Quem clica está com pressa, e clicar duas vezes não pode reescrever o
       * `pagoEm` de uma venda de verdade — é por ele que o Meta acha o clique.
       */
      const paraMarcarPago = caminho.match(/^\/admin\/orders\/([^/]+)\/pago$/);
      if (metodo === 'POST' && paraMarcarPago) {
        if (!memoriaLigada) return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado.');
        const id = decodeURIComponent(paraMarcarPago[1]);
        const corpo = await lerCorpo(req);
        const motivo = String(corpo.motivo ?? '').trim().slice(0, 200);
        if (!motivo) {
          return erro(res, 400, 'MOTIVO_OBRIGATORIO', 'Escreva de onde veio o pagamento — é o que separa conciliação de número inventado.');
        }

        const venda = await lerVenda(id);
        if (!venda) return erro(res, 404, 'NOT_FOUND', 'Pedido não encontrado.');
        if (venda.status === 'completed') {
          return json(res, 200, { success: true, data: { jaEstava: true, metaEnviado: Boolean(venda.metaEnviadoEm) } });
        }

        const agora = new Date().toISOString();
        await atualizarVenda(id, { status: 'completed', pagoEm: agora, pagoForaDoGateway: motivo }, venda);
        console.warn('[conciliacao] venda', id, 'marcada como paga a mao:', motivo);

        /*
         * O `Purchase` sai JUNTO, e não num segundo clique. O botão de reenviar
         * existe para a falha do Meta, não para completar um trabalho pela
         * metade — e uma venda marcada hoje e carimbada amanhã chega ao Meta
         * com a janela de atribuição do clique já fechando.
         */
        let metaAceitou = false;
        /*
         * MESMA TROCA DO BOTÃO DE REENVIAR (24/09/2026): basta UM destino vivo.
         * Com `metaLigado` sozinho aqui, marcar uma venda paga à mão com o Meta
         * fora fazia tudo — menos a única coisa que o robô do TikTok precisa
         * saber. A venda entrava no painel, entrava na fila de entrega, e a
         * plataforma que vendeu nunca ficava sabendo.
         */
        if (metaLigado || tiktokLigado) {
          metaAceitou = await enviarCompra({
            id: venda.id,
            valor: venda.valor,
            itensNeutros: venda.itens.map((i) => CODIGO_NEUTRO[i] ?? 'px'),
            email: venda.email,
            telefone: venda.telefone,
            nome: venda.nome,
            attrib: venda.attrib,
            criadoEm: venda.criadoEm,
            ua: venda.ua,
            ip: venda.ip,
            quando: Math.floor(Date.parse(agora) / 1000),
          });
          if (metaAceitou) await atualizarVenda(id, { metaEnviadoEm: new Date().toISOString() });
        }

        return json(res, 200, {
          success: true,
          /* `metaLigado` aqui responde "havia para onde mandar?" — é o que o
             painel usa para dizer se o evento saiu ou se não tinha destino. */
          data: { id, valor: venda.valor, nome: venda.nome, motivo, metaAceitou, metaLigado: metaLigado || tiktokLigado },
        });
      }

      /*
       * ========================================================================
       * APAGAR UM PEDIDO — e só um que nunca virou dinheiro
       * ========================================================================
       *
       * POR QUE ISTO EXISTE: em 06/09/2026 eu criei DOIS PIX de verdade
       * chamando `POST /orders` contra a chave viva, para conferir quais
       * ofertas o servidor aceitava. A regra que proíbe isso está escrita no
       * NOTAS.md em letra grande, e mesmo assim aconteceu — porque a chamada
       * parece uma consulta e é uma cobrança.
       *
       * Pedido de teste não some sozinho: ele fica `pending` para sempre (nada
       * consulta o status dele de novo), conta como PIX gerado no painel,
       * derruba a porcentagem de vendas atribuídas e entra na fila de lembrete
       * do WhatsApp. Ou seja: sujeira nos números sobre os quais se decide
       * escalar.
       *
       * ============================================================================
       * A TRAVA: VENDA PAGA NÃO SE APAGA, NUNCA
       * ============================================================================
       *
       * `completed` é o registro de que dinheiro entrou, e é dele que saem a
       * entrega, o `Purchase` e a conciliação. Um `if` de duas linhas aqui é o
       * que separa "limpar teste" de "sumir com a venda de um cliente que
       * pagou" — e quem for apagar vai estar com pressa, porque ninguém apaga
       * pedido com calma.
       *
       * O mesmo vale para quem já foi ao Meta: apagar o registro deixaria um
       * `Purchase` no Gerenciador sem contrapartida aqui.
       */
      const paraApagar = caminho.match(/^\/admin\/orders\/([^/]+)$/);
      if (metodo === 'DELETE' && paraApagar) {
        if (!memoriaLigada) return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado.');
        const id = decodeURIComponent(paraApagar[1]);
        const venda = await lerVenda(id);
        if (!venda) return erro(res, 404, 'NOT_FOUND', 'Pedido não encontrado.');
        if (venda.status === 'completed') {
          return erro(res, 409, 'PAID_ORDER', 'Este pedido está PAGO. Venda paga não se apaga.');
        }
        if (venda.metaEnviadoEm) {
          return erro(res, 409, 'SENT_TO_META', 'Este pedido já foi contado no Meta e não pode sumir daqui.');
        }
        if (!(await apagarVenda(id))) {
          return erro(res, 500, 'DELETE_FAILED', 'Não consegui apagar.');
        }
        console.warn('[memoria] pedido apagado pelo painel:', id, venda.status, venda.valor);
        return json(res, 200, { success: true, data: { id, status: venda.status } });
      }

      /*
       * ========================================================================
       * RESTAURAR VENDAS DE UM RETRATO — usada na migração de 06/09/2026
       * ========================================================================
       *
       * O armazenamento anterior foi suspenso com 17 vendas dentro e passou a
       * recusar toda leitura. Elas sobreviveram num retrato baixado antes da
       * suspensão, e é esse retrato que entra aqui.
       *
       * ELA NUNCA SOBRESCREVE O QUE JÁ EXISTE. Um retrato é, por definição,
       * VELHO: se uma venda já está aqui, ela sabe mais do que o arquivo — pode
       * ter sido paga, entregue ou já mandada ao Meta depois da foto. Restaurar
       * por cima desfaria isso em silêncio, que é o pior desfecho possível numa
       * rota cujo trabalho é justamente não perder venda.
       *
       * Por isso é idempotente: rodar duas vezes não muda nada na segunda.
       */
      /*
       * A MUDANÇA DE BANCO (13/10/2026). O Upstash grátis tem 500 mil operações
       * por mês; acabaram no meio de uma campanha, e o checkout passou a cair
       * metade das vezes ("max requests limit exceeded"). O banco foi para a
       * VPS do dono (/opt/banco-celestial), que fala a mesma língua REST.
       *
       * Esta rota copia UMA página de chaves do banco em que a função está
       * ligada para o destino dado no corpo, e devolve o cursor da próxima.
       * Quem chama repete até o cursor voltar a "0". Copia valor E validade,
       * tipo por tipo — inclusive a chave do gateway, que nenhuma rota devolve:
       * é por isso que a cópia é feita daqui de dentro, e não por fora.
       *
       * TUDO OU NADA POR PÁGINA: se qualquer leitura falhar (o banco antigo
       * recusa parte dos pedidos por causa do limite), a página responde 503
       * sem avançar, e quem chama repete. Gravar no destino é idempotente.
       * Pode sair do código quando o banco antigo for apagado.
       */
      if (metodo === 'POST' && caminho === '/admin/migrar-banco') {
        if (!memoriaLigada) return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado.');
        const corpo = await lerCorpo(req);
        const destino = String(corpo.destino ?? '').replace(/\/+$/, '');
        const senha = String(corpo.token ?? '');
        if (!/^https:\/\//.test(destino) || senha.length < 20) return erro(res, 400, 'DESTINO', 'Destino (https) e token são obrigatórios.');
        const falar = async (base: string, token: string, comandos: unknown[][]): Promise<unknown[] | null> => {
          try {
            const r = await fetch(`${base}/pipeline`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(comandos), cache: 'no-store', signal: AbortSignal.timeout(20000),
            });
            const lista = (await r.json().catch(() => null)) as Array<{ result?: unknown; error?: string }> | null;
            if (!r.ok || !Array.isArray(lista) || lista.length !== comandos.length || lista.some((x) => x?.error)) return null;
            return lista.map((x) => x?.result ?? null);
          } catch {
            return null;
          }
        };
        const daOrigem = (comandos: unknown[][]) => falar(REDIS_URL, REDIS_TOKEN, comandos);
        const recusa = (onde: string) => erro(res, 503, 'TENTE_DE_NOVO', `Falhou em: ${onde}. Nada avançou; repita com o mesmo cursor.`);

        const cursor = String(corpo.cursor ?? '0');
        const pagina = await daOrigem([['SCAN', cursor, 'COUNT', '150']]);
        const varredura = pagina?.[0] as [string, string[]] | null;
        if (!Array.isArray(varredura)) return recusa('SCAN');
        const [proximo, chaves] = varredura;
        if (chaves.length === 0) return json(res, 200, { success: true, data: { cursor: String(proximo), copiadas: 0 } });

        const meta = await daOrigem(chaves.flatMap((k) => [['TYPE', k], ['PTTL', k]]));
        if (!meta) return recusa('TYPE/PTTL');
        const LER: Record<string, (k: string) => unknown[]> = {
          string: (k) => ['GET', k], set: (k) => ['SMEMBERS', k], hash: (k) => ['HGETALL', k],
          list: (k) => ['LRANGE', k, '0', '-1'], zset: (k) => ['ZRANGE', k, '0', '-1', 'WITHSCORES'],
        };
        const tipos = chaves.map((_, i) => String(meta[i * 2] ?? ''));
        const vivas = chaves.map((k, i) => ({ k, tipo: tipos[i], ttl: Number(meta[i * 2 + 1] ?? -1) })).filter((c) => LER[c.tipo]);
        const valores = vivas.length ? await daOrigem(vivas.map((c) => LER[c.tipo](c.k))) : [];
        if (!valores) return recusa('leitura dos valores');

        const gravar: unknown[][] = [];
        vivas.forEach((c, i) => {
          const v = valores[i];
          if (v === null || (Array.isArray(v) && v.length === 0)) return;
          gravar.push(['DEL', c.k]);
          if (c.tipo === 'string') gravar.push(['SET', c.k, String(v)]);
          else if (c.tipo === 'set') gravar.push(['SADD', c.k, ...(v as string[])]);
          else if (c.tipo === 'hash') gravar.push(['HSET', c.k, ...(v as string[])]);
          else if (c.tipo === 'list') gravar.push(['RPUSH', c.k, ...(v as string[])]);
          else {
            const z = v as string[];
            const pares: string[] = [];
            for (let j = 0; j < z.length; j += 2) pares.push(z[j + 1], z[j]);
            gravar.push(['ZADD', c.k, ...pares]);
          }
          if (c.ttl > 0) gravar.push(['PEXPIRE', c.k, String(c.ttl)]);
        });
        if (gravar.length && !(await falar(destino, senha, gravar))) return recusa('gravação no destino');
        return json(res, 200, { success: true, data: { cursor: String(proximo), copiadas: vivas.length, ignoradas: chaves.length - vivas.length } });
      }

      if (metodo === 'POST' && caminho === '/admin/restaurar') {
        if (!memoriaLigada) return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado.');
        const corpo = await lerCorpo(req);
        const entrada = Array.isArray(corpo.vendas) ? (corpo.vendas as Venda[]) : [];
        if (entrada.length === 0) return erro(res, 400, 'EMPTY', 'Nenhuma venda no corpo.');

        let gravadas = 0;
        let jaExistiam = 0;
        let invalidas = 0;
        for (const v of entrada.slice(0, 500)) {
          if (!v || typeof v.id !== 'string' || !v.id || typeof v.valor !== 'number') {
            invalidas += 1;
            continue;
          }
          if (await lerVenda(v.id)) {
            jaExistiam += 1;
            continue;
          }
          await gravarVenda(v);
          gravadas += 1;
        }
        console.warn('[memoria] restauração:', gravadas, 'gravadas,', jaExistiam, 'já existiam');
        return json(res, 200, { success: true, data: { gravadas, jaExistiam, invalidas } });
      }

      /*
       * OS GATEWAYS DE PIX — os campos e o interruptor de cada cartão do
       * painel. `s` é a SpyPag e `z` é a ZuckPay: letras, porque o nome não
       * pode ir para o bundle (ver INTEGRACOES em PainelAdmin.tsx).
       *
       * O SECRET SÓ ENTRA, NUNCA SAI: a leitura devolve os quatro últimos
       * caracteres. Secret vazio no POST MANTÉM o salvo — a tela não tem como
       * reenviar o que nunca recebeu, e "salvar a URL" não pode apagar a chave.
       *
       * LIGAR TESTA A CHAVE ANTES, e DESLIGA O OUTRO. Interruptor ligado com
       * chave errada é o checkout inteiro devolvendo "o banco não respondeu"
       * para todo mundo; dois ligados deixariam a dúvida de quem está cobrando.
       */
      const rotaDoGateway = caminho.match(/^\/admin\/gateways\/(s|z|p|g|b)$/);
      if (rotaDoGateway) {
        const porLetra: Record<string, IdGateway> = { s: 'spypag', z: 'zuckpay', p: 'pagouai', g: 'pingupag', b: 'beehive' };
        const id: IdGateway = porLetra[rotaDoGateway[1]];
        const outros = TODOS_OS_GATEWAYS.filter((g) => g !== id);
        const resumo = async (c: ConfigGateway) => {
          let outroPronto = false;
          for (const g of outros) if (gatewayPronto(g, await lerGateway(g, true))) outroPronto = true;
          return {
            url: c.url,
            clientId: c.clientId,
            temSecret: Boolean(c.token),
            finalDoSecret: c.token ? c.token.slice(-4) : '',
            ligado: c.ligado,
            pronto: gatewayPronto(id, c),
            urlDoAviso: urlDoAviso(id, c),
            semEnderecoPublico: !montarUrlDoWebhook(id),
            outroPronto,
            atualizadoEm: c.atualizadoEm,
          };
        };
        if (metodo === 'GET') return json(res, 200, { success: true, data: await resumo(await lerGateway(id, true)) });
        if (metodo !== 'POST') return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');

        const corpo = await lerCorpo(req);
        const atual = await lerGateway(id, true);
        const urlNova = 'url' in corpo ? urlDaApi(id, corpo.url) : atual.url;
        if (!urlNova) return erro(res, 400, 'BAD_URL', 'A URL tem de começar com https://', 'url');
        const secretNovo = String(corpo.secret ?? '').trim();
        const novo: ConfigGateway = {
          url: urlNova,
          clientId: 'clientId' in corpo ? String(corpo.clientId ?? '').trim().slice(0, 200) : atual.clientId,
          token: secretNovo ? secretNovo.slice(0, 500) : atual.token,
          ligado: 'ligado' in corpo ? corpo.ligado === true : atual.ligado,
          atualizadoEm: new Date().toISOString(),
        };

        if (novo.ligado) {
          const falta = [
            !SEM_CLIENT_ID.has(id) && !novo.clientId && 'o Client ID',
            !novo.token && 'o Secret',
            !montarUrlDoWebhook(id) && 'PUBLIC_BASE_URL na Vercel (sem ela o aviso de pagamento não tem endereço)',
          ].filter(Boolean);
          if (falta.length) return erro(res, 400, 'INCOMPLETE', `Para ligar, falta ${falta.join(' e ')}.`);
          const teste = await testarChave(id, novo);
          if (!teste.ok) {
            return erro(res, 400, 'KEY_REFUSED', `Não liguei: ${teste.motivo} Nada mudou no checkout.`);
          }
        }

        if (!(await gravarGateway(id, novo))) {
          return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado, não dá para salvar.');
        }
        /* Só DEPOIS de este gravar: se a gravação falhasse, desligar o outro
           deixaria o checkout sem gateway nenhum. */
        if (novo.ligado) {
          for (const outro of outros) {
            const doOutro = await lerGateway(outro, true);
            if (doOutro.ligado) {
              await gravarGateway(outro, { ...doOutro, ligado: false, atualizadoEm: new Date().toISOString() });
            }
          }
        }
        console.warn(`[${id}] configuracao salva pelo painel. ligado:`, novo.ligado, 'pronto:', gatewayPronto(id, novo));
        return json(res, 200, { success: true, data: await resumo(novo) });
      }

      /*
       * OS PIXELS DO TIKTOK A MAIS — ver VÁRIOS PIXELS DO TIKTOK, no topo.
       *
       * GET lista (sem token nenhum, só os 4 últimos caracteres). POST com
       * `apagar: true` tira um; POST sem isso cadastra ou atualiza — token
       * vazio MANTÉM o salvo, como no Secret dos gateways.
       */
      if (caminho === '/admin/tiktok-pixels') {
        const base = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
        const resumo = (lista: PixelTikTok[]) => ({
          principal: { id: TIKTOK_PIXEL_ID, temToken: Boolean(TIKTOK_TOKEN), link: base ? `${base}/` : '' },
          pixels: lista.map((x) => ({
            id: x.id,
            nome: x.nome,
            temToken: Boolean(x.token),
            finalDoToken: x.token ? x.token.slice(-4) : '',
            criadoEm: x.criadoEm,
            link: base ? `${base}/?tt=${x.id}` : '',
          })),
        });
        if (metodo === 'GET') return json(res, 200, { success: true, data: resumo(await lerPixelsTikTok(true)) });
        if (metodo !== 'POST') return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');

        const corpo = await lerCorpo(req);
        const id = String(corpo.id ?? '').trim().toUpperCase();
        if (!ID_DE_PIXEL_TIKTOK.test(id)) {
          return erro(res, 400, 'BAD_PIXEL', 'O ID do pixel tem só letras e números (uns 20 caracteres). Copie do Events Manager do TikTok.', 'id');
        }
        const atuais = await lerPixelsTikTok(true);

        if (corpo.apagar === true) {
          const sobra = atuais.filter((x) => x.id !== id);
          if (!(await gravarPixelsTikTok(sobra))) return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado, não dá para salvar.');
          console.warn('[tiktok] pixel removido pelo painel:', id);
          return json(res, 200, { success: true, data: resumo(sobra) });
        }

        if (id === TIKTOK_PIXEL_ID) {
          return erro(res, 400, 'IS_MAIN', 'Esse já é o pixel principal — ele recebe quem chega sem ?tt= no link.', 'id');
        }
        const existente = atuais.find((x) => x.id === id);
        const tokenNovo = String(corpo.token ?? '').trim();
        const token = tokenNovo ? tokenNovo.slice(0, 500) : (existente?.token ?? '');
        if (!token) return erro(res, 400, 'INCOMPLETE', 'Falta o token de acesso (Events API) deste pixel.', 'token');
        if (!existente && atuais.length >= 30) return erro(res, 400, 'TOO_MANY', 'São 30 pixels no máximo.');

        const teste = tokenNovo ? await testarTokenTikTok(id, token) : { ok: true as const, aviso: undefined };
        if (!teste.ok) return erro(res, 400, 'TOKEN_REFUSED', `Não salvei: ${teste.aviso}`, 'token');

        const novo: PixelTikTok = {
          id,
          token,
          nome: 'nome' in corpo ? String(corpo.nome ?? '').trim().slice(0, 60) : (existente?.nome ?? ''),
          criadoEm: existente?.criadoEm || new Date().toISOString(),
        };
        const lista = existente ? atuais.map((x) => (x.id === id ? novo : x)) : [...atuais, novo];
        if (!(await gravarPixelsTikTok(lista))) return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado, não dá para salvar.');
        console.warn('[tiktok] pixel salvo pelo painel:', id, '| total a mais:', lista.length);
        return json(res, 200, { success: true, data: { ...resumo(lista), aviso: teste.aviso ?? null } });
      }

      /*
       * O AVISO NO CELULAR — a URL e os dois interruptores. A URL só entra:
       * a leitura devolve o domínio e o fim dela. `testar: true` manda um aviso
       * de teste para a URL salva (ou para a que veio junto) e diz se chegou.
       */
      /*
       * A LISTA DE LEADS. `comprou` é calculado na hora, cruzando o telefone com
       * as vendas: gravar no lead envelheceria no instante seguinte.
       */
      if (metodo === 'GET' && caminho === '/admin/leads') {
        const [leads, vendas] = await Promise.all([listarLeads(), listarVendas()]);
        const porTelefone = new Map<string, { pagou: boolean; gerouPix: boolean }>();
        for (const v of vendas) {
          const tel = telefoneSemDdi(String(v.telefone ?? ''));
          if (!tel) continue;
          const atual = porTelefone.get(tel) ?? { pagou: false, gerouPix: false };
          atual.gerouPix = true;
          if (v.status === 'completed') atual.pagou = true;
          porTelefone.set(tel, atual);
        }
        const lista = leads.map((l) => ({
          ...l,
          gerouPix: porTelefone.get(l.telefone)?.gerouPix === true,
          comprou: porTelefone.get(l.telefone)?.pagou === true,
          grupo: grupoDoLead(l, porTelefone.get(l.telefone)),
        }));
        const noGrupo = (g: GrupoDoLead) => lista.filter((l) => l.grupo === g).length;
        /* Os passos do funil novo nos últimos 7 dias: em qual tela as pessoas saem. */
        const hoje = diaSP(0);
        const passos = await funilDoIntervalo(menos(hoje, 6), hoje, 'novo');
        return json(res, 200, {
          success: true,
          data: {
            passos,
            /* Quantos em cada grupo de mensagem — ver `grupoDoLead`. */
            grupos: { antes: noGrupo('antes'), checkout: noGrupo('checkout'), pix: noGrupo('pix'), comprou: noGrupo('comprou') },
            total: lista.length,
            comPix: lista.filter((l) => l.gerouPix).length,
            compraram: lista.filter((l) => l.comprou).length,
            leads: lista.slice(0, 2000),
          },
        });
      }

      if (caminho === '/admin/notificacoes') {
        const resumo = (c: ConfigNotificacoes) => {
          let dominio = '';
          try {
            dominio = c.url ? new URL(c.url).hostname : '';
          } catch {
            dominio = '';
          }
          return {
            temUrl: Boolean(c.url),
            dominio,
            finalDaUrl: c.url ? c.url.slice(-6) : '',
            pixGerado: c.pixGerado,
            vendaPaga: c.vendaPaga,
            atualizadoEm: c.atualizadoEm,
          };
        };
        if (metodo === 'GET') return json(res, 200, { success: true, data: resumo(await lerNotificacoes(true)) });
        if (metodo !== 'POST') return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');

        const corpo = await lerCorpo(req);
        const atual = await lerNotificacoes(true);
        let url = atual.url;
        if (corpo.apagarUrl === true) url = '';
        const urlNova = String(corpo.url ?? '').trim();
        if (urlNova) {
          try {
            if (new URL(urlNova).protocol !== 'https:') throw new Error('http');
          } catch {
            return erro(res, 400, 'BAD_URL', 'A URL tem de começar com https://', 'url');
          }
          url = urlNova.slice(0, 600);
        }
        const novo: ConfigNotificacoes = {
          url,
          pixGerado: 'pixGerado' in corpo ? corpo.pixGerado === true : atual.pixGerado,
          vendaPaga: 'vendaPaga' in corpo ? corpo.vendaPaga === true : atual.vendaPaga,
          atualizadoEm: new Date().toISOString(),
        };
        if (!(await gravarNotificacoes(novo))) {
          return erro(res, 503, 'NO_STORAGE', 'Sem armazenamento configurado, não dá para salvar.');
        }
        let teste: { ok: boolean; motivo?: string } | null = null;
        if (corpo.testar === true) {
          if (!novo.url) return erro(res, 400, 'INCOMPLETE', 'Falta a URL de notificação.', 'url');
          teste = await mandarNotificacao(novo.url, 'Teste do painel', 'Se você está lendo isto, os avisos de venda vão chegar aqui.');
        }
        return json(res, 200, { success: true, data: { ...resumo(novo), teste } });
      }

      /* As taxas e as despesas do dono. Ver `lerConfig` para o porquê do arquivo. */
      if (caminho === '/admin/config') {
        if (metodo === 'GET') return json(res, 200, { success: true, data: await lerConfig() });
        if (metodo === 'POST') {
          const corpo = await lerCorpo(req);
          const atual = await lerConfig();
          /*
           * CAMPO AUSENTE MANTÉM O QUE ESTAVA; campo presente e vazio APAGA.
           * A tela manda o formulário inteiro, então "vazio" ali é uma decisão
           * de quem digitou -- e apagar a taxa tem de ser possível, senão não
           * há como voltar o painel a dizer "configure" depois de um engano.
           */
          const novo: ConfigDoPainel = {
            taxaPct: 'taxaPct' in corpo ? numeroOuNulo(corpo.taxaPct) : atual.taxaPct,
            impostoPct: 'impostoPct' in corpo ? numeroOuNulo(corpo.impostoPct) : atual.impostoPct,
            custoPorVenda: 'custoPorVenda' in corpo ? numeroOuNulo(corpo.custoPorVenda) : atual.custoPorVenda,
            impostoAdsPct: 'impostoAdsPct' in corpo ? numeroOuNulo(corpo.impostoAdsPct) : atual.impostoAdsPct,
            breakEvenRoas: 'breakEvenRoas' in corpo ? numeroOuNulo(corpo.breakEvenRoas) : atual.breakEvenRoas,
            despesas: Array.isArray(corpo.despesas)
              ? (corpo.despesas as ConfigDoPainel['despesas'])
                  .slice(0, 300)
                  .map((d) => ({
                    id: String(d?.id ?? '').slice(0, 40) || `d${Math.random().toString(36).slice(2, 10)}`,
                    descricao: String(d?.descricao ?? '').slice(0, 120),
                    valor: numeroOuNulo(d?.valor) ?? 0,
                    de: String(d?.de ?? '').slice(0, 10),
                    ate: String(d?.ate ?? d?.de ?? '').slice(0, 10),
                  }))
              : atual.despesas,
            atualizadoEm: new Date().toISOString(),
          };
          const gravou = await gravarConfig(novo);
          if (!gravou) {
            return erro(
              res,
              503,
              'NO_STORAGE',
              'Sem armazenamento configurado, não dá para salvar. Os valores continuam vindo das variáveis de ambiente.',
            );
          }
          return json(res, 200, { success: true, data: novo });
        }
        return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      }

      if (metodo !== 'GET' || caminho !== '/admin/orders') {
        return erro(res, 404, 'NOT_FOUND', 'Rota não encontrada.');
      }

      /*
       * O PERÍODO VEM NA URL e é resolvido AQUI. `?periodo=7d`, `?periodo=ontem`,
       * ou `?periodo=2026-09-01:2026-09-06`.
       *
       * Resolver no servidor é o que garante uma régua só: as vendas são
       * filtradas pelo mesmo intervalo que o Meta recebe em `time_range`. Com o
       * navegador decidindo, o relógio do visitante entraria na conta.
       */
      const periodo = resolverPeriodo(url.searchParams.get('periodo') ?? 'hoje');
      const comparar = url.searchParams.get('comparar') === '1';
      /*
       * `?funil=quiz` ou `?funil=pedido` MOSTRA UM FUNIL SÓ (03/10/2026). Sem o
       * parâmetro (ou com qualquer outra coisa) vêm os dois somados, como sempre.
       *
       * O filtro corta TRÊS coisas pela mesma régua, senão os números da tela
       * discordam entre si: as vendas (`funil` da venda), as visitas do funil
       * do site (conjuntos próprios do Redis) e o GASTO (pelo funil para onde
       * cada anúncio manda gente — ver `funisDosAds`).
       */
      const funilPedido = url.searchParams.get('funil');
      const filtroFunil: Funil | '' =
        funilPedido === 'quiz' || funilPedido === 'pedido' || funilPedido === 'novo' || funilPedido === 'sinais' ? funilPedido : '';

      /*
       * O FUNIL DE HOJE E O DE ONTEM, NA MESMA RESPOSTA.
       *
       * Sozinho, o numero de hoje nao diz nada -- as 9h da manha ele sempre
       * parece ruim. O de ontem e a regua que falta para o dono saber se o dia
       * esta indo bem sem ter que lembrar de cabeca.
       *
       * TUDO EM PARALELO. São nove descidas: sequenciais, elas estourariam os
       * 20 s da função; juntas, o custo é o da mais lenta.
       */
      const [
        todasAsVendasBrutas,
        funilHoje,
        funilOntem,
        gastoBruto,
        gastoAnteriorBruto,
        entidades,
        conta,
        config,
        podeGerenciar,
        capiViva,
        gastoTkBruto,
        entidadesTk,
        funilDoSite,
        doCartaoBruto,
      ] = await Promise.all([
        listarVendas(),
        funilDoDia(diaDeHoje(), filtroFunil),
        funilDoDia(diaDeHoje(new Date(Date.now() - 86_400_000)), filtroFunil),
        gastoPorAnuncio(periodo.de, periodo.ate),
        /*
         * O período anterior só é buscado quando alguém pediu a comparação.
         * São 9 s de teto por chamada ao Meta; pedir dois sempre dobraria a
         * espera de quem só quer ver o dia.
         */
        comparar ? gastoPorAnuncio(periodo.anteriorDe, periodo.anteriorAte) : Promise.resolve([]),
        entidadesDoMeta(),
        contaDeAnuncios(),
        lerConfig(),
        podeGerenciarAnuncios(),
        capiResponde(),
        /* O TikTok entra na mesma leva paralela: custa o tempo da mais lenta, não a soma. */
        gastoPorAnuncioTikTok(periodo.de, periodo.ate),
        entidadesDoTikTok(),
        /* O funil que não depende de rede nenhuma — ver `funilDoIntervalo`. */
        funilDoIntervalo(periodo.de, periodo.ate, filtroFunil),
        /* O cartão, direto da Kiwify. Ver `vendasDaKiwify`. */
        vendasDaKiwify(periodo.de, periodo.ate),
      ]);

      /*
       * O CARTÃO ENTRA NA MESMA LISTA, e quem já está no Redis ganha.
       *
       * A mesma venda pode chegar por dois caminhos — o webhook gravou quando
       * ela foi paga, e a API a devolve de novo a cada leitura do painel. Os
       * dois usam o id `kw-<order_id>`, então basta preferir o gravado: é ele
       * que tem o carimbo de `Purchase` enviado (`metaEnviadoEm`) e o carimbo
       * de entrega no WhatsApp, que a API da Kiwify não conhece.
       */
      /*
       * O CORTE POR FUNIL, num lugar só — tudo abaixo usa os nomes de sempre.
       *
       * Venda sem `funil` é do quiz: o campo nasceu em 03/10/2026 e tudo o que
       * veio antes era quiz. O cartão (Kiwify) também: o /pedido só cobra por
       * PIX. Anúncio sem registro de funil conta como quiz pelo mesmo motivo —
       * e passa a ser do pedido assim que a primeira visita dele chegar por lá.
       */
      /*
       * A TAXA REAL DAS VENDAS QUE FICARAM SEM ELA (03/10/2026).
       *
       * O líquido é gravado quando o aviso de pagamento chega. As vendas pagas
       * ANTES de isso existir, e as de um aviso que respondeu sem o campo,
       * ficariam para sempre na estimativa. Aqui o painel pergunta à Pagou.ai
       * uma vez por venda e grava a resposta.
       *
       * CINCO POR LEITURA, e cada venda só é tentada uma vez por instância: sem
       * o teto, um dia de vendas viraria dezenas de idas ao gateway a cada
       * abertura do painel; sem a marca, uma venda que nunca devolve a taxa
       * seria perguntada de novo para sempre.
       */
      const semLiquido = todasAsVendasBrutas
        .filter((v) => v.gateway === 'pagouai' && v.status === 'completed' && v.valorLiquido == null && !jaTentouLiquido.has(v.id))
        .slice(0, 5);
      if (semLiquido.length) {
        const doP = await lerGateway('pagouai');
        if (doP.token) {
          await Promise.all(
            semLiquido.map(async (v) => {
              jaTentouLiquido.add(v.id);
              const r = await chamarGateway('pagouai', doP, `/v2/transactions/${encodeURIComponent(v.id)}`, { metodo: 'GET' });
              const liquido = r.ok ? acharValorLiquido(r.dados.data, v.valor) : null;
              if (liquido !== null) {
                v.valorLiquido = liquido;
                await atualizarVenda(v.id, { valorLiquido: liquido }, v);
              }
            }),
          );
        }
      }

      const doFunil = (v: Venda): boolean => !filtroFunil || (v.funil ?? 'quiz') === filtroFunil;
      const todasAsVendas = todasAsVendasBrutas.filter(doFunil);
      const doCartao = filtroFunil && FUNIS_A_PARTE.includes(filtroFunil) ? [] : doCartaoBruto;
      const mapaDeFunis = filtroFunil
        ? await funisDosAds([...gastoBruto, ...gastoAnteriorBruto, ...gastoTkBruto].map((g) => g.adId))
        : new Map<string, Funil>();
      const adDoFunil = (g: { adId: string }): boolean => !filtroFunil || (mapaDeFunis.get(idDoAd(g.adId)) ?? 'quiz') === filtroFunil;
      const gasto = gastoBruto.filter(adDoFunil);
      const gastoAnterior = gastoAnteriorBruto.filter(adDoFunil);
      const gastoTk = gastoTkBruto.filter(adDoFunil);

      const jaGravadas = new Set(todasAsVendas.map((v) => v.id));
      const vendasComCartao = [...todasAsVendas, ...doCartao.filter((v) => !jaGravadas.has(v.id))];

      const custos = custosDe(config, periodo.de, periodo.ate);
      const doPeriodo = vendasDoIntervalo(vendasComCartao, periodo.de, periodo.ate);
      /*
       * CADA REDE SÓ VÊ A VENDA QUE É DELA. Venda com ttclid (ou utm_source=
       * tiktok) sai das linhas do Meta — senão, com utm_content na URL do
       * TikTok, ela viraria "anúncio que vendeu sem gasto" com id do TikTok na
       * tabela do Meta — e entra nas linhas do TikTok. Nos TOTAIS do topo ela
       * continua contando, como "sem anúncio Meta": o faturamento do Resumo
       * tem de bater com o do gateway, venha a venda de onde vier.
       */
      const doPeriodoTk = doPeriodo.filter((v) => veioDoTikTok(v.attrib));
      const doPeriodoMeta = doPeriodo.filter((v) => !veioDoTikTok(v.attrib));
      const orfas = doPeriodo.filter((v) => !adIdDaVenda(v) || veioDoTikTok(v.attrib));
      const linhas = juntarGastoComVendas(gasto, doPeriodoMeta, entidades);
      const linhasTk = juntarGastoComVendas(gastoTk, doPeriodoTk, entidadesTk);
      /* Venda do TikTok sem utm_content=__CID__ na URL do anúncio: conta no total do TikTok, mas em criativo nenhum. */
      const orfasTk = doPeriodoTk.filter((v) => !adIdDaVenda(v));

      /*
       * O PERÍODO ANTERIOR TAMBÉM PRECISA DO CARTÃO. Sem isto a comparação
       * mentiria para os dois lados: hoje somando cartão + PIX, ontem só PIX —
       * e toda semana pareceria um crescimento que não houve.
       */
      const cartaoAnterior =
        comparar && !(filtroFunil && FUNIS_A_PARTE.includes(filtroFunil)) ? await vendasDaKiwify(periodo.anteriorDe, periodo.anteriorAte) : [];

      const anterior = comparar
        ? (() => {
            const base = [...todasAsVendas, ...cartaoAnterior.filter((x) => !jaGravadas.has(x.id))];
            const v = vendasDoIntervalo(base, periodo.anteriorDe, periodo.anteriorAte);
            const l = juntarGastoComVendas(gastoAnterior, v.filter((x) => !veioDoTikTok(x.attrib)), entidades);
            return totalizar(
              l,
              v.filter((x) => !adIdDaVenda(x) || veioDoTikTok(x.attrib)),
              custosDe(config, periodo.anteriorDe, periodo.anteriorAte),
            );
          })()
        : null;

      return json(res, 200, {
        success: true,
        data: {
          memoria: memoriaLigada,
          meta: metaLigado,
          /* O que a tela pediu, devolvido: é por ele que o seletor sabe o que está mostrando. */
          funilSelecionado: filtroFunil,
          integracoes: {
            /* A chave da integracao e neutra de proposito: o nome do gateway nao
             * pode entrar no bundle. Ver o comentario de INTEGRACOES no painel. */
            gateway: Boolean(await gatewayAtivo()),
            memoria: memoriaLigada,
            /*
             * "LIGADA" AQUI SIGNIFICA QUE RESPONDE, e não que a variável
             * existe. Ver `ultimoErroDoMeta`: em 06/09/2026 as duas variáveis
             * estavam certas e toda chamada voltava "API access blocked" — o
             * painel mostrava verde com gasto zero, e o defeito parecia um dia
             * parado.
             */
            metaPurchase: metaLigado && capiViva,
            metaGasto: adsLigado && !ultimoErroDoMeta.ads,
            tiktokGasto: tiktokAdsLigado && !ultimoErroDoTikTok,
            whatsapp: Boolean((process.env.WHATSAPP_TOKEN ?? '').trim()),
            /* Sem webhook, o Purchase depende do navegador de quem comprou. */
            webhook: Boolean(URL_DO_WEBHOOK),
            entregaUpsell: ofertaEntregavel('upsell'),
            entregaPrincipal: ofertaEntregavel('main'),
            /* O banner de "configuração incompleta" some quando este for true. */
            custos: config.taxaPct !== null && config.impostoPct !== null,
          },
          /* Sem `ads_management`, o interruptor da tabela nasce desligado. */
          podeGerenciar,
          /* O que o Meta respondeu quando recusou. Vai inteiro para a tela. */
          metaErro: ultimoErroDoMeta,
          /*
           * "Nao ha venda" e "nao consegui ler as vendas" sao coisas MUITO
           * diferentes e apareciam iguais na tela. Agora a tela sabe.
           */
          armazenamento: ultimaListagem,
          /*
           * QUANTAS VENDAS PAGAS O META NUNCA RECEBEU — de todas, não só do
           * período. Uma venda de três dias atrás que ficou para trás continua
           * valendo: ela é atribuição perdida, e o Meta aceita evento antigo.
           * O painel mostra o número e o botão de reenviar.
           */
          purchaseFaltando: {
            quantas: todasAsVendas.filter((v) => v.status === 'completed' && !v.metaEnviadoEm).length,
            valor: todasAsVendas
              .filter((v) => v.status === 'completed' && !v.metaEnviadoEm)
              .reduce((s, v) => s + (v.valor ?? 0), 0),
          },
          config,
          conta,
          periodo: {
            de: periodo.de,
            ate: periodo.ate,
            dias: periodo.dias,
            anteriorDe: periodo.anteriorDe,
            anteriorAte: periodo.anteriorAte,
          },
          totais: totalizar(linhas, orfas, custos),
          anterior,
          /*
           * ====================================================================
           * O FUNIL DE CONVERSÃO — cinco etapas, e SÓ o tráfego do Meta
           * ====================================================================
           *
           * `totalizar(linhas, [], ...)` e não `totais`: a lista de órfãs vai
           * VAZIA de propósito. Venda sem carimbo de anúncio não pertence a um
           * card chamado "Meta Ads" — ela entrou por caminho que este funil não
           * mede, e enfiá-la no fim faria a última etapa ser maior do que a
           * quarta em dia de venda orgânica. Órfã aparece em "Vendas por fonte".
           *
           * DE ONDE VEM CADA ETAPA, porque são duas fontes:
           *
           *   1. Cliques      Meta, `inline_link_clicks`
           *   2. Vis. Página  Meta, `landing_page_view`
           *   3. ICs          Meta, `initiate_checkout`
           *   4. Vendas inic. NOSSO registro — pedidos criados com ad_id
           *   5. Vendas apr.  NOSSO registro — os que foram pagos
           *
           * AS TRÊS PRIMEIRAS SÃO DO META E AS DUAS ÚLTIMAS SÃO NOSSAS, e isso
           * tem consequência: o Meta credita pela JANELA DE ATRIBUIÇÃO dele
           * (clique de 7 dias), e nós creditamos pelo carimbo que veio na URL.
           * São réguas parecidas, não idênticas. Por isso a etapa 3 pode vir
           * maior do que a soma dos nossos pedidos sem que nada esteja quebrado
           * — e por isso a tela diz de onde cada número saiu.
           *
           * O CLIQUE É O DO LINK, e não o `clicks` cru. `clicks` conta curtida,
           * comentário e "ver mais" (894 contra 868 em 30 dias): um funil que
           * começa neles perde gente que nunca teve intenção de sair do
           * Facebook, e a primeira queda vira ficção.
           */
          funilMeta: (() => {
            /*
             * `orfas` ENTRA AQUI, e a ausência dela já custou uma confusão: em
             * 08/09/2026 o cartão do topo dizia 4 vendas aprovadas e o funil
             * dizia 3, no mesmo período e na mesma tela. Duas contagens da
             * mesma coisa é a armadilha que o painel inteiro existe para não
             * ter — o dono não tem como saber qual das duas acreditar, e o
             * número menor parece um problema de conversão que não existe.
             *
             * A venda que faltava tinha `fbc` e não tinha `utm_content`: veio
             * de um clique em anúncio, e perdeu o carimbo no caminho (link
             * encaminhado, app que reescreve a URL, teclado que colou só parte).
             * Ela é do funil do Meta tanto quanto as outras; o que ela não tem
             * é a qual CRIATIVO pertence — e por isso continua fora das linhas
             * por anúncio, onde inventá-la creditaria o criativo errado.
             *
             * AS TRÊS PRIMEIRAS ETAPAS NÃO MUDAM: cliques, lpViews e ics saem
             * de `linhas`, que são as métricas do Meta. Órfã não tem anúncio,
             * então soma zero nelas — é a MESMA `totalizar` do cartão do topo,
             * com os mesmos argumentos, e agora os dois números não têm como
             * discordar.
             */
            const t = totalizar(linhas, orfas, custos);
            return {
              cliques: t.cliquesNoLink,
              lpViews: t.lpViews,
              ics: t.ics,
              vendasIniciadas: t.pix,
              vendasAprovadas: t.pagas,
            };
          })(),
          /*
           * As três hierarquias saem da MESMA base, somadas no servidor. A tela
           * troca de aba sem pedir nada de novo -- e sem risco de somar diferente
           * do que a linha de cima mostra.
           */
          anuncios: linhas.map((l) => comDerivados(l, custos)),
          conjuntos: agrupar(linhas, 'conjunto', entidades).map((l) => comDerivados(l, custos)),
          campanhas: agrupar(linhas, 'campanha', entidades).map((l) => comDerivados(l, custos)),
          /*
           * A ÁREA TIKTOK: as mesmas três hierarquias, pelas MESMAS funções —
           * ROAS, CPA e lucro por linha saem de `comDerivados`, nunca de conta
           * própria. As despesas avulsas ficam FORA do total desta área: são do
           * período inteiro, e cobrá-las de cada rede as contaria duas vezes.
           */
          tiktok: {
            ligado: tiktokAdsLigado,
            erro: ultimoErroDoTikTok,
            advertiserId: TIKTOK_ADVERTISER_ID,
            anuncios: linhasTk.map((l) => ({ ...comDerivados(l, custos), plataforma: 'tiktok' })),
            conjuntos: agrupar(linhasTk, 'conjunto', entidadesTk).map((l) => ({ ...comDerivados(l, custos), plataforma: 'tiktok' })),
            campanhas: agrupar(linhasTk, 'campanha', entidadesTk).map((l) => ({ ...comDerivados(l, custos), plataforma: 'tiktok' })),
            totais: totalizar(linhasTk, orfasTk, { ...custos, despesas: 0 }),
            semCarimbo: orfasTk.length,
          },
          /*
           * ====================================================================
           * O CARTÃO — a aba que existe porque R$ 638,54 estavam invisíveis
           * ====================================================================
           *
           * ESTES NÚMEROS NÃO SÃO UM SEGUNDO FATURAMENTO. As mesmas vendas já
           * estão em `totais`, em `utms`, nas linhas do Meta e nas do TikTok —
           * desde que entraram em `vendasComCartao`. Este bloco é um RECORTE,
           * para responder o que só o cartão responde: quanto foi recusado, por
           * quê, e em quantas vezes a pessoa parcelou.
           *
           * A RECUSA É O NÚMERO QUE IMPORTA AQUI. Medido em 19/09/2026: 12 de
           * 27 tentativas negadas — 44%, R$ 595,45 que não entraram. Destes,
           * quatro eram `duplicate_link_order_email`, que é regra da Kiwify e
           * não do banco: a pessoa tentou pagar de novo com outro cartão e foi
           * barrada. Esse é o único dos motivos que está na mão do dono, e é
           * por isso que o motivo aparece na tela em vez de virar só um total.
           */
          cartao: (() => {
            const doCartaoNoPeriodo = doPeriodo.filter((v) => v.pagamento === 'cartao');
            const pagasC = doCartaoNoPeriodo.filter((v) => v.status === 'completed');
            const recusadasC = doCartaoNoPeriodo.filter((v) => v.status === 'refused');
            const motivos: Record<string, { quantas: number; valor: number }> = {};
            for (const v of recusadasC) {
              const m = v.cartaoRecusa ?? 'sem motivo informado';
              motivos[m] = motivos[m] ?? { quantas: 0, valor: 0 };
              motivos[m].quantas++;
              motivos[m].valor += v.valor;
            }
            const parcelas: Record<string, number> = {};
            for (const v of pagasC) {
              const p = v.parcelas ? `${v.parcelas}x` : '—';
              parcelas[p] = (parcelas[p] ?? 0) + 1;
            }
            const tentativas = pagasC.length + recusadasC.length;
            return {
              ligado: kiwifyApiLigada,
              erro: ultimoErroDaKiwify,
              /*
               * QUANTAS PESSOAS FORAM PARA A KIWIFY — o número que faltava.
               * `cliques` são sessões distintas que tocaram no botão do cartão
               * (contagem nossa, `ETAPAS_VALIDAS`); `abriramCheckout` é a etapa
               * anterior, para dar a proporção. Sem os dois lado a lado não dá
               * para saber se o cartão ajuda ou se só desvia quem pagaria PIX.
               */
              cliques: funilDoSite.cartao ?? 0,
              abriramCheckout: funilDoSite.checkout ?? 0,
              vendas: doCartaoNoPeriodo,
              pagas: pagasC.length,
              faturamento: pagasC.reduce((s, v) => s + v.valor, 0),
              liquido: pagasC.reduce((s, v) => s + (v.valorLiquido ?? 0), 0),
              recusadas: recusadasC.length,
              perdido: recusadasC.reduce((s, v) => s + v.valor, 0),
              taxaDeRecusa: tentativas ? recusadasC.length / tentativas : 0,
              motivos,
              parcelas,
              /* Por origem, só do cartão — é a pergunta "o TikTok vende no cartão?". */
              porOrigem: porUtm(doCartaoNoPeriodo, 'origem').map((l) => comDerivados(l, custos)),
              porCampanha: porUtm(doCartaoNoPeriodo, 'campanha').map((l) => comDerivados(l, custos)),
            };
          })(),
          /* Os mesmos números por origem de tráfego, do nosso lado do funil. */
          utms: {
            origem: porUtm(doPeriodo, 'origem').map((l) => comDerivados(l, custos)),
            campanha: porUtm(doPeriodo, 'campanha').map((l) => comDerivados(l, custos)),
            conjunto: porUtm(doPeriodo, 'conjunto').map((l) => comDerivados(l, custos)),
            criativo: porUtm(doPeriodo, 'criativo').map((l) => comDerivados(l, custos)),
            termo: porUtm(doPeriodo, 'termo').map((l) => comDerivados(l, custos)),
          },
          funil: { hoje: funilHoje, ontem: funilOntem, dia: diaDeHoje() },
          /*
           * O FUNIL DO SITE NO PERÍODO ESCOLHIDO. É o que o Resumo desenha
           * desde 18/09: uma régua só, do primeiro acesso à venda paga, sem
           * depender de qual rede trouxe a pessoa. `pagas` sai do MESMO
           * `totalizar` do cartão do topo, então os dois não têm como divergir.
           */
          funilSite: { ...funilDoSite, pagas: totalizar(linhas, orfas, custos).pagas },
          ads: { ligado: adsLigado, hoje: gasto, ontem: [] },
          /* A lista de vendas do período, para a aba Vendas e para o drawer.
             `origem` é por onde o dinheiro entrou, em letra — ver `origemDaVenda`. */
          vendas: doPeriodo.map((v) => ({ ...v, origem: origemDaVenda(v) })),
          total: doPeriodo.length,
          pagas: doPeriodo.filter((v) => v.status === 'completed').length,
          atualizadoEm: new Date().toISOString(),
        },
      });
    }

    /*
     * ========================================================================
     * A FILA DO WHATSAPP — quem pagou e ainda não recebeu o produto lá.
     * ========================================================================
     *
     * POR QUE ELA EXISTE: quem paga PIX no app do banco muitas vezes NÃO volta
     * ao site. O link do produto aparece na tela do checkout e some com ela.
     * Hoje não há e-mail de entrega neste sistema — o WhatsApp é o único canal
     * que sobra para alcançar quem pagou e fechou a aba.
     *
     * POR QUE É *PUXADA* E NÃO EMPURRADA: o robô do WhatsApp precisa de um
     * navegador de verdade aberto o tempo todo, e isso não roda em função sem
     * servidor. Ele vai rodar no computador do dono — atrás de roteador
     * doméstico, sem IP público, sem porta aberta. Se a função tentasse
     * CHAMAR o robô, não haveria endereço para chamar. Invertido, o robô
     * pergunta "tem alguém para avisar?" a cada meio minuto e nada precisa ser
     * exposto na internet.
     *
     * SEM `WHATSAPP_TOKEN` DEFINIDO, A ROTA NÃO EXISTE. Ela devolve nome,
     * telefone e o link do produto de quem comprou: aberta, seria a carteira
     * de clientes inteira à disposição de quem descobrisse o endereço.
     */
    /*
     * QUAIS OFERTAS DE DEPOIS DA COMPRA ESTAO DE PE.
     *
     * O checkout pergunta isto ao montar, para NAO MOSTRAR a tela de um produto
     * que o servidor nao consegue entregar. Sem ela, a pessoa que acabou de
     * pagar veria a oferta, clicaria, e levaria um erro na cara -- parece site
     * quebrado no minuto em que ela mais confia.
     *
     * Rota ABERTA de proposito: nao devolve dado de ninguem, so um sim/nao por
     * produto. Poe senha aqui e o checkout perde o sinal.
     */
    if (metodo === 'GET' && caminho === '/ofertas') {
      const addons: Record<string, boolean> = {};
      for (const id of ADDONS) addons[id] = ofertaEntregavel(id);
      /*
       * O PREÇO SAI DAQUI PARA QUEM PRECISA DIZER O PREÇO -- hoje o atendente
       * do WhatsApp, que responde "quanto custa?" dezenas de vezes por dia.
       *
       * A alternativa era escrever 47 dentro dele, e a regra 2 deste projeto
       * existe porque isso já custou dinheiro: a tela anunciava R$ 47 enquanto
       * a cobrança nascia com R$ 27. Um quarto espelho do preço, num processo
       * que roda numa máquina de casa e não passa pelo build, sairia de
       * sincronia sem ninguém ver -- e quem descobre é o cliente, no banco.
       *
       * Sai do MESMO `CATALOGO` que cobra, então não tem como discordar dele.
       * Nada de sigiloso: é o número que está escrito na página de vendas.
       */
      const precos: Record<string, number> = {};
      for (const [id, item] of Object.entries(CATALOGO)) precos[id] = item.preco;
      /*
       * O CHECKOUT PRECISA SABER, AO ABRIR, SE VAI TER DE PEDIR O CPF.
       *
       * Com a Pagou.ai como gateway ligado, a cobrança sem CPF volta 400 com
       * `field: "document"` e só ENTÃO o campo aparecia — a pessoa tocava em
       * gerar o PIX e levava um erro na primeira tentativa. Achado em
       * 03/10/2026, com campanha ativa na página do quiz. Aqui o front fica
       * sabendo antes e desenha o campo desde o início.
       *
       * Falhou a leitura? `false`: o erro do servidor continua sendo a rede.
       */
      let pedeCpf = false;
      try {
        pedeCpf = (await gatewayAtivo())?.id === 'pagouai';
      } catch {
        /* segue sem o aviso antecipado */
      }
      /* `boleto` liga a escolha "PIX ou boleto" na tela da oferta. Ver `numeroDoBoleto`. */
      return json(res, 200, { success: true, data: { addons, precos, pedeCpf, boleto: Boolean(numeroDoBoleto()) } });
    }

    /*
     * QUANTAS IMAGENS DE SÃO MIGUEL AINDA EXISTEM — o número de verdade.
     *
     * A página `/presente` anuncia escassez, e escassez anunciada tem de ser
     * conferível: aqui o que sobra é o estoque MENOS as vendas de frete
     * efetivamente PAGAS. Ele cai quando alguém compra, e não quando um
     * relógio manda cair.
     *
     * POR QUE NÃO UM NÚMERO FIXO NA TELA: "restam 5" escrito no front vira
     * mentira na primeira venda, e continua lá para sempre. Pior, a mesma
     * pessoa que comprou volta, vê os mesmos 5, e entende que o número nunca
     * foi real — inclusive o preço deixa de ser acreditado.
     *
     * `ESTOQUE_PRESENTE` é o tamanho do lote, e vive no ambiente porque muda
     * sem deploy: chegou caixa nova, muda a variável. Sem memória ligada a
     * rota devolve `null` e a tela simplesmente NÃO mostra número nenhum —
     * não saber é melhor que inventar.
     *
     * Rota aberta, como `/ofertas`: não devolve dado de ninguém, só uma
     * contagem. Senha aqui tiraria o número da página que precisa dele.
     */
    if (metodo === 'GET' && caminho === '/presente/estoque') {
      const total = Number(process.env.ESTOQUE_PRESENTE ?? '5');
      if (!memoriaLigada || !Number.isFinite(total) || total < 0) {
        return json(res, 200, { success: true, data: { total: null, vendidos: null, restam: null } });
      }
      const vendas = await listarVendas();
      const vendidos = vendas.filter(
        /* `completed` é como a função marca venda paga (ver `montarPedido`). */
        (v) => v.itens.some((i) => ENTREGA_FISICA.has(i)) && String(v.status) === 'completed',
      ).length;
      return json(res, 200, {
        success: true,
        data: { total, vendidos, restam: Math.max(0, total - vendidos) },
      });
    }

    if (caminho === '/whatsapp/fila' || caminho === '/whatsapp/entregue') {
      const senha = (process.env.WHATSAPP_TOKEN ?? '').trim();
      if (!senha) return erro(res, 404, 'NOT_FOUND', 'Rota não encontrada.');
      if (!segredoConfere(String(req.headers['x-whatsapp-token'] ?? ''), senha)) {
        return erro(res, 401, 'UNAUTHORIZED', 'Senha inválida.');
      }

      if (metodo === 'GET' && caminho === '/whatsapp/fila') {
        let vendas = await listarVendas();

        const agora = Date.now();
        const piso = Number.parseInt(process.env.LEMBRETE_MINUTOS ?? '2', 10) || 2;
        const janela = Number.parseInt(process.env.LEMBRETE_JANELA_HORAS ?? '24', 10) || 24;
        const fila: unknown[] = [];

        /*
         * QUEM DECIDE E `tarefasDaFila`, que e pura e tem teste proprio. Ela
         * classifica cada pedido e, no caminho, impede que a MESMA PESSOA leve
         * dois lembretes -- ver o cabecalho dela para o porque.
         */
        for (const { venda: v, tarefa, telefone } of tarefasDaFila(vendas, agora, piso, janela)) {
          /*
           * O NOME QUE VAI NA MENSAGEM E O LIMPO, sempre.
           *
           * `tarefaDaVenda` ja usou `pareceNome` para decidir se fala com ela;
           * aqui o que importa e COMO chamar. Sem isto, a cliente do pedido
           * MPV-975AE85059A6F0AA7B seria cumprimentada como "Maria 998222" --
           * ela colou um pedaco do telefone no campo do nome.
           *
           * `|| v.nome` e a rede: se a limpeza esvaziar tudo, e porque nao
           * havia nome, e a entrega (que passa por cima da trava) ainda
           * precisa de alguma coisa para escrever.
           */
          const nomeLimpo = limparNome(v.nome) || v.nome;
          /*
           * O BOLETO VAI EM `pedacos`, e não em `mensagem` (13/10/2026).
           *
           * É uma LISTA de mensagens porque o dono pediu assim: "enviar tipo
           * humanizada, um pedaço, depois outro". O campo `mensagem` continua
           * preenchido com os pedaços juntos — é a rede para um robô mais
           * antigo, que não conhece `pedacos` e mandaria o texto inteiro de uma
           * vez. Uma mensagem feia é melhor que nenhuma.
           */
          if (tarefa === 'boleto') {
            const pedacos = mensagensDoBoleto(nomeLimpo, v.valor);
            fila.push({
              tipo: 'boleto',
              orderId: v.id,
              nome: nomeLimpo,
              telefone,
              pedacos,
              mensagem: pedacos.join('\n\n'),
              /*
               * A HORA DO PEDIDO VIAJA JUNTO, e o robo precisa dela.
               *
               * Ele usa isto como CORTE para perguntar ao WhatsApp "alguem ja
               * respondeu a ela depois que este pedido nasceu?" -- se sim, ha
               * atendimento humano em andamento e o robo nao fala por cima.
               * Sem o corte, qualquer entrega antiga na mesma conversa calaria
               * o robo para sempre. Ver `jaFalamosDepoisDe` no robo.
               */
              criadoEm: v.criadoEm,
            });
            continue;
          }

          if (tarefa === 'entrega') {
            const itens = v.itens.map((itemId) => ({
              itemId,
              titulo: CATALOGO[itemId]?.titulo ?? itemId,
              url: SERVICOS.has(itemDeEntrega(itemId))
                ? null
                : linkDeEntrega(itemId) || null,
            }));
            fila.push({
              tipo: 'entrega',
              orderId: v.id,
              nome: nomeLimpo,
              telefone,
              mensagem: mensagemDeEntrega(nomeLimpo, itens),
              /* O sinal viaja JUNTO DA TAREFA, e não só gravado na venda: quem
                 monta mensagem é o robô, fora daqui, e ele não lê o Redis. Ver
                 `semUpsell` na interface `Venda` para o porquê da regra. */
              semUpsell: v.semUpsell === true,
            });
          } else {
            fila.push({
              tipo: 'lembrete',
              orderId: v.id,
              nome: nomeLimpo,
              telefone,
              mensagem: mensagemDeLembrete(nomeLimpo, v.valor, v.pixCopiaECola ?? ''),
              /*
               * O CÓDIGO SOLTO, além de dentro da mensagem (11/10/2026).
               *
               * O robô passou a mandar o PIX como QR COM O CÓDIGO NA LEGENDA, e
               * para desenhar o QR ele precisa do código puro. Extrair da
               * mensagem daria certo hoje e quebraria no dia em que a copy
               * mudasse de lugar — a linha do código já se moveu uma vez.
               *
               * `mensagem` continua completa e inalterada: quem não souber usar
               * este campo manda o texto como sempre mandou.
               */
              pixCopiaECola: v.pixCopiaECola ?? '',
              /*
               * A TERCEIRA MENSAGEM, pronta, vindo daqui (13/10/2026).
               *
               * Ela viaja montada junto da tarefa pelo mesmo motivo que
               * `mensagem`: quem escreve copy neste sistema é a função, não o
               * robô. O robô não lê o Redis, não sabe o tratamento da pessoa e
               * não deve aprender — no dia em que a copy existir em dois
               * lugares, um dos dois envelhece e ninguém percebe.
               *
               * Robô velho que não conhece o campo simplesmente não manda a
               * terceira: uma mensagem de menos, nunca uma quebrada.
               */
              posLembrete: mensagemDeComprovante(nomeLimpo),
            });
          }
        }

        return json(res, 200, { success: true, data: { fila } });
      }

      if (metodo === 'POST' && caminho === '/whatsapp/entregue') {
        const corpo = (await lerCorpo(req)) as {
          orderId?: string;
          tipo?: string;
          ok?: boolean;
          erro?: string;
        };
        const id = String(corpo?.orderId ?? '').trim();
        if (!id) return erro(res, 400, 'MISSING_ORDER', 'Falta o orderId.', 'orderId');

        const venda = await lerVenda(id);
        if (!venda) return erro(res, 404, 'NOT_FOUND', 'Pedido não encontrado.');

        if (corpo?.ok) {
          /*
           * O CARIMBO E SEMPRE GRAVADO, mesmo se o tipo vier errado -- cair no
           * `else` aqui significaria mandar a MESMA mensagem de novo na proxima
           * volta, que e o pior desfecho possivel.
           */
          const campo =
            corpo?.tipo === 'lembrete'
              ? 'whatsappLembreteEm'
              : corpo?.tipo === 'boleto'
                ? 'whatsappBoletoEm'
                : 'whatsappEnviadoEm';
          await atualizarVenda(id, { [campo]: new Date().toISOString(), whatsappErro: null });
        } else {
          /*
           * A tentativa é contada AQUI, e não no robô: se o robô morresse entre
           * enviar e contar, a mesma pessoa receberia a mesma mensagem na volta
           * seguinte -- e mensagem repetida é o que leva alguém a denunciar.
           *
           * MAS SÓ CONTA O QUE FOI TENTATIVA DE VERDADE. Em 08/09/2026 uma
           * cliente pagou R$ 88, o Docker estava parado, e o pedido queimou as
           * três chances em minutos contra um OpenWA que nem existia naquele
           * momento -- `fetch failed`, três vezes, e saiu da fila para sempre.
           * O WhatsApp nunca foi consultado: aquilo não diz nada sobre o
           * número dela, diz que a nossa máquina estava desligada.
           */
          const texto = String(corpo?.erro ?? 'sem detalhe').slice(0, 200);
          const infra = falhaDeInfraestrutura(texto);
          const tentativas = (venda.whatsappTentativas ?? 0) + (infra ? 0 : 1);
          /*
           * O ADIAMENTO CRESCE: 5 min, 30 min, e a terceira já bateu no teto.
           * Falha de infraestrutura espera 5 min e tenta de novo para sempre --
           * é o que faz a entrega acontecer sozinha quando o Docker voltar, sem
           * ninguém precisar lembrar de nada.
           */
          const minutos = infra ? 5 : tentativas === 1 ? 5 : 30;
          await atualizarVenda(id, {
            whatsappTentativas: tentativas,
            whatsappErro: texto,
            whatsappAdiadoAte: new Date(Date.now() + minutos * 60_000).toISOString(),
          });
          if (infra) {
            console.warn('[whatsapp] falha de infraestrutura em', id, '- NAO conta tentativa:', texto);
          }
        }
        return json(res, 200, { success: true });
      }

      return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
    }

    return erro(res, 404, 'NOT_FOUND', 'Rota não encontrada.');
  } catch (falha) {
    /*
     * O `AbortController` estoura aqui quando o gateway não responde a tempo.
     * A pessoa precisa saber que NADA FOI COBRADO — senão ela tenta de novo
     * achando que pode pagar duas vezes.
     */
    const abortou = (falha as Error)?.name === 'AbortError';
    return erro(
      res,
      abortou ? 504 : 500,
      abortou ? 'GATEWAY_TIMEOUT' : 'INTERNAL_ERROR',
      abortou
        ? 'O banco demorou para responder. Nenhuma cobrança foi gerada — tente de novo.'
        : 'Algo deu errado de nosso lado. Nenhuma cobrança foi gerada.',
    );
  }
}

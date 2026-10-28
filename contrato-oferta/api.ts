/**
 * ============================================================================
 * O PONTO DE PLUG DA API DE PIX. É AQUI QUE VOCÊ CONECTA A SUA.
 * ============================================================================
 *
 * Este site é só o front. Não há servidor, banco nem gateway dentro dele — o
 * checkout desenha a tela e chama as TRÊS funções do fim deste arquivo. Quem
 * responde elas é a API que você plugar.
 *
 * O QUE PRECISA EXISTIR DO OUTRO LADO (três rotas):
 *
 *   POST  /orders              cria a cobrança e devolve o PIX
 *   GET   /orders/:id          devolve o pedido, para saber se já pagou
 *   GET   /orders/:id/access   devolve o que entregar, depois de pago
 *
 * O endereço base sai de `VITE_API_BASE_URL` no momento do build; sem ela, o
 * front chama `/api` na mesma origem. Em desenvolvimento, o proxy do
 * `vite.config.ts` encaminha `/api` para onde você mandar.
 *
 * ---------------------------------------------------------------------------
 * O QUE A SUA API PRECISA DEVOLVER
 * ---------------------------------------------------------------------------
 *
 * Todas as respostas vêm embrulhadas, e o embrulho importa: este arquivo só
 * considera sucesso quando `success` é exatamente `true`.
 *
 *   { "success": true,  "data": { ... } }
 *   { "success": false, "error": "CODIGO", "message": "texto para o cliente",
 *     "field": "email" }
 *
 * O `message` do erro é MOSTRADO NA TELA, sem tradução. Escreva-o na língua de
 * quem está comprando: "O CPF informado não é válido", nunca "INVALID_CPF" nem
 * "gateway error 502". O `field` opcional acende o campo correspondente do
 * formulário.
 *
 * ---------------------------------------------------------------------------
 * DUAS REGRAS QUE NÃO SÃO DETALHE
 * ---------------------------------------------------------------------------
 *
 * 1. O PREÇO É SEU, NÃO DAQUI. O navegador manda IDs de produto (`offer`,
 *    `bumps`) e NUNCA um valor. Quem soma é a sua API. Os números que aparecem
 *    na tela (`PRECO_BASE` e `ORDER_BUMPS`, em InlineCheckout.tsx) são espelho
 *    de exibição e precisam bater com os seus — se divergirem, a pessoa soma um
 *    total na cabeça e recebe um QR de outro valor, e é aí que ela desiste.
 *
 * 2. O CPF VAI NO CORPO, e a sua API não deve devolvê-lo inteiro. O campo de
 *    volta é `documentMasked` (`***.444.777-**`): a tela mostra isso para a
 *    pessoa conferir que digitou certo, sem o número completo trafegar de volta
 *    nem aparecer em log de navegador.
 */

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');

/*
 * `frete_*` ENTROU EM 19/09/2026, com o presente de São Miguel em `/presente`.
 *
 * São três ofertas e não uma com valor variável porque a regra da casa vale
 * aqui também: o navegador manda o ID, o preço mora no catálogo da função. Uma
 * oferta só, com o valor vindo da tela, venderia o Sedex por R$ 0,01.
 */
export type OfferId =
  | 'main'
  /** A mesma oração por R$ 27: a oferta de quem ia embora (OfertaDeSaida.tsx). */
  | 'main_volta'
  | 'upsell'
  | 'downsell'
  | 'frete_jadlog'
  | 'frete_magalu'
  | 'frete_sedex';

/**
 * Os estados que o checkout entende.
 *
 * `pending` mantém o QR na tela e a consulta rodando; `completed` libera o
 * produto; os outros quatro encerram a tentativa. A sua API pode ter mais
 * estados internos, mas o que sair para cá tem de ser um destes.
 */
export type OrderStatus = 'pending' | 'completed' | 'expired' | 'cancelled' | 'refunded' | 'failed';

export interface OrderItem {
  id: string;
  title: string;
  /** Número, para contas. */
  amount: number;
  /** Já formatado para a tela — "R$ 47,00". Quem formata é a API, não o front. */
  amountFormatted: string;
}

export interface Order {
  id: string;
  offer: OfferId;
  status: OrderStatus;
  amount: number;
  amountFormatted: string;
  items: OrderItem[];
  /**
   * O PIX propriamente dito.
   *
   * `code` é o copia-e-cola (BR Code) — é dele que a tela desenha o QR, no
   * próprio navegador, então `imageUrl` pode vir nulo e nada quebra.
   * `expiresAt` em ISO 8601 alimenta o relógio de "esta chave expira em".
   */
  pix: { code: string; imageUrl: string | null; expiresAt: string | null } | null;
  paidAt: string | null;
  /** Liga o upsell/downsell ao pedido principal. Nulo no principal. */
  parentOrderId: string | null;
  /**
   * O CPF volta MASCARADO (`***.444.777-**`), nunca inteiro.
   *
   * A tela mostra isso para a pessoa conferir que digitou certo — e para avisar
   * que só esse CPF pode pagar o QR, quando o gateway tiver essa trava. O
   * número completo não tem por que voltar ao navegador nem entrar em log.
   */
  customer: { name: string; email: string; documentMasked: string };
  createdAt: string;
}

export interface DeliverableContent {
  itemId: string;
  title: string;
  description: string;
  /** O link do produto. Nulo quando a entrega é o próprio ato (a vela acesa). */
  url: string | null;
}

export interface AccessBundle {
  released: boolean;
  orderId: string;
  contents: DeliverableContent[];
  /** O que a pessoa comprou e ainda não pagou, para a tela lembrá-la. */
  pendingOrders: { id: string; offer: OfferId; status: OrderStatus; amountFormatted: string }[];
}

/**
 * TRÊS CAMPOS. O CPF é OPCIONAL aqui, e o formulário não o pede.
 *
 * A ZuckPay exige `cpf` no `POST /v3/pix/qrcode`, mas quem preenche esse campo
 * é a função (`api/index.ts`, ver CPF_DO_PAGADOR) — decisão do dono em
 * 04/09/2026, para o checkout ter menos atrito.
 *
 * O campo continua NO TIPO, e opcional, de propósito: se o CPF voltar à tela um
 * dia, o valor real chega à função e vence o sintético sem precisar mexer em
 * lugar nenhum.
 *
 * TUDO ISTO VIAJA NO CORPO DO POST, nunca na URL: ela entra no histórico do
 * navegador, no log de quem hospeda a API e no referer de tudo que a página
 * carregar depois.
 */
export interface CustomerInput {
  name: string;
  email: string;
  /** Só dígitos, com DDD e sem o 55. */
  phone: string;
  /** CPF, só dígitos. Opcional: sem ele, a função preenche. */
  document?: string;
}

/**
 * O erro que a tela sabe mostrar.
 *
 * `message` é o que a pessoa lê. `code` serve para o checkout decidir o que
 * fazer sem depender do texto, e `field` acende o campo do formulário.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly status: number;

  constructor(message: string, options: { code?: string; field?: string; status?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? 'UNKNOWN_ERROR';
    this.field = options.field;
    this.status = options.status ?? 0;
  }
}

/**
 * Toda chamada passa por aqui, e por isso todo erro chega à tela como texto.
 *
 * Falha de rede vira "não foi possível falar com o servidor" em vez de um
 * `TypeError: Failed to fetch` que ninguém entende; resposta que não é JSON
 * vira "resposta inesperada" em vez de estourar no meio do render. É o que
 * impede o checkout inteiro de sumir por causa de uma resposta torta.
 */
/**
 * TODA CHAMADA MORRE NA HORA MARCADA, e esta é a linha que mais importa aqui.
 *
 * `fetch` sem `signal` NÃO desiste sozinho: se o servidor aceita a conexão e
 * depois não responde — API apontada para o lugar errado, host no ar mas
 * travado, rede de celular que cai no meio do POST —, a promessa nunca resolve.
 * O botão fica girando para sempre, sem erro na tela e sem nada no console, e a
 * pessoa não tem nem como tentar de novo. Foi exatamente o que aconteceu em
 * 04/09/2026: "está carregando infinito e não gera o QR Code".
 *
 * O `catch` de rede embaixo NÃO cobria esse caso: ele só dispara quando o
 * `fetch` REJEITA. Conexão pendurada não rejeita — ela fica.
 */
const ESPERA_PADRAO_MS = 25_000;

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = ESPERA_PADRAO_MS, ...resto } = init ?? {};

  /*
   * `AbortController` + `setTimeout`, e não `AbortSignal.timeout()`: este
   * checkout roda em celular, e o `AbortSignal.timeout` só existe no Safari 16+.
   * Um iPhone velho não pode perder a venda por causa de açúcar sintático.
   */
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...resto,
      signal: controle.signal,
      headers: {
        Accept: 'application/json',
        ...(resto.body ? { 'Content-Type': 'application/json' } : {}),
        ...resto.headers,
      },
    });
  } catch (falha) {
    /*
     * ESTOUROU O RELÓGIO É DIFERENTE DE CAIU A REDE, e a mensagem tem de dizer
     * qual foi: "verifique sua conexão" manda a pessoa mexer no wi-fi quando o
     * problema é do servidor, e ela desiste achando que a culpa é dela.
     *
     * Nos dois casos a frase termina igual — NADA FOI COBRADO. Sem isso a
     * pessoa que já tinha aberto o app do banco tenta pagar de novo.
     */
    if ((falha as Error)?.name === 'AbortError') {
      throw new ApiError('O servidor demorou demais para responder. Nada foi cobrado — tente de novo.', {
        code: 'TIMEOUT',
      });
    }
    throw new ApiError('Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.', {
      code: 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(relogio);
  }

  const text = await response.text();
  let body: { success?: boolean; data?: unknown; error?: string; message?: string; field?: string } | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /*
       * PAGINA NO LUGAR DE DADOS QUASE SEMPRE SIGNIFICA UMA COISA SO: o
       * endereco da API esta errado, e quem respondeu foi o proprio site.
       *
       * Acontece quando `VITE_API_BASE_URL` falta no build e o front chama
       * `/api` na propria origem, onde a hospedagem devolve o index.html. A
       * mensagem antiga ("resposta inesperada") mandava procurar no lugar
       * errado -- parecia defeito do gateway, e nao configuracao do deploy.
       */
      const pareceHtml = /^\s*</.test(text) || (response.headers.get('content-type') ?? '').includes('html');
      throw new ApiError(
        pareceHtml
          ? 'O endereço da API está errado: o servidor devolveu uma página em vez de dados. Nada foi cobrado.'
          : 'O servidor devolveu uma resposta inesperada. Nada foi cobrado.',
        { code: 'INVALID_RESPONSE', status: response.status },
      );
    }
  }

  if (!response.ok || body?.success !== true) {
    throw new ApiError(body?.message ?? 'Não foi possível concluir a operação.', {
      code: body?.error,
      field: body?.field,
      status: response.status,
    });
  }

  return body.data as T;
}

/**
 * AS TRÊS CHAMADAS QUE O CHECKOUT FAZ. Nenhuma outra.
 */
/** O que o servidor devolve quando a pessoa pede boleto. */
export interface PedidoDeBoleto {
  id: string;
  boleto: true;
  codigo: string;
  amount: number;
  amountFormatted: string;
  whatsapp: string;
}

export const api = {
  /**
   * Nasce o pedido e, com ele, o PIX.
   *
   * `bumps` são os IDs dos order bumps marcados. Nenhum valor viaja daqui: a
   * sua API resolve o preço a partir dos IDs.
   *
   * `customer` VEM SÓ NO PEDIDO PRINCIPAL. O upsell e o downsell mandam
   * `parentOrderId` no lugar dele — a essa altura a pessoa já preencheu os
   * dados uma vez, e pedir de novo no meio da compra é onde ela desiste. A sua
   * API copia o cliente do pedido pai; se ela não fizer isso, o upsell nasce
   * sem dono e a entrega não sabe para quem vai.
   */
  createOrder(payload: {
    offer: OfferId;
    bumps?: string[];
    customer?: CustomerInput;
    parentOrderId?: string;
    /** Só a rota de teste `/pagou` manda: cobra pelo gateway P mesmo desligado. */
    gateway?: 'p';
    /** De qual funil a venda nasceu (ver src/lib/funil.ts). O painel separa por ele. */
    funil?: 'quiz' | 'pedido' | 'novo' | 'sinais';
    /**
     * DE QUAL ANÚNCIO A PESSOA VEIO (ver src/lib/atribuicao.ts).
     *
     * Vai aqui, no CORPO, e nunca na URL. É o que faz a venda saber de qual
     * criativo veio mesmo quando o PIX só cai horas depois — a essa altura a
     * URL com `utm_*` e `fbclid` já não existe em lugar nenhum.
     *
     * Se a sua API ignorar este campo, nada quebra: ele é opcional dos dois
     * lados. O que se perde é só a resposta para "qual anúncio vendeu".
     */
    attrib?: Record<string, string>;
  }): Promise<Order> {
    return request<Order>('/orders', { method: 'POST', body: JSON.stringify(payload) });
  },

  /**
   * PEDIR BOLETO (13/10/2026). Não cria cobrança: o servidor guarda o pedido,
   * com CPF e e-mail, e devolve o link da conversa de WhatsApp onde o dono
   * envia o boleto, emitido à mão. A mensagem do link leva código, valor, nome,
   * CPF e e-mail (decisão do dono). Ver `numeroDoBoleto` na função.
   */
  pedirBoleto(payload: {
    offer: OfferId;
    bumps?: string[];
    customer: CustomerInput;
    funil?: 'quiz' | 'pedido' | 'novo' | 'sinais';
    attrib?: Record<string, string>;
  }): Promise<PedidoDeBoleto> {
    return request<PedidoDeBoleto>('/orders', { method: 'POST', body: JSON.stringify({ ...payload, metodo: 'boleto' }) });
  },

  /**
   * "Já pagou?" — a pergunta que a tela repete enquanto o QR está aberto.
   *
   * Quem controla o ritmo é `src/hooks/useOrderStatus.ts`. Se a sua API tiver
   * limite de requisições, é lá que se ajusta o intervalo.
   */
  getOrder(orderId: string): Promise<Order> {
    /*
     * ESPERA CURTA AQUI, ao contrário da criação do pedido.
     *
     * Esta pergunta se REPETE. Com os 25 s do padrão, uma consulta pendurada
     * seguraria a próxima e a próxima — o `inFlightRef` do useOrderStatus
     * recusa consulta nova enquanto uma está aberta, então a tela pararia de
     * perguntar "já pagou?" justamente enquanto a pessoa paga. Dez segundos é
     * mais que o suficiente: a criação do pedido, que é a chamada pesada,
     * responde em menos de três.
     */
    return request<Order>(`/orders/${orderId}`, { timeoutMs: 10_000 });
  },

  /**
   * GERA UM CÓDIGO PIX NOVO PARA O MESMO PEDIDO, quando o anterior venceu.
   *
   * É a rota que a página `/pagar/<id>` já usa. O servidor refaz a cobrança
   * com os MESMOS itens e o mesmo preço (o navegador não manda valor nenhum) e
   * devolve um pedido novo, com id novo — ou `{ jaPago: true }` se o pagamento
   * do código antigo já tinha caído.
   */
  renewOrder(orderId: string) {
    return request<Order | { jaPago: true }>(`/orders/${orderId}/renovar`, { method: 'POST' });
  },

  /** O que entregar, depois de o pagamento confirmar. */
  getAccess(orderId: string): Promise<AccessBundle> {
    return request<AccessBundle>(`/orders/${orderId}/access`);
  },
  /**
   * QUAIS OFERTAS DE DEPOIS DA COMPRA O SERVIDOR CONSEGUE ENTREGAR.
   *
   * O checkout usa isto para NAO mostrar a tela de um produto sem entrega
   * configurada. Em 05/09/2026 o upsell de R$ 47 estava assim: cobrava e a
   * pessoa lia "link ainda nao configurado, acione o suporte".
   *
   * Espera curta e sem alarde: se esta consulta falhar, o checkout segue com o
   * comportamento de antes (mostrar as ofertas). Medicao nunca derruba venda --
   * e a barreira que importa e a do servidor, que recusa a cobranca de qualquer
   * jeito.
   */
  getOfertas(): Promise<{ addons: Record<string, boolean>; pedeCpf?: boolean; boleto?: boolean }> {
    return request<{ addons: Record<string, boolean>; pedeCpf?: boolean; boleto?: boolean }>('/ofertas', { timeoutMs: 6_000 });
  },
};

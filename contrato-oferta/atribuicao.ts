/**
 * DE QUAL ANÚNCIO A PESSOA VEIO.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISSO PRECISA SER GUARDADO NA PRIMEIRA CARGA
 * ---------------------------------------------------------------------------
 *
 * `utm_*` e `fbclid` só existem na PRIMEIRA visita. Quem recarrega, quem volta
 * pelo histórico ou quem clica em qualquer link interno chega aqui com a URL
 * limpa — e a essa altura já não há como saber qual criativo pagou pelo clique.
 *
 * Como o PIX costuma ser pago minutos (às vezes horas) depois, a venda chega
 * ao servidor muito depois de a URL ter sido esquecida. Sem este arquivo, o
 * relatório diz quanto entrou e não diz de onde.
 *
 * ---------------------------------------------------------------------------
 * O QUE É GUARDADO, E O QUE NUNCA É
 * ---------------------------------------------------------------------------
 *
 * Só o carimbo do anúncio e os identificadores que o Meta usa para casar a
 * venda com o clique (`_fbp`, `_fbc`). NÃO entra nada do quiz: o que a pessoa
 * marcou revela a crença dela, e foi por mandar esse tipo de dado que a conta
 * anterior levou aviso de bloqueio em 22/08/2026.
 *
 * Fica em `localStorage`, e não em cookie: cookie viaja em toda requisição de
 * imagem e de script, inclusive para terceiros.
 *
 * ---------------------------------------------------------------------------
 * ISTO NUNCA VAI NA URL
 * ---------------------------------------------------------------------------
 *
 * Vai no CORPO do pedido. URL entra em histórico, em log de servidor e no
 * `referer` de tudo que a página carregar depois.
 */

const CHAVE = 'mpv.atribuicao';

export interface Atribuicao {
  /** De onde veio: `utm_source`. */
  origem?: string;
  /** A campanha: `utm_campaign`. */
  campanha?: string;
  /** O conjunto de anúncios: `utm_medium`. */
  conjunto?: string;
  /** O CRIATIVO — é este que responde "qual anúncio vendeu". */
  criativo?: string;
  /** `utm_term`, quando o anúncio usa. */
  termo?: string;
  /** O clique do Facebook. Vira `_fbc` e é o que casa a venda com o anúncio. */
  fbclid?: string;
  /** O clique do Google, se um dia houver campanha lá. */
  gclid?: string;
  /** O clique do TikTok. É o que casa a venda com o anúncio do TikTok. */
  ttclid?: string;
  /** Cookie que o Pixel do TikTok cria no navegador. Melhora a correspondência. */
  ttp?: string;
  /** Cookie que o Pixel cria no navegador. Melhora muito a correspondência. */
  fbp?: string;
  /** Cookie derivado do `fbclid` pelo próprio Pixel. */
  fbc?: string;
  /** Quando a pessoa chegou, em ISO. Serve para saber se o carimbo é velho. */
  em?: string;
  /** A variante de copy que ela viu (`?capa=`), que também é um teste. */
  capa?: string;
  /**
   * DE QUAL CONTA DO TIKTOK VEIO A VISITA — o id do pixel, do `?tt=` do link.
   *
   * Cada conta de anúncio tem o seu pixel e o seu link (08/10/2026). É este
   * campo que faz o servidor mandar a venda SÓ para o pixel certo, e que faz o
   * index.html carregar SÓ ele. Ausente = pixel principal.
   */
  ttpx?: string;
}

/** O formato do id de pixel do TikTok. O MESMO teste mora no index.html e em api/index.ts. */
import { noFunilSinais } from './funil';

/**
 * O PIXEL DO FUNIL `/sinais` (13/10/2026). Esse funil roda numa conta de
 * anúncio à parte; quem entra por ele é dessa conta mesmo sem `?tt=` no link.
 * O MESMO id está no `index.html`, que é quem carrega o pixel na página — aqui
 * ele entra no carimbo, e é o carimbo que faz o servidor mandar a COMPRA para
 * este pixel (com o token cadastrado no painel, em Integrações).
 */
const PIXEL_DO_SINAIS = 'DB7026RC77UB3AQV1HP0';
const noSinais = (): boolean => noFunilSinais();

function pixelDoLink(bruto: string | null): string | undefined {
  const id = (bruto ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{16,24}$/.test(id) ? id : undefined;
}

function cookie(nome: string): string | undefined {
  try {
    const achado = document.cookie.split('; ').find((c) => c.startsWith(`${nome}=`));
    return achado ? decodeURIComponent(achado.slice(nome.length + 1)) : undefined;
  } catch {
    return undefined;
  }
}

function limpar(o: Atribuicao): Atribuicao {
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    // Corta valores absurdos: `fbclid` pode ser longo, mas não infinito, e o
    // que vai para o servidor precisa caber num corpo de pedido.
    if (typeof v === 'string' && v.trim()) saida[k] = v.trim().slice(0, 300);
  }
  return saida as Atribuicao;
}

/**
 * Roda uma vez, na abertura do site.
 *
 * SÓ GRAVA SE VIER CARIMBO NOVO. Sem isso, quem chega pelo anúncio e recarrega
 * a página apagaria o próprio carimbo com uma URL vazia — e a venda ficaria
 * órfã justamente no caso mais comum.
 */
export function capturarAtribuicao(): void {
  try {
    const url = new URLSearchParams(window.location.search);
    const novo = limpar({
      origem: url.get('utm_source') ?? undefined,
      campanha: url.get('utm_campaign') ?? undefined,
      conjunto: url.get('utm_medium') ?? undefined,
      criativo: url.get('utm_content') ?? undefined,
      termo: url.get('utm_term') ?? undefined,
      fbclid: url.get('fbclid') ?? undefined,
      gclid: url.get('gclid') ?? undefined,
      ttclid: url.get('ttclid') ?? undefined,
      capa: url.get('capa') ?? undefined,
      ttpx: pixelDoLink(url.get('tt')),
    });
    if (noSinais()) {
      if (Object.keys(novo).length > 0) {
        novo.ttpx ??= PIXEL_DO_SINAIS;
      } else {
        /* Sem carimbo novo na URL (recarga, link sem UTM): o que já estava
           guardado FICA — apagar deixaria a venda órfã —, e só o pixel é posto. */
        const guardado = JSON.parse(localStorage.getItem(CHAVE) || '{}') as Atribuicao;
        if (guardado.ttpx !== PIXEL_DO_SINAIS) {
          localStorage.setItem(CHAVE, JSON.stringify({ ...guardado, ttpx: PIXEL_DO_SINAIS, em: guardado.em ?? new Date().toISOString() }));
        }
        return;
      }
    }
    if (Object.keys(novo).length === 0) return;
    novo.em = new Date().toISOString();
    localStorage.setItem(CHAVE, JSON.stringify(novo));
  } catch {
    // localStorage bloqueado (aba anônima, navegador travado). Medição nunca
    // derruba a venda: sem carimbo o funil continua funcionando igual.
  }
}

/**
 * O que vai junto com o pedido.
 *
 * Os cookies do Pixel são lidos NA HORA, e não no momento da captura: o
 * `_fbp` só existe depois que o `fbevents.js` carrega, o que costuma acontecer
 * DEPOIS da primeira linha da visita.
 */
export function atribuicaoAtual(): Atribuicao | undefined {
  try {
    const guardado = localStorage.getItem(CHAVE);
    const base: Atribuicao = guardado ? JSON.parse(guardado) : {};
    const completo = limpar({ ...base, fbp: cookie('_fbp'), fbc: cookie('_fbc'), ttp: cookie('_ttp') });
    return Object.keys(completo).length ? completo : undefined;
  } catch {
    return undefined;
  }
}

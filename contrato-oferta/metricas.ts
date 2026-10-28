/**
 * A CONTAGEM DO FUNIL. Quantas pessoas chegaram em cada etapa.
 *
 * ---------------------------------------------------------------------------
 * O QUE SAI DAQUI, E O QUE NUNCA SAI
 * ---------------------------------------------------------------------------
 *
 * Sai a ETAPA e um identificador aleatório de sessão. Só isso.
 *
 * NÃO sai o que a pessoa marcou no quiz — o texto das respostas revela a crença
 * dela, e foi por mandar esse tipo de dado que a conta anterior levou aviso de
 * bloqueio em 22/08/2026. NÃO sai nome, e-mail nem telefone: quem chega na tela
 * 1 ainda não digitou nada, e quem digita já é registrado como pedido.
 *
 * O identificador de sessão existe para não contar a mesma pessoa duas vezes
 * quando ela volta pelo botão "Voltar". Ele é aleatório, não identifica
 * ninguém, e morre quando a aba fecha.
 *
 * ---------------------------------------------------------------------------
 * ISTO NUNCA PODE ATRAPALHAR A VENDA
 * ---------------------------------------------------------------------------
 *
 * `keepalive` para o envio sobreviver à troca de tela, sem `await` em lugar
 * nenhum, e tudo dentro de `try`. Se a API cair, se o armazenamento sumir, se um
 * bloqueador apagar o `fetch` — o funil continua funcionando e ninguém vê nada.
 * Contagem é para o dono; venda é para o cliente. Nessa ordem.
 */

import { atribuicaoAtual } from './atribuicao';
import { funilAtual } from './funil';

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');
const CHAVE = 'mpv.sessao';

/** As etapas que valem contar. Nome novo aqui tem de entrar na API também. */
export type Etapa =
  | 'chegou'
  | 'quiz'
  | 'audio'
  | 'depoimentos'
  | 'vsl'
  | 'checkout'
  /*
   * `cartao` é um DESVIO, não um degrau: quem toca no botão do cartão sai
   * deste site para a Kiwify e nunca chega em `pix`. Antes de 19/09/2026 essa
   * pessoa evaporava do relatório — contava em `checkout` e sumia — e o
   * degrau `checkout → pix`, que é o pior do funil, levava a culpa por gente
   * que só foi pagar de outro jeito.
   */
  | 'cartao'
  | 'pix'
  /* Os passos do funil `/novo`, um por tela. Número, e não nome: o servidor
     conta quantos chegaram em cada um, e o que foi respondido não viaja. */
  | 'n1' | 'n2' | 'n3' | 'n4' | 'n5' | 'n6' | 'n7' | 'n8';

const jaMarcadas = new Set<Etapa>();

function sessao(): string {
  try {
    const guardada = sessionStorage.getItem(CHAVE);
    if (guardada) return guardada;
    const nova = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(CHAVE, nova);
    return nova;
  } catch {
    // Aba anônima ou armazenamento bloqueado: a visita ainda conta, só não
    // sobrevive a uma recarga. Melhor contar duas vezes do que não contar.
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * NAVEGADOR DIRIGIDO POR PROGRAMA NAO ENTRA NA CONTA.
 *
 * Em 05/09/2026 o painel mostrou 26 chegadas ao checkout e 12 PIX num dia com
 * 4 pedidos. Parecia perda de venda -- pedido criado que nao virou registro --
 * e nao era: os horarios saiam em rajadas de tres eventos com 1 a 8 segundos
 * entre eles, repetindo a cada seis minutos. Gente nao passa tres vezes pelo
 * checkout em oito segundos. Eram as baterias de teste batendo na API de
 * producao.
 *
 * O estrago nao e o numero errado, e a DECISAO errada: quem le "26 chegaram ao
 * checkout e 1 pagou" conclui que o checkout esta quebrado e passa o dia
 * mexendo numa tela que esta certa -- com a campanha rodando.
 *
 * `navigator.webdriver` e `true` em Playwright, Selenium, Puppeteer e em
 * qualquer monitor automatico. Nenhum deles compra; nenhum deles deve contar.
 */
function ehRobo(): boolean {
  try {
    return navigator.webdriver === true;
  } catch {
    return false;
  }
}

export function marcarEtapa(etapa: Etapa): void {
  if (ehRobo()) return;
  try {
    // Uma vez por sessão, por etapa. O botão "Voltar" faz a pessoa passar de
    // novo pela mesma tela, e uma visita não pode virar duas no relatório.
    if (jaMarcadas.has(etapa)) return;
    jaMarcadas.add(etapa);

    void fetch(`${BASE}/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      /* `funil` separa o quiz do pedido no painel; `ad` (o utm_content, que é o
         id do anúncio) deixa o servidor saber para qual funil cada anúncio
         manda gente — é o que permite dividir o GASTO entre os dois. */
      body: JSON.stringify({ sessao: sessao(), etapa, funil: funilAtual(), ad: atribuicaoAtual()?.criativo }),
      // Sobrevive à troca de tela: sem isto, o envio da última etapa antes de
      // sair morre no meio e a etapa mais importante é a que menos aparece.
      keepalive: true,
    }).catch(() => {
      /* medição nunca derruba a venda */
    });
  } catch {
    /* idem */
  }
}

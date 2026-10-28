/**
 * DE QUAL FUNIL É ESTA VISITA: o do quiz ou o do pedido de oração.
 *
 * São dois caminhos para o mesmo checkout, com campanhas separadas (03/10/2026),
 * e o dono precisa ver cada um sozinho no painel — somados, um funil que
 * converte bem esconde o que converte mal.
 *
 * QUEM DECIDE É O ENDEREÇO, e não a etapa em que a pessoa está: `/pedido` é o
 * funil do pedido, todo o resto é o do quiz (inclusive `/pagou`, que é o quiz
 * cobrando por outro gateway). O site não troca de endereço no meio do caminho,
 * então a resposta é a mesma da primeira tela até o PIX.
 *
 * Nada de pessoal aqui: é o nome de uma página.
 */
export type Funil = 'quiz' | 'pedido' | 'novo' | 'sinais';

/**
 * O ENDEREÇO PRÓPRIO DO FUNIL `/sinais` (14/10/2026, pedido do dono: "não quero
 * ficar misturado"). É o MESMO projeto da Vercel, com outro nome apontando para
 * ele: mesma API, mesmo banco, mesmo painel e o mesmo robô. Nesse endereço o
 * `/sinais` abre na RAIZ, e tudo o que nasce lá é do funil `sinais`.
 *
 * O MESMO NOME ESTÁ NO `index.html` (lista DOMINIOS_DO_SINAIS): é ele que
 * liga o pixel e tira a capa escura antes do React. Trocar um, trocar o outro.
 */
export const DOMINIOS_DO_SINAIS = ['sinais-celestiais.vercel.app'];

export function noDominioDoSinais(): boolean {
  try {
    return DOMINIOS_DO_SINAIS.includes(window.location.hostname);
  } catch {
    return false;
  }
}

/** O funil de quatro perguntas: em `/sinais` aqui, ou em qualquer caminho do endereço dele. */
export function noFunilSinais(): boolean {
  try {
    return noDominioDoSinais() || window.location.pathname.replace(/\/+$/, '') === '/sinais';
  } catch {
    return false;
  }
}

export function funilAtual(): Funil {
  try {
    if (noDominioDoSinais()) return 'sinais';
    const caminho = window.location.pathname.replace(/\/+$/, '');
    /* `/novo` é o quiz enxuto com captura de contato (10/10/2026) — ver FunilNovo.tsx. */
    /* `/sinais` é o funil de quatro perguntas (13/10/2026) — ver FunilSinais.tsx. */
    return caminho === '/pedido' ? 'pedido' : caminho === '/novo' ? 'novo' : caminho === '/sinais' ? 'sinais' : 'quiz';
  } catch {
    return 'quiz';
  }
}

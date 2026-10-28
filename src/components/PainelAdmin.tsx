import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * O PAINEL DO DONO. Vive em `/admin` e não faz parte do funil.
 *
 * ---------------------------------------------------------------------------
 * ELE NÃO ENTRA NO PACOTE DE QUEM CHEGA PELO ANÚNCIO
 * ---------------------------------------------------------------------------
 *
 * É carregado sob demanda em `main.tsx`, só quando o endereço é `/admin`. Quem
 * cai aqui vindo do anúncio nunca baixa uma linha disto — e é assim que tem de
 * ser: cada kB no caminho de quem está comprando custa venda.
 *
 * ---------------------------------------------------------------------------
 * A SENHA VAI NO CABEÇALHO, NUNCA NA URL
 * ---------------------------------------------------------------------------
 *
 * Endereço entra em histórico, em log de servidor e no `referer` de tudo que a
 * página carregar depois. Esta lista tem nome, e-mail e telefone de quem
 * comprou; a senha dela não pode ficar espalhada por esses três lugares.
 *
 * Ela fica em `sessionStorage`, e não em `localStorage`: fechar a aba esquece.
 * Num computador compartilhado isso é a diferença entre um descuido e um
 * vazamento da carteira de clientes.
 *
 * "SALVAR A SENHA NESTE APARELHO" É ESCOLHA DO DONO (10/10/2026). Ele pediu:
 * esquecia a senha e tinha de procurá-la toda vez. Marcada a caixa, a senha vai
 * para o `localStorage` DAQUELE navegador e a tela de senha não aparece mais
 * ali. O padrão continua sendo esquecer — quem não marca nada fica como antes —
 * e o botão "Sair", no topo, apaga a senha salva. O risco é o de sempre: quem
 * abrir aquele navegador abre o painel.
 *
 * ---------------------------------------------------------------------------
 * QUEM SOMA É O SERVIDOR — INCLUSIVE ROAS, LUCRO E MARGEM
 * ---------------------------------------------------------------------------
 *
 * A tela recebe linhas prontas, cada uma já com o seu bloco `d` de números
 * derivados, saído da MESMA função que faz o total do topo. Nenhuma fórmula de
 * dinheiro é reescrita aqui. Se fosse, um dia o cartão e a linha diriam coisas
 * diferentes sobre o mesmo período — e o dono decidiria em cima do que viu
 * primeiro.
 *
 * O período também é resolvido lá: com o navegador decidindo o que é "hoje", o
 * relógio do visitante entraria na conta.
 *
 * ---------------------------------------------------------------------------
 * A PALETA É DESTE ARQUIVO, E NÃO A DO SITE
 * ---------------------------------------------------------------------------
 *
 * O funil é quente, claro no escuro, de leitura no celular. Este painel é uma
 * ferramenta de trabalho: navy escuro, denso, muitas colunas, tipografia
 * pequena. São dois produtos diferentes na mesma base de código, e misturar as
 * duas paletas produziu, numa tentativa anterior, uma ilha ilegível.
 *
 * Todas as cores moram no bloco `CSS` abaixo, presas ao escopo `.adm`. Não há
 * cor solta no meio do JSX, e nada daqui vaza para o funil.
 */

/* -------------------------------------------------------------------------- */
/* O que o servidor devolve                                                    */
/* -------------------------------------------------------------------------- */

interface Venda {
  id: string;
  nome: string;
  email: string;
  telefone: string;
  itens: string[];
  valor: number;
  status: string;
  metaEnviadoEm?: string | null;
  whatsappEnviadoEm?: string | null;
  whatsappLembreteEm?: string | null;
  /* Por que o envio não chegou. Sem isto na tela, entrega que falhou some em
     silêncio — e quem some é um cliente que pagou e está esperando. */
  whatsappErro?: string | null;
  criadoEm: string;
  pagoEm?: string | null;
  /* Por onde o dinheiro entrou. AUSENTE É PIX: marcar as duas formas obrigaria
     a reescrever toda venda antiga, e o painel mostraria "sem forma de
     pagamento" em tudo que veio antes de 19/09/2026. */
  pagamento?: 'pix' | 'cartao' | 'boleto';
  /* Só no pedido de boleto: o CPF que a pessoa digitou, para o dono emitir à mão. */
  cpf?: string;
  /* Só em venda de cartão recusada. `duplicate_link_order_email` é o único
     motivo que está na mão do dono — os outros são o banco do comprador. */
  cartaoRecusa?: string | null;
  parcelas?: number | null;
  /* Quem LIQUIDOU o PIX — não é a ZuckPay, que é só a intermediária. Medido em
     08/09/2026: a ZuckPay NÃO devolve este campo, então ele fica nulo e a linha
     nem aparece. Continua no código porque o dia em que eles mandarem, aparece
     sozinha — e o servidor registra no log quando um campo novo chega. */
  adquirente?: string | null;
  /* O `amount_liquid` da ZuckPay: o que sobrou depois da taxa DELES. É o número
     do extrato, não uma conta nossa. */
  valorLiquido?: number | null;
  /* O motivo, quando a venda foi marcada à mão por ter caído fora do gateway.
     Presente = este dinheiro nunca passou pela ZuckPay, então não há líquido. */
  pagoForaDoGateway?: string | null;
  /* Por onde o dinheiro entrou: `S`, `Z`, `A`, `cartão` ou `fora do gateway`.
     Vem pronto do servidor (`origemDaVenda`) — o nome do gateway não pode
     existir neste arquivo. S = SpyPag, Z = ZuckPay, A = AvenPay (NOTAS.md). */
  origem?: string;
  attrib?: Record<string, string>;
}

/** Os números derivados de uma linha — calculados no servidor, nunca aqui. */
interface Derivados {
  gasto: number;
  cliques: number;
  cliquesNoLink: number;
  impressoes: number;
  alcance: number;
  lpViews: number;
  ics: number;
  cadastros: number;
  pix: number;
  pagas: number;
  pendentes: number;
  recusadas: number;
  reembolsadas: number;
  receita: number;
  receitaPendente: number;
  receitaReembolsada: number;
  taxas: number | null;
  impostoVendas: number | null;
  custoProduto: number | null;
  despesas: number;
  impostoAds: number | null;
  liquido: number | null;
  lucro: number | null;
  cpa: number | null;
  cpi: number | null;
  cpc: number | null;
  ctr: number | null;
  cpm: number | null;
  roas: number | null;
  roi: number | null;
  margem: number | null;
  ticket: number | null;
  aprovacao: number | null;
  reembolsoPct: number | null;
  conversao: number | null;
  atribuidas: number | null;
  orfas: number;
}

interface Linha {
  id: string;
  nome: string;
  campanhaId: string;
  campanha: string;
  conjuntoId: string;
  conjunto: string;
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
  pix: number;
  pagas: number;
  receita: number;
  pendentes: number;
  receitaPendente: number;
  recusadas: number;
  reembolsadas: number;
  receitaReembolsada: number;
  status: string;
  efetivo: string;
  orcamento: number | null;
  tipoOrcamento: string | null;
  objetivo: string;
  atualizadoEm: string;
  thumb: string | null;
  /** De qual rede é a linha. Sem valor = Meta. A gaveta usa para não oferecer o interruptor do Meta a um anúncio do TikTok. */
  plataforma?: 'meta' | 'tiktok';
  d: Derivados;
}

interface Config {
  taxaPct: number | null;
  impostoPct: number | null;
  custoPorVenda: number | null;
  impostoAdsPct: number | null;
  breakEvenRoas: number | null;
  despesas: Array<{ id: string; descricao: string; valor: number; de: string; ate: string }>;
  atualizadoEm: string;
}

interface Conta {
  id: string;
  nome: string;
  situacao: number;
  motivo: number;
  moeda: string;
  gastoTotal: number;
  teto: number;
  saldo: number;
  fuso: string;
}

interface Resposta {
  memoria: boolean;
  meta: boolean;
  integracoes?: Record<string, boolean>;
  podeGerenciar?: boolean;
  /** Vendas pagas que o Meta nunca recebeu — atribuição perdida, recuperável. */
  purchaseFaltando?: { quantas: number; valor: number };
  /** Quantas vendas o armazenamento TINHA e quantas deram para ler. */
  armazenamento?: { listados: number; lidos: number; quando: string; motivo: string };
  /** O que o Meta respondeu quando recusou — vazio quando ele respondeu bem. */
  metaErro?: { ads: string; capi: string };
  config?: Config;
  conta?: Conta | null;
  periodo: { de: string; ate: string; dias: number; anteriorDe?: string; anteriorAte?: string };
  totais: Derivados;
  anterior: Derivados | null;
  anuncios: Linha[];
  conjuntos: Linha[];
  campanhas: Linha[];
  /** A área TikTok: só leitura, mesmas hierarquias, só as vendas que vieram com ttclid. */
  tiktok?: {
    ligado: boolean;
    erro: string;
    advertiserId: string;
    anuncios: Linha[];
    conjuntos: Linha[];
    campanhas: Linha[];
    totais: Derivados | null;
    /** Vendas do TikTok sem utm_content na URL do anúncio — contam, mas sem criativo. */
    semCarimbo: number;
  };
  /**
   * O CARTÃO, pela API da Kiwify. É RECORTE, não faturamento à parte: as mesmas
   * vendas já estão em `totais`, `utms` e nas linhas de cada rede. Aqui mora o
   * que só o cartão tem — recusa, motivo da recusa e parcelamento.
   */
  cartao?: {
    ligado: boolean;
    erro: string;
    /** Sessões que tocaram em "Pagar com cartão" e foram para a Kiwify. */
    cliques: number;
    /** Quantas abriram o checkout no período — a etapa anterior, para a proporção. */
    abriramCheckout: number;
    vendas: Venda[];
    pagas: number;
    faturamento: number;
    liquido: number;
    recusadas: number;
    perdido: number;
    taxaDeRecusa: number;
    motivos: Record<string, { quantas: number; valor: number }>;
    parcelas: Record<string, number>;
    porOrigem: Linha[];
    porCampanha: Linha[];
  };
  utms?: Record<string, Linha[]>;
  /** As cinco etapas do funil, só do tráfego com carimbo de anúncio do Meta. */
  funilMeta?: FunilMeta;
  /** O funil do site no período: sessões por etapa + pagas. Não depende de rede. */
  funilSite?: Record<string, number>;
  funil?: { hoje: Record<string, number>; ontem: Record<string, number>; dia: string };
  vendas: Venda[];
  total: number;
  pagas: number;
  atualizadoEm?: string;
}

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');
const CHAVE_SENHA = 'mpv.admin';

/** A senha guardada: a desta aba, ou a salva neste aparelho. Armazenamento bloqueado = nenhuma. */
function senhaGuardada(): string {
  try {
    return sessionStorage.getItem(CHAVE_SENHA) ?? localStorage.getItem(CHAVE_SENHA) ?? '';
  } catch {
    return '';
  }
}

function senhaEstaSalvaNoAparelho(): boolean {
  try {
    return Boolean(localStorage.getItem(CHAVE_SENHA));
  } catch {
    return false;
  }
}

/** Guarda só na aba, ou também no aparelho. Trocar de ideia limpa o lugar antigo. */
function guardarSenha(senha: string, noAparelho: boolean): void {
  try {
    sessionStorage.setItem(CHAVE_SENHA, senha);
    if (noAparelho) localStorage.setItem(CHAVE_SENHA, senha);
    else localStorage.removeItem(CHAVE_SENHA);
  } catch {
    /* Sem armazenamento a senha vale só enquanto a página estiver aberta. */
  }
}

function esquecerSenha(): void {
  try {
    sessionStorage.removeItem(CHAVE_SENHA);
    localStorage.removeItem(CHAVE_SENHA);
  } catch {
    /* nada a apagar */
  }
}
const CHAVE_COLUNAS = 'mpv.admin.colunas';
const CHAVE_VISIVEL = 'mpv.admin.visivel';
const CHAVE_ALERTAS = 'mpv.admin.alertas';

/* -------------------------------------------------------------------------- */
/* A PALETA E A DENSIDADE — tudo preso ao escopo `.adm`                        */
/* -------------------------------------------------------------------------- */

const CSS = `
.adm{
  --bg:#1b2230; --header:#151b27; --card:#232a38; --card2:#2a3244; --input:#1b2230;
  --bd:#2f384a; --tx:#e8edf5; --mut:#8b95a8; --ac:#3b82f6;
  --dgbg:#3a1d24; --dgtx:#f7b4b8; --dgbd:#6b2b33;
  --pos:#4ade80; --neg:#f87171; --warn:#eab308;
  color-scheme:dark;
  background:var(--bg); color:var(--tx); min-height:100vh;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:13px; line-height:1.45; -webkit-font-smoothing:antialiased;
}
.adm *{box-sizing:border-box}
/*
 * ESTE RESET TEM DE SER MENOS ESPECIFICO QUE AS CLASSES DE BOTAO, e a primeira
 * versao nao era: ".adm button" (uma classe + um elemento) GANHA de ".a-btn"
 * (uma classe so). O botao Atualizar nasceu sem o fundo azul, e o interruptor
 * virou uma bolinha branca solta no ar -- so a trilha VERDE aparecia, porque
 * .a-sw[data-on] tem duas classes e vencia. Dai o :where(), que zera a
 * especificidade do reset e deixa qualquer classe passar por cima.
 *
 * (Sem crase neste comentario: ele mora dentro de um template literal, e uma
 * crase aqui FECHA a string. Custou um build quebrado.)
 */
.adm :where(button){font:inherit;color:inherit;background:none;border:none;cursor:pointer}
.adm input,.adm select,.adm textarea{
  font:inherit;color:var(--tx);background:var(--input);
  border:1px solid var(--bd);border-radius:6px;padding:6px 9px;outline:none;
}
.adm input:focus,.adm select:focus{border-color:var(--ac)}
.adm a{color:var(--ac);text-decoration:none}
.adm a:hover{text-decoration:underline}
.adm code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}

/* --- topbar --- */
.a-top{height:56px;background:var(--header);border-bottom:1px solid var(--bd);
  display:flex;align-items:center;gap:12px;padding:0 16px;position:sticky;top:0;z-index:40}
.a-titulo{font-size:14px;font-weight:600;letter-spacing:-.01em}
.a-icone{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;
  color:var(--mut);font-size:14px}
.a-icone:hover{background:var(--card2);color:var(--tx)}
.a-icone[data-on="1"]{color:var(--ac)}

/* --- banner --- */
.a-banner{background:var(--dgbg);color:var(--dgtx);border-bottom:1px solid var(--dgbd);
  padding:10px 16px;font-size:12px;display:flex;gap:10px;align-items:flex-start}
.a-banner b{display:block;font-size:12px;letter-spacing:.04em;margin-bottom:2px}
.a-banner button{color:var(--dgtx);text-decoration:underline;font-weight:600}

/* --- layout --- */
.a-corpo{display:flex;align-items:flex-start}
.a-side{width:232px;flex:0 0 232px;background:var(--header);border-right:1px solid var(--bd);
  padding:12px 8px;position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto}
.a-side[data-fechada="1"]{width:56px;flex-basis:56px}
.a-main{flex:1;min-width:0;padding:16px 20px 60px}
.a-item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:6px;
  color:var(--mut);font-size:13px;text-align:left}
.a-item:hover{background:var(--card2);color:var(--tx)}
.a-item[data-ativo="1"]{background:var(--card2);color:var(--tx);font-weight:600}
.a-item span:first-child{width:16px;text-align:center;flex:0 0 16px}
.a-pino{margin-left:auto;background:var(--neg);color:#1b2230;font-size:10px;font-weight:700;
  border-radius:9px;padding:1px 6px;min-width:18px;text-align:center}

/* --- cards --- */
.a-card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px}
.a-card h4{margin:0 0 6px;font-size:11px;font-weight:600;color:var(--mut);
  letter-spacing:.03em;text-transform:uppercase;display:flex;align-items:center;gap:5px}
/* ".a-card h4" (classe + elemento) vence ".a-neg" (classe). Sem esta linha o
   titulo do cartao ruim continuava cinza -- a mesma armadilha que deixou o
   botao azul sem fundo. Nada de crase aqui: e template literal. */
.a-card h4.a-neg{color:var(--neg)}
.a-valor{font-size:22px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.a-sub{font-size:11px;color:var(--mut);margin-top:3px}
.a-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px;align-items:start}
.a-neg{color:var(--neg)}
.a-pos{color:var(--pos)}
.a-mut{color:var(--mut)}
.a-warn{color:var(--warn)}
.a-dica{cursor:help;opacity:.6;font-size:10px}

/* --- filtros --- */
.a-filtros{background:var(--card);border:1px solid var(--bd);border-radius:8px;
  padding:10px 12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.a-filtros label{font-size:11px;color:var(--mut);display:flex;flex-direction:column;gap:3px}
.a-btn{background:var(--ac);color:#fff;border-radius:6px;padding:7px 14px;font-weight:600;font-size:12px}
.a-btn:hover{filter:brightness(1.1)}
.a-btn[disabled],.a-btn2[disabled]{opacity:.5;cursor:not-allowed}
.a-btn2{background:var(--card2);border:1px solid var(--bd);border-radius:6px;padding:6px 11px;font-size:12px}
.a-btn2:hover{border-color:var(--ac)}
.a-btn2[data-ativo="1"]{border-color:var(--ac);color:var(--ac)}

/* --- subnav --- */
.a-tabs{display:flex;gap:2px;border-bottom:1px solid var(--bd);margin-bottom:12px}
.a-tab{padding:9px 14px;font-size:13px;color:var(--mut);border-bottom:2px solid transparent;margin-bottom:-1px}
.a-tab:hover{color:var(--tx)}
.a-tab[data-ativo="1"]{color:var(--tx);border-bottom-color:var(--ac);font-weight:600}

/* --- tabela --- */
.a-rolo{overflow-x:auto;border:1px solid var(--bd);border-radius:8px;background:var(--card)}
.a-tab-t{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;white-space:nowrap}
.a-tab-t th{position:sticky;top:0;z-index:5;background:var(--header);color:var(--mut);
  font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  padding:9px 10px;text-align:right;border-bottom:1px solid var(--bd);cursor:pointer;user-select:none}
.a-tab-t th.esq{text-align:left}
.a-tab-t th:hover{color:var(--tx)}
.a-tab-t td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--bd);
  font-variant-numeric:tabular-nums}
.a-tab-t td.esq{text-align:left;white-space:normal}
.a-tab-t tbody tr:hover{background:var(--card2)}
.a-tab-t tbody tr{cursor:pointer}
.a-tab-t tfoot td{background:var(--header);font-weight:600;border-top:1px solid var(--bd);
  border-bottom:none;position:sticky;bottom:0}
.a-nome{display:flex;gap:9px;align-items:center;max-width:340px}
.a-nome img{width:40px;height:40px;border-radius:4px;object-fit:cover;background:var(--card2);flex:0 0 40px}
.a-nome-t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.a-nome-s{font-size:11px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}

/* --- interruptor --- */
.a-sw{width:34px;height:19px;border-radius:10px;background:var(--bd);position:relative;
  transition:background .15s;flex:0 0 34px;display:block}
.a-sw[data-on="1"]{background:var(--pos)}
.a-sw[data-off="1"]{opacity:.4;cursor:not-allowed}
.a-sw i{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
  background:#fff;transition:transform .15s}
.a-sw[data-on="1"] i{transform:translateX(15px)}
.a-sw[data-carregando="1"]{opacity:.5}

/* --- gaveta --- */
.a-gaveta-fundo{position:fixed;inset:0;background:rgba(10,14,22,.6);z-index:60}
.a-gaveta{position:fixed;top:0;right:0;bottom:0;width:min(520px,100vw);background:var(--card);
  border-left:1px solid var(--bd);z-index:61;overflow-y:auto;padding:18px 20px 40px}
/* Quatro cartoes em 520 px dao 130 px cada, e "R$ 108,90" a 22 px quebra em
   duas linhas -- valor partido no meio parece outro numero. */
.a-gaveta .a-valor{font-size:17px;white-space:nowrap}
.a-gaveta .a-card{padding:10px 11px}

/* --- modal --- */
.a-modal-fundo{position:fixed;inset:0;background:rgba(10,14,22,.65);z-index:70;
  display:grid;place-items:center;padding:20px}
.a-modal{background:var(--card);border:1px solid var(--bd);border-radius:10px;
  width:min(880px,100%);max-height:min(680px,92vh);display:flex;flex-direction:column}
.a-modal-h{padding:14px 18px;border-bottom:1px solid var(--bd);font-weight:600}
.a-modal-b{display:grid;grid-template-columns:1fr 1fr;gap:0;flex:1;min-height:0}
.a-modal-col{overflow-y:auto;padding:12px 14px}
.a-modal-col+.a-modal-col{border-left:1px solid var(--bd)}
.a-modal-f{padding:12px 18px;border-top:1px solid var(--bd);display:flex;justify-content:flex-end;gap:8px}
.a-chk{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:5px;font-size:12px;cursor:pointer}
.a-chk:hover{background:var(--card2)}
.a-grupo{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;
  margin:12px 0 4px;font-weight:600}
.a-arr{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--bd);
  border-radius:5px;margin-bottom:5px;font-size:12px;background:var(--input);cursor:grab}
.a-arr[data-sobre="1"]{border-color:var(--ac)}

/* --- diversos --- */
.a-pil{display:inline-block;font-size:10px;padding:2px 7px;border-radius:10px;
  border:1px solid var(--bd);color:var(--mut)}
.a-pil[data-t="ok"]{color:var(--pos);border-color:var(--pos)}
.a-pil[data-t="ruim"]{color:var(--neg);border-color:var(--neg)}
.a-pil[data-t="aviso"]{color:var(--warn);border-color:var(--warn)}
.a-oculto .a-sensivel{filter:blur(6px);user-select:none}
.a-esq{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:90;
  background:var(--card2);border:1px solid var(--bd);border-radius:8px;padding:10px 16px;
  font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:min(560px,92vw)}
.a-esq[data-t="ruim"]{border-color:var(--dgbd);background:var(--dgbg);color:var(--dgtx)}
/* --- funil --- */
.a-rosca{width:34px;height:34px;border-radius:50%;flex:0 0 34px;display:grid;place-items:center}
.a-rosca i{width:25px;height:25px;border-radius:50%;background:var(--card);display:grid;
  place-items:center;font-size:9px;font-style:normal;color:var(--tx)}
.a-funil-card{display:flex;flex-direction:column}
.a-funil-rolo{overflow-x:auto;flex:1;display:flex;align-items:center}
/* Abaixo de ~640 px os cinco rotulos se encavalam; o card rola por dentro em
   vez de espremer o desenho, que e o que mantem o bico do funil legivel. */
.a-funil{width:100%;min-width:560px;height:auto;display:block}
/* Dentro da gaveta (520 px) o desenho encolhe para caber sem rolar; as letras
   do SVG compensam com o fator F=1,7 no componente. */
.a-funil--gaveta{min-width:440px}
.a-funil text{font-family:inherit;font-variant-numeric:tabular-nums}

.a-fantasma{background:linear-gradient(90deg,var(--card2),var(--bd),var(--card2));
  background-size:200% 100%;animation:a-brilho 1.2s linear infinite;border-radius:4px}
@keyframes a-brilho{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (max-width:820px){
  .a-side{position:static;width:100%;flex:1 0 100%;height:auto;border-right:none;
    border-bottom:1px solid var(--bd);display:flex;gap:4px;overflow-x:auto;padding:8px}
  .a-corpo{flex-wrap:wrap}
  .a-item{width:auto;white-space:nowrap}
  /*
   * flex-basis 100% E max-width 100% JUNTOS. Com o menu virando faixa e o
   * conteudo quebrando linha, "flex:1" sozinho deixa a coluna crescer ate a
   * largura da TABELA -- e ai quem rola de lado e a pagina inteira, com o menu
   * e os cartoes saindo da tela junto. Preso em 100%, quem rola e so o .a-rolo
   * de dentro, que e o certo. Medido num viewport de 390 px: 427 px de pagina.
   */
  .a-main{padding:12px;flex:1 1 100%;max-width:100%;min-width:0}
  /*
   * NO CELULAR TODO CARTAO OCUPA A LINHA INTEIRA.
   *
   * A grade cai para 6 colunas, e o funil pede "span 8". Grid nao trunca: ele
   * CRIA as colunas que faltam, e a pagina inteira passou a rolar de lado
   * (412 px num aparelho de 390). Como o span vem de style inline -- que ganha
   * de qualquer folha de estilo --, a unica forma de vencer e o !important.
   * Esta e a unica excecao do arquivo, e e por isso que ela existe.
   */
  .a-grid{grid-template-columns:repeat(6,1fr)}
  .a-grid > *{grid-column:span 6 !important}
  .a-tabs{overflow-x:auto}
}
`;

/* -------------------------------------------------------------------------- */
/* Como um número vira texto                                                   */
/* -------------------------------------------------------------------------- */

const n2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
/* Uma casa no funil: "61,8%" cabe no eixo, "61,75%" encosta no vizinho. */
const n1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const brl = (v: number | null | undefined): string => (v === null || v === undefined ? 'N/A' : `R$ ${n2.format(v)}`);
const inteiro = (v: number | null | undefined): string => (v === null || v === undefined ? 'N/A' : n0.format(v));
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? 'N/A' : `${n2.format(v * 100)}%`);
const vezes = (v: number | null | undefined): string => (v === null || v === undefined ? 'N/A' : `${n2.format(v)}x`);
const dataCurta = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/* -------------------------------------------------------------------------- */
/* O CATÁLOGO DE COLUNAS                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cada coluna é um item desta lista, e nada mais. Acrescentar uma métrica é
 * acrescentar um item — não é mexer na tabela, nem no modal, nem no CSV.
 *
 * NENHUMA FÓRMULA DE DINHEIRO NASCE AQUI. `roas`, `lucro`, `cpa`, `margem` e
 * `roi` só leem `l.d`, que veio do servidor. As razões que a lista calcula
 * sozinha (hook, hold, taxa de conexão) são divisões de duas contagens do mesmo
 * Meta, sem custo envolvido — e são feitas DEPOIS da soma das linhas, que é o
 * único jeito de o número da campanha bater com o dos anúncios dela.
 */
type TipoCol = 'moeda' | 'int' | 'pct' | 'x' | 'txt';

interface Coluna {
  id: string;
  rotulo: string;
  grupo: string;
  tipo: TipoCol;
  dica?: string;
  valor: (l: Linha) => number | string | null;
}

const COLUNAS: Coluna[] = [
  /* --- identidade e conta --- */
  { id: 'idmeta', rotulo: 'ID', grupo: 'Identidade', tipo: 'txt', valor: (l) => l.id },
  {
    id: 'orcamento',
    rotulo: 'Orçamento',
    grupo: 'Identidade',
    tipo: 'moeda',
    dica: 'O que o Meta tem configurado. Diário ou vitalício, indicado embaixo.',
    valor: (l) => l.orcamento,
  },
  {
    id: 'veiculacao',
    rotulo: 'Veiculação',
    grupo: 'Identidade',
    tipo: 'txt',
    dica: 'O que o Meta está REALMENTE fazendo. Anúncio ativo dentro de campanha pausada aparece parado aqui.',
    valor: (l) => (l.efetivo || '—').replace(/_/g, ' ').toLowerCase(),
  },
  { id: 'objetivo', rotulo: 'Objetivo', grupo: 'Identidade', tipo: 'txt', valor: (l) => l.objetivo || '—' },
  {
    id: 'atualizado',
    rotulo: 'Últ. atualização',
    grupo: 'Identidade',
    tipo: 'txt',
    valor: (l) => dataCurta(l.atualizadoEm),
  },

  /* --- mídia --- */
  { id: 'gasto', rotulo: 'Gastos', grupo: 'Mídia', tipo: 'moeda', valor: (l) => l.gasto },
  { id: 'impressoes', rotulo: 'Impressões', grupo: 'Mídia', tipo: 'int', valor: (l) => l.impressoes },
  { id: 'cliques', rotulo: 'Cliques', grupo: 'Mídia', tipo: 'int', valor: (l) => l.cliques },
  {
    id: 'cliquesLink',
    rotulo: 'Cliques no link',
    grupo: 'Mídia',
    tipo: 'int',
    dica: 'Só os que abrem o site. O "Cliques" cru conta curtida, comentário e "ver mais".',
    valor: (l) => l.cliquesNoLink,
  },
  { id: 'alcance', rotulo: 'Alcance', grupo: 'Mídia', tipo: 'int', valor: (l) => l.alcance },
  {
    id: 'frequencia',
    rotulo: 'Frequência',
    grupo: 'Mídia',
    tipo: 'x',
    dica: 'Impressões ÷ alcance. Acima de ~2,5 no mesmo público, o criativo cansou.',
    valor: (l) => razao(l.impressoes, l.alcance),
  },
  { id: 'ctr', rotulo: 'CTR', grupo: 'Mídia', tipo: 'pct', dica: 'Cliques ÷ impressões.', valor: (l) => l.d.ctr },
  { id: 'cpc', rotulo: 'CPC', grupo: 'Mídia', tipo: 'moeda', dica: 'Gasto ÷ cliques.', valor: (l) => l.d.cpc },
  { id: 'cpm', rotulo: 'CPM', grupo: 'Mídia', tipo: 'moeda', dica: 'Gasto por mil impressões.', valor: (l) => l.d.cpm },
  {
    id: 'lpviews',
    rotulo: 'Vis. de pág.',
    grupo: 'Mídia',
    tipo: 'int',
    dica: 'O pixel confirmou que a página abriu.',
    valor: (l) => l.lpViews,
  },
  {
    id: 'cpv',
    rotulo: 'CPV',
    grupo: 'Mídia',
    tipo: 'moeda',
    dica: 'Custo por visualização de página.',
    valor: (l) => razao(l.gasto, l.lpViews),
  },

  /* --- vídeo --- */
  {
    id: 'hook',
    rotulo: 'Hook',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: 'Assistiram 3 s ÷ impressões. Mede se os 3 primeiros segundos seguram.',
    valor: (l) => razao(l.video3s, l.impressoes),
  },
  {
    id: 'hold',
    rotulo: 'Hold Rate',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: 'Assistiram 75% ÷ impressões.',
    valor: (l) => razao(l.video75, l.impressoes),
  },
  {
    id: 'playrate',
    rotulo: 'Play Rate',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: 'Deram play ÷ impressões.',
    valor: (l) => razao(l.videoIniciados, l.impressoes),
  },
  {
    id: 'retencao',
    rotulo: 'Retenção 3 s',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: '3 s ÷ plays.',
    valor: (l) => razao(l.video3s, l.videoIniciados),
  },
  {
    id: 'retencaobody',
    rotulo: 'Retenção 75%',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: '75% ÷ plays. É o corpo do criativo segurando.',
    valor: (l) => razao(l.video75, l.videoIniciados),
  },
  {
    id: 'ctavideo',
    rotulo: 'CTA',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: 'Cliques no link ÷ quem assistiu 75%. Mede a chamada do fim.',
    valor: (l) => razao(l.cliquesNoLink, l.video75),
  },
  {
    id: 'convbody',
    rotulo: 'Conv. do corpo',
    grupo: 'Vídeo',
    tipo: 'pct',
    dica: 'Vendas ÷ quem assistiu 75%.',
    valor: (l) => razao(l.pagas, l.video75),
  },

  /* --- funil da oferta --- */
  {
    id: 'pix',
    rotulo: 'PIX / IC',
    grupo: 'Funil da oferta',
    tipo: 'int',
    dica: 'Cobranças geradas. É a finalização de compra iniciada deste funil.',
    valor: (l) => l.pix,
  },
  { id: 'cpi', rotulo: 'CPI', grupo: 'Funil da oferta', tipo: 'moeda', dica: 'Gasto ÷ PIX gerado.', valor: (l) => l.d.cpi },
  { id: 'pagas', rotulo: 'Vendas', grupo: 'Funil da oferta', tipo: 'int', valor: (l) => l.pagas },
  { id: 'pendentes', rotulo: 'Pendentes', grupo: 'Funil da oferta', tipo: 'int', valor: (l) => l.pendentes },
  {
    id: 'cpp',
    rotulo: 'CPP',
    grupo: 'Funil da oferta',
    tipo: 'moeda',
    dica: 'Custo por venda pendente.',
    valor: (l) => razao(l.gasto, l.pendentes),
  },
  {
    id: 'totais',
    rotulo: 'Vendas totais',
    grupo: 'Funil da oferta',
    tipo: 'int',
    dica: 'Pagas + pendentes.',
    valor: (l) => l.pagas + l.pendentes,
  },
  {
    id: 'cpt',
    rotulo: 'CPT',
    grupo: 'Funil da oferta',
    tipo: 'moeda',
    dica: 'Custo por venda total.',
    valor: (l) => razao(l.gasto, l.pagas + l.pendentes),
  },
  {
    id: 'recusadas',
    rotulo: 'Recusadas',
    grupo: 'Funil da oferta',
    tipo: 'int',
    dica: 'PIX que expirou ou foi recusado.',
    valor: (l) => l.recusadas,
  },
  { id: 'reembolsadas', rotulo: 'Reembolsadas', grupo: 'Funil da oferta', tipo: 'int', valor: (l) => l.reembolsadas },
  {
    id: 'convcheckout',
    rotulo: 'Conv. checkout',
    grupo: 'Funil da oferta',
    tipo: 'pct',
    dica: 'Vendas ÷ PIX gerado. De quem chegou a gerar o código, quantos pagaram.',
    valor: (l) => l.d.conversao,
  },
  {
    id: 'convcliques',
    rotulo: 'Conv. cliques',
    grupo: 'Funil da oferta',
    tipo: 'pct',
    dica: 'Vendas ÷ cliques.',
    valor: (l) => razao(l.pagas, l.cliques),
  },
  {
    id: 'conversao',
    rotulo: 'Conversão',
    grupo: 'Funil da oferta',
    tipo: 'pct',
    dica: 'Vendas ÷ visualizações de página.',
    valor: (l) => razao(l.pagas, l.lpViews),
  },
  {
    id: 'icr',
    rotulo: 'ICR',
    grupo: 'Funil da oferta',
    tipo: 'pct',
    dica: 'PIX gerado ÷ visualizações de página.',
    valor: (l) => razao(l.pix, l.lpViews),
  },
  {
    id: 'con',
    rotulo: 'Taxa de conexão',
    grupo: 'Funil da oferta',
    tipo: 'pct',
    dica: 'Vis. de página ÷ cliques. Abaixo de ~70% o site está perdendo gente antes de carregar.',
    valor: (l) => razao(l.lpViews, l.cliques),
  },

  /* --- financeiro --- */
  { id: 'receita', rotulo: 'Faturamento', grupo: 'Financeiro', tipo: 'moeda', valor: (l) => l.receita },
  { id: 'receitapend', rotulo: 'Fat. pendente', grupo: 'Financeiro', tipo: 'moeda', valor: (l) => l.receitaPendente },
  {
    id: 'receitareemb',
    rotulo: 'Fat. reembolsado',
    grupo: 'Financeiro',
    tipo: 'moeda',
    valor: (l) => l.receitaReembolsada,
  },
  {
    id: 'lucro',
    rotulo: 'Lucro',
    grupo: 'Financeiro',
    tipo: 'moeda',
    dica: 'Líquido − anúncios − custo do produto − reembolsos. Precisa de taxa e imposto configurados em Taxas.',
    valor: (l) => l.d.lucro,
  },
  { id: 'roas', rotulo: 'ROAS', grupo: 'Financeiro', tipo: 'x', dica: 'Faturamento ÷ gasto.', valor: (l) => l.d.roas },
  { id: 'margem', rotulo: 'Margem', grupo: 'Financeiro', tipo: 'pct', dica: 'Lucro ÷ faturamento.', valor: (l) => l.d.margem },
  { id: 'roi', rotulo: 'ROI', grupo: 'Financeiro', tipo: 'pct', dica: 'Lucro ÷ gasto.', valor: (l) => l.d.roi },
  { id: 'cpa', rotulo: 'CPA', grupo: 'Financeiro', tipo: 'moeda', dica: 'Gasto ÷ vendas pagas.', valor: (l) => l.d.cpa },
  { id: 'ticket', rotulo: 'Ticket médio', grupo: 'Financeiro', tipo: 'moeda', valor: (l) => l.d.ticket },
  { id: 'custoproduto', rotulo: 'Custo de produto', grupo: 'Financeiro', tipo: 'moeda', valor: (l) => l.d.custoProduto },
  { id: 'impostoads', rotulo: 'Imposto Meta Ads', grupo: 'Financeiro', tipo: 'moeda', valor: (l) => l.d.impostoAds },
  {
    id: 'arpu',
    rotulo: 'ARPU',
    grupo: 'Financeiro',
    tipo: 'moeda',
    dica: 'Faturamento ÷ visualizações de página.',
    valor: (l) => razao(l.receita, l.lpViews),
  },
];

const PORID = new Map(COLUNAS.map((c) => [c.id, c]));
const GRUPOS = [...new Set(COLUNAS.map((c) => c.grupo))];

type Grao = 'contas' | 'campanhas' | 'conjuntos' | 'anuncios';

/**
 * As colunas que abrem por padrão em cada nível.
 *
 * Campanha e conjunto mostram orçamento e as razões financeiras, que é onde se
 * decide verba. Anúncio mostra o funil enxuto, que é onde se decide criativo.
 */
const PADRAO: Record<string, string[]> = {
  contas: [],
  campanhas: [
    'orcamento',
    'atualizado',
    'pagas',
    'cpa',
    'gasto',
    'receita',
    'lucro',
    'roas',
    'margem',
    'roi',
    'pix',
    'cpi',
    'cpc',
    'ctr',
  ],
  conjuntos: [
    'orcamento',
    'atualizado',
    'pagas',
    'cpa',
    'gasto',
    'receita',
    'lucro',
    'roas',
    'margem',
    'roi',
    'pix',
    'cpi',
    'cpc',
    'ctr',
  ],
  anuncios: ['gasto', 'pix', 'pagas', 'cpa', 'roas', 'lucro', 'ctr', 'cpc'],
};

const COLUNAS_UTM = ['pix', 'pagas', 'pendentes', 'receita', 'ticket', 'convcheckout'];

const SECOES: Array<[string, string, string]> = [
  ['resumo', 'Resumo', '◎'],
  ['meta', 'Meta', 'f'],
  ['tiktok', 'TikTok', '♪'],
  /* O cartão virou aba em 19/09/2026, quando a API da Kiwify mostrou R$ 638,54
     pagos que nunca tinham aparecido em lugar nenhum do painel. */
  ['cartao', 'Cartão', '▭'],
  ['utms', 'UTMs', '⌗'],
  ['clientes', 'Clientes & PIX', '☏'],
  ['leads', 'Leads', '✉'],
  /* Tudo que o dono precisa para LIGAR o rastreio: a URL que vai no anúncio,
     o endereço do site, e o estado de cada peça. Nasceu em 28/10/2026 porque
     o painel sabia LER utm_content mas nunca dizia como carimbá-lo. */
  ['rastreio', 'Rastreio', '◎'],
  ['integracoes', 'Integrações', '⚙'],
  ['regras', 'Regras', '⚑'],
  ['taxas', 'Taxas', '%'],
  ['despesas', 'Despesas', '$'],
  ['relatorios', 'Relatórios', '▤'],
  ['eventos', 'Eventos', '⚡'],
  ['notificacoes', 'Notificações', '◔'],
];

const COM_FILTROS = ['resumo', 'meta', 'tiktok', 'cartao', 'utms', 'relatorios', 'eventos', 'clientes'];

const PERIODOS: Array<[string, string]> = [
  ['hoje', 'Hoje'],
  ['ontem', 'Ontem'],
  ['7d', 'Últimos 7 dias'],
  ['14d', 'Últimos 14 dias'],
  ['30d', 'Últimos 30 dias'],
  ['mes', 'Este mês'],
  ['mes_passado', 'Mês passado'],
  /* Do primeiro dia da operação até hoje. As VISITAS do funil só existem dos
     últimos 60 dias — o servidor explica em `resolverPeriodo`. */
  ['tudo', 'Todo o período'],
  ['personalizado', 'Escolher as datas…'],
];

/**
 * O período escolhido à mão viaja como `AAAA-MM-DD:AAAA-MM-DD`.
 *
 * Não é formato inventado para a tela: `resolverPeriodo`, no servidor, já
 * aceitava exatamente isso desde que o painel existe — só nunca houve botão que
 * mandasse. Manter a MESMA string como estado evita o erro clássico de ter um
 * "modo personalizado" na tela que discorda do que foi realmente pedido à API.
 */
const PERIODO_A_MAO = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/;

function hojeEmISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * O QUE CADA INTEGRAÇÃO CUSTA QUANDO ESTÁ DESLIGADA.
 *
 * Não é a lista de "coisas conectadas": é a lista do que PARA de funcionar. Um
 * ponto verde não faz ninguém agir; "o Meta não recebe as vendas e o robô passa
 * a mirar em quem navega" faz.
 *
 * O GATEWAY NÃO É CHAMADO PELO NOME AQUI, e não é descuido: este arquivo vira
 * JavaScript servido no domínio público, e `.github/workflows/conferir.yml`
 * REPROVA o build que levar o nome dele para dentro de `dist/`. A trava existe
 * para pegar a chave vazando num `VITE_*` — o nome junto é o que a torna barata
 * de manter, porque não exige distinguir "nome" de "segredo". Quem precisa
 * saber qual gateway é lê o NOTAS.md.
 */
const INTEGRACOES: Array<[string, string, string]> = [
  ['gateway', 'Gateway de pagamento (PIX)', 'Sem ele o checkout não gera PIX nenhum. É a integração de que o site inteiro depende.'],
  [
    'memoria',
    'Armazenamento das vendas',
    'Sem ele nada é gravado: o painel abre vazio, o robô do WhatsApp não tem fila e o Purchase pode sair duas vezes.',
  ],
  [
    'metaPurchase',
    'Meta CAPI (Purchase)',
    'Sem ela o Meta não recebe as vendas, e o robô de otimização passa a mirar em quem navega em vez de quem compra.',
  ],
  ['metaGasto', 'Meta Ads (gasto)', 'Sem ela não há gasto na tabela: ROAS, CPA, lucro e o interruptor de pausar somem.'],
  ['tiktokGasto', 'TikTok Ads (leitura)', 'Sem ela a área TikTok abre em "não conectado": sem gasto, ROAS nem CPA dos anúncios do TikTok. Precisa de TIKTOK_ADS_TOKEN (Marketing API) e TIKTOK_ADVERTISER_ID.'],
  ['whatsapp', 'Fila do WhatsApp', 'Sem ela quem paga PIX no app do banco e fecha a aba nunca recebe o produto.'],
  [
    'webhook',
    'Aviso de pagamento do gateway',
    'Sem ele o Purchase só sai se o navegador de quem comprou ainda estiver na tela — e quem paga PIX no app do banco fecha a aba. É assim que venda paga some do Gerenciador. Confira PUBLIC_BASE_URL: ela tem de ser um endereço, e o webhook precisa estar cadastrado no painel do gateway.',
  ],
  ['entregaPrincipal', 'Entrega do produto principal', 'Sem o link, quem paga vê a tela de obrigado sem nada para baixar.'],
  [
    'entregaUpsell',
    'Entrega do upsell',
    'Sem o link, o upsell nem aparece — o servidor recusa a cobrança em vez de vender o que não entrega.',
  ],
  [
    'custos',
    'Taxa e imposto configurados',
    'Sem eles não há lucro nem margem em lugar nenhum: o painel mostra ROAS e para por aí.',
  ],
];

/* -------------------------------------------------------------------------- */
/* Peças pequenas                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `ruim` PINTA O TÍTULO JUNTO COM O VALOR, e não só o número.
 *
 * Numa parede de dezesseis cartões, um número vermelho no meio se perde: o olho
 * varre os títulos. Pintando os dois, o cartão inteiro levanta a mão — que é o
 * comportamento da referência quando o ROAS cai abaixo do break-even.
 */
function Cartao({
  titulo,
  valor,
  sub,
  dica,
  cor,
  ruim,
  span = 2,
  sensivel = true,
  children,
}: {
  titulo: string;
  valor?: string;
  sub?: React.ReactNode;
  dica?: string;
  cor?: 'pos' | 'neg' | 'mut';
  ruim?: boolean;
  span?: number;
  sensivel?: boolean;
  children?: React.ReactNode;
}) {
  const classe = ruim ? 'a-neg' : cor ? `a-${cor}` : '';
  return (
    <div className="a-card" style={{ gridColumn: `span ${span}` }}>
      <h4 className={ruim ? 'a-neg' : ''}>
        {titulo}
        {dica ? (
          <span className="a-dica" title={dica}>
            ⓘ
          </span>
        ) : null}
      </h4>
      {valor !== undefined ? (
        <div className={`a-valor ${classe} ${sensivel ? 'a-sensivel' : ''}`}>{valor}</div>
      ) : null}
      {sub ? <div className="a-sub">{sub}</div> : null}
      {children}
    </div>
  );
}

/** A variação contra o período anterior. Sem base, não inventa porcentagem. */
function Delta({
  agora,
  antes,
  invertido,
}: {
  agora: number | null | undefined;
  antes: number | null | undefined;
  invertido?: boolean;
}) {
  if (agora === null || agora === undefined) return null;
  if (antes === null || antes === undefined || antes === 0) return null;
  const v = (agora - antes) / Math.abs(antes);
  const bom = invertido ? v < 0 : v > 0;
  return (
    <span className={bom ? 'a-pos' : 'a-neg'}>
      {' '}
      {v > 0 ? '▲' : '▼'} {n2.format(Math.abs(v) * 100)}%
    </span>
  );
}

function Interruptor({
  ligado,
  podeMexer,
  carregando,
  aoTrocar,
  motivo,
}: {
  ligado: boolean;
  podeMexer: boolean;
  carregando: boolean;
  aoTrocar: () => void;
  motivo?: string;
}) {
  return (
    <button
      type="button"
      className="a-sw"
      data-on={ligado ? '1' : '0'}
      data-off={podeMexer ? '0' : '1'}
      data-carregando={carregando ? '1' : '0'}
      disabled={!podeMexer || carregando}
      title={podeMexer ? (ligado ? 'Pausar no Meta' : 'Ativar no Meta') : motivo}
      onClick={(e) => {
        e.stopPropagation();
        aoTrocar();
      }}
    >
      <i />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* O painel                                                                    */
/* -------------------------------------------------------------------------- */

export default function PainelAdmin(): React.ReactElement {
  const [senha, setSenha] = useState(senhaGuardada);
  const [salvarNoAparelho, setSalvarNoAparelho] = useState(senhaEstaSalvaNoAparelho);
  const [rascunho, setRascunho] = useState('');
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [falha, setFalha] = useState('');
  const [buscadoEm, setBuscadoEm] = useState(0);
  const [agora, setAgora] = useState(() => Date.now());

  const [secao, setSecao] = useState('resumo');
  const [grao, setGrao] = useState<Grao>('anuncios');
  const [periodo, setPeriodo] = useState('hoje');
  const [comparar, setComparar] = useState(true);
  /*
   * QUAL FUNIL A TELA MOSTRA: os dois somados, só o do quiz ou só o do pedido
   * de oração (03/10/2026). O corte é feito NO SERVIDOR — vendas, visitas e
   * gasto pela mesma régua —, e aqui só se escolhe. Ver `?funil=` na função.
   *
   * Fica guardado na aba pelo mesmo motivo das colunas: quem está acompanhando
   * o funil do pedido não quer reescolher a cada atualização da página.
   *
   * O REF existe porque `buscar` é um callback sem dependências, chamado de dez
   * lugares com (senha, periodo, comparar). Ler o funil do ref poupa mexer nos
   * dez — e garante que o botão "Atualizar" e as gravações usem o mesmo filtro.
   */
  const [funil, setFunil] = useState<'' | 'quiz' | 'pedido' | 'novo' | 'sinais'>(() => {
    try {
      const guardado = sessionStorage.getItem('mpv.admin.funil');
      return guardado === 'quiz' || guardado === 'pedido' || guardado === 'novo' || guardado === 'sinais' ? guardado : '';
    } catch {
      return '';
    }
  });
  const funilRef = useRef(funil);
  funilRef.current = funil;
  const [busca, setBusca] = useState('');
  const [fonte, setFonte] = useState('qualquer');
  /* PIX, cartão, ou os dois juntos. Ver o uso em `vendasFiltradas`. */
  const [pagamentoFiltro, setPagamentoFiltro] = useState('qualquer');
  const [statusVenda, setStatusVenda] = useState('qualquer');
  const [statusObj, setStatusObj] = useState('qualquer');
  const [soComGasto, setSoComGasto] = useState(false);
  const [soSemVenda, setSoSemVenda] = useState(false);
  const [maisFiltros, setMaisFiltros] = useState(false);
  /* Trava o botão da varredura: cada clique custa uma consulta por pendente, e
     o gateway tem teto de requisições. Clique duplo aqui é chamada dobrada. */
  const [conferindo, setConferindo] = useState(false);
  const [ordenar, setOrdenar] = useState<{ col: string; desc: boolean }>({ col: 'gasto', desc: true });
  const [aberta, setAberta] = useState<Linha | null>(null);
  const [modalColunas, setModalColunas] = useState(false);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [mexendo, setMexendo] = useState<Set<string>>(new Set());
  const [esquina, setEsquina] = useState<{ texto: string; tipo?: 'ruim' } | null>(null);
  const [sidebarFechada, setSidebarFechada] = useState(false);
  const [visivel, setVisivel] = useState(() => localStorage.getItem(CHAVE_VISIVEL) !== '0');
  const [utmPor, setUtmPor] = useState('criativo');

  /** As colunas escolhidas, por nível. Ficam no aparelho de quem usa. */
  const [colunas, setColunas] = useState<Record<string, string[]>>(() => {
    try {
      const salvo = JSON.parse(localStorage.getItem(CHAVE_COLUNAS) ?? '{}');
      return { ...PADRAO, ...salvo };
    } catch {
      return { ...PADRAO };
    }
  });

  /* Os limites dos alertas. Ver a seção Regras para por que eles vivem aqui. */
  const [alertas, setAlertas] = useState<{ gastoSemVenda: number; cpaTeto: number }>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(CHAVE_ALERTAS) ?? '{}');
      return { gastoSemVenda: 30, cpaTeto: 40, ...s };
    } catch {
      return { gastoSemVenda: 30, cpaTeto: 40 };
    }
  });

  const [reenviando, setReenviando] = useState(false);

  const avisar = useCallback((texto: string, tipo?: 'ruim') => {
    setEsquina({ texto, tipo });
    window.setTimeout(() => setEsquina(null), 6000);
  }, []);

  const buscar = useCallback(async (comSenha: string, qual: string, comp: boolean) => {
    if (!comSenha) return;
    setCarregando(true);
    setFalha('');
    /*
     * RELÓGIO + UMA SEGUNDA TENTATIVA, e a falha diz o que foi.
     *
     * O /admin/orders faz nove descidas ao Meta em paralelo. Quando o Meta
     * engasga, a função da Vercel estoura o teto e a conexão cai no meio — e
     * o `fetch` REJEITA sem status nenhum. A mensagem antiga culpava a
     * VITE_API_BASE_URL, que não tinha nada a ver: o endereço está certo (a
     * tela acabou de carregar por ele), e mandar o dono conferir variável de
     * build por causa de um Meta lento é procurar no lugar errado.
     *
     * Agora: 45 s de relógio (antes não havia nenhum: uma conexão pendurada
     * girava para sempre), uma segunda tentativa silenciosa, e os dados que
     * já estavam na tela FICAM — um refresh que falha não apaga o painel.
     */
    const umaTentativa = async (): Promise<Response> => {
      const controle = new AbortController();
      const relogio = window.setTimeout(() => controle.abort(), 45_000);
      try {
        const doFunil = funilRef.current ? `&funil=${funilRef.current}` : '';
        return await fetch(`${BASE}/admin/orders?periodo=${encodeURIComponent(qual)}${comp && qual !== 'tudo' ? '&comparar=1' : ''}${doFunil}`, {
          headers: { 'x-admin-token': comSenha },
          signal: controle.signal,
        });
      } finally {
        window.clearTimeout(relogio);
      }
    };
    try {
      let r: Response;
      try {
        r = await umaTentativa();
      } catch {
        r = await umaTentativa();
      }
      if (r.status === 401) {
        /* Senha salva que deixou de valer (foi trocada na Vercel) é apagada dos
           dois lugares: senão a tela entraria e cairia aqui para sempre. */
        esquecerSenha();
        setSenha('');
        setFalha('Senha inválida.');
        return;
      }
      if (!r.ok) {
        setFalha(
          r.status === 504 || r.status === 502 || r.status === 503
            ? `O servidor demorou demais (${r.status}) — quase sempre é o Meta lento. Os números na tela são da última leitura boa; tente atualizar em instantes.`
            : `O servidor respondeu ${r.status}.`,
        );
        return;
      }
      const corpo = await r.json();
      setDados(corpo.data as Resposta);
      /*
       * OS DOIS RELÓGIOS SÃO ACERTADOS JUNTOS. `agora` só avança de 15 em 15 s;
       * sozinho, `buscadoEm` acabava no futuro em relação a ele e a tela dizia
       * "atualizado há -4s". Número negativo em cima do botão faz duvidar de
       * tudo que está embaixo.
       */
      const quando = Date.now();
      setBuscadoEm(quando);
      setAgora(quando);
    } catch (falha) {
      const estourou = (falha as Error)?.name === 'AbortError';
      setFalha(
        estourou
          ? 'O servidor passou de 45 s duas vezes seguidas — quase sempre é o Meta lento. Os números na tela são da última leitura boa; tente atualizar em instantes.'
          : 'A conexão caiu no meio da leitura, duas vezes. Confira sua internet e tente atualizar; os números na tela são da última leitura boa.',
      );
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (senha) void buscar(senha, periodo, comparar);
    /* `funil` entra só como gatilho: quem o lê é o `funilRef`, dentro de `buscar`. */
  }, [senha, periodo, comparar, funil, buscar]);

  /* O "atualizado há Xs" precisa de um relógio próprio, senão ele congela. */
  useEffect(() => {
    const t = window.setInterval(() => setAgora(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    localStorage.setItem(CHAVE_COLUNAS, JSON.stringify(colunas));
  }, [colunas]);
  useEffect(() => {
    localStorage.setItem(CHAVE_VISIVEL, visivel ? '1' : '0');
  }, [visivel]);
  useEffect(() => {
    localStorage.setItem(CHAVE_ALERTAS, JSON.stringify(alertas));
  }, [alertas]);

  /* ------------------------------------------------------------------ */
  /* O interruptor: pausa e ativa no Meta                                */
  /* ------------------------------------------------------------------ */

  const trocarStatus = useCallback(
    async (ids: string[], para: 'ACTIVE' | 'PAUSED') => {
      if (!senha || ids.length === 0) return;
      setMexendo(new Set(ids));
      let ok = 0;
      const erros: string[] = [];
      for (const id of ids) {
        try {
          const r = await fetch(`${BASE}/admin/meta/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
            body: JSON.stringify({ id, status: para }),
          });
          const corpo = await r.json().catch(() => ({}));
          if (r.ok) ok += 1;
          else erros.push(String(corpo?.error?.message ?? `HTTP ${r.status}`));
        } catch (e) {
          erros.push((e as Error)?.message ?? 'sem resposta');
        }
      }
      setMexendo(new Set());
      if (erros.length) avisar(`${ok} de ${ids.length} mudaram. O Meta disse: ${erros[0]}`, 'ruim');
      else avisar(`${ok === 1 ? '1 item' : `${ok} itens`} ${para === 'ACTIVE' ? 'ativado' : 'pausado'} no Meta.`);
      setMarcadas(new Set());
      /*
       * A LISTA É RECARREGADA DEPOIS, e não atualizada na mão.
       *
       * Marcar "pausado" só na tela deixaria o painel mostrando um estado que o
       * Meta pode ter recusado em silêncio (campanha em revisão, orçamento
       * travado). Recarregar custa uns segundos e mostra o que É, não o que se
       * pediu.
       */
      void buscar(senha, periodo, comparar);
    },
    [senha, periodo, comparar, buscar, avisar],
  );

  /**
   * A SEGUNDA CHANCE DO `Purchase`.
   *
   * O botão existe porque reenviar é efeito colateral, e efeito colateral
   * escondido numa tela que se deixa aberta dispara sozinho. Clicar duas vezes
   * não faz mal: o `event_id` é o número do pedido e o Meta descarta o
   * repetido.
   */
  const reenviarPurchase = useCallback(async () => {
    if (!senha) return;
    setReenviando(true);
    try {
      const r = await fetch(`${BASE}/admin/meta/reenviar`, {
        method: 'POST',
        headers: { 'x-admin-token': senha },
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        avisar(String(corpo?.error?.message ?? `HTTP ${r.status}`), 'ruim');
        return;
      }
      const d = corpo.data ?? {};
      avisar(
        d.aceitas > 0
          ? `${d.aceitas} de ${d.tentadas} venda(s) chegaram ao Meta agora.${d.faltavam > d.tentadas ? ` Ainda faltam ${d.faltavam - d.tentadas} — clique de novo.` : ''}`
          : 'O Meta não aceitou nenhuma. Confira o token da CAPI em Integrações.',
        d.aceitas > 0 ? undefined : 'ruim',
      );
      void buscar(senha, periodo, comparar);
    } catch {
      avisar('Não consegui falar com o servidor.', 'ruim');
    } finally {
      setReenviando(false);
    }
  }, [senha, periodo, comparar, buscar, avisar]);

  /**
   * APAGAR UM PEDIDO DE TESTE.
   *
   * Pedido de teste não some sozinho: fica `pending` para sempre, conta como
   * PIX gerado, derruba a porcentagem de vendas atribuídas e entra na fila de
   * lembrete do WhatsApp. O servidor recusa apagar qualquer coisa paga ou já
   * contada no Meta — ver o comentário da rota.
   */
  /*
   * MARCAR COMO PAGA UMA VENDA QUE ENTROU POR FORA.
   *
   * O PIX vence em 20 minutos e nem todo mundo paga dentro deles. Quando a
   * pessoa paga por outro caminho — chave direta, comprovante no WhatsApp — a
   * ZuckPay nunca sabe, e sem isto a venda fica invisível: sem entrega, sem
   * `Purchase` no Meta e fora do faturamento. Aconteceu com R$ 74 em
   * 08/09/2026.
   *
   * O MOTIVO É OBRIGATÓRIO, e o servidor recusa sem ele. É a única diferença
   * entre um registro de conciliação e um número inventado — e quem for ler
   * isso de novo vai estar fechando o mês, meses depois, sem lembrar do dia.
   */
  const marcarComoPaga = useCallback(
    async (v: Venda) => {
      if (!senha) return;
      const motivo = window.prompt(
        `Marcar a venda de ${v.nome} (${brl(v.valor)}) como PAGA.\n\n` +
          'Isso envia o evento de compra ao TikTok/Meta (no anúncio de onde ela veio) e libera a entrega no WhatsApp.\n\n' +
          'De onde veio o pagamento?',
        /* O pedido de boleto já diz de onde veio; o resto quase sempre é PIX combinado no WhatsApp. */
        v.pagamento === 'boleto' ? 'Boleto pago' : 'PIX direto, fora do gateway',
      );
      if (!motivo || !motivo.trim()) return;
      try {
        const r = await fetch(`${BASE}/admin/orders/${encodeURIComponent(v.id)}/pago`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
          body: JSON.stringify({ motivo: motivo.trim() }),
        });
        const corpo = await r.json().catch(() => ({}));
        if (!r.ok) {
          avisar(String(corpo?.message ?? corpo?.error?.message ?? `HTTP ${r.status}`), 'ruim');
          return;
        }
        if (corpo?.data?.jaEstava) avisar('Esta venda já estava marcada como paga.');
        else if (corpo?.data?.metaAceitou) avisar('Marcada como paga, e o evento de compra foi aceito pela plataforma.');
        else avisar('Marcada como paga. A plataforma NÃO aceitou o evento agora — use o botão de reenviar.', 'ruim');
        void buscar(senha, periodo, comparar);
      } catch {
        avisar('Não consegui marcar como paga.', 'ruim');
      }
    },
    [senha, periodo, comparar, buscar, avisar],
  );

  /**
   * PERGUNTA AO GATEWAY QUAIS PENDENTES JÁ FORAM PAGOS.
   *
   * Existe porque o aviso da ZuckPay falha e ninguém percebe: em 08/09/2026
   * três vendas — R$ 74, R$ 47 e R$ 47 — estavam pagas lá e `pending` aqui,
   * duas delas havia três dias. Sem entrega, sem `Purchase`, e contadas como
   * PIX abandonado no criativo que na verdade vendeu.
   *
   * O relógio da Vercel já roda isto de hora em hora. O botão é para o momento
   * em que o dono está olhando a tela e sabe que entrou dinheiro — esperar a
   * próxima hora com a cliente esperando o produto é o que ele não vai fazer.
   */
  const conferirPendentes = useCallback(async () => {
    if (!senha) return;
    setConferindo(true);
    try {
      const r = await fetch(`${BASE}/admin/conferir-pendentes`, {
        method: 'POST',
        headers: { 'x-admin-token': senha },
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        avisar(String(corpo?.message ?? corpo?.error?.message ?? `HTTP ${r.status}`), 'ruim');
        return;
      }
      const achadas = corpo?.data?.recuperadas ?? [];
      const olhados = corpo?.data?.olhados ?? 0;
      if (achadas.length) {
        const soma = achadas.reduce((s: number, x: { valor: number }) => s + (Number(x.valor) || 0), 0);
        avisar(`${achadas.length} venda(s) recuperada(s), ${brl(soma)}. Entrega e Purchase liberados.`);
      } else {
        avisar(`${olhados} pendente(s) conferido(s) no gateway. Nenhum tinha sido pago.`);
      }
      void buscar(senha, periodo, comparar);
    } catch {
      avisar('Não consegui falar com o gateway.', 'ruim');
    } finally {
      setConferindo(false);
    }
  }, [senha, periodo, comparar, buscar, avisar]);

  const apagarPedido = useCallback(
    async (v: Venda) => {
      if (!senha) return;
      if (!window.confirm(`Apagar o pedido de ${v.nome} (${brl(v.valor)}, ${v.status})? Não dá para desfazer.`)) return;
      try {
        const r = await fetch(`${BASE}/admin/orders/${encodeURIComponent(v.id)}`, {
          method: 'DELETE',
          headers: { 'x-admin-token': senha },
        });
        const corpo = await r.json().catch(() => ({}));
        if (!r.ok) {
          avisar(String(corpo?.error?.message ?? `HTTP ${r.status}`), 'ruim');
          return;
        }
        avisar('Pedido apagado.');
        void buscar(senha, periodo, comparar);
      } catch {
        avisar('Não consegui apagar.', 'ruim');
      }
    },
    [senha, periodo, comparar, buscar, avisar],
  );

  /* ------------------------------------------------------------------ */
  /* As linhas da tela, filtradas e ordenadas                            */
  /* ------------------------------------------------------------------ */

  const linhasBrutas: Linha[] = useMemo(() => {
    if (!dados) return [];
    if (secao === 'utms') return dados.utms?.[utmPor] ?? [];
    /* A área TikTok lê do bloco dela; o grão (campanha/grupo/anúncio) é o mesmo. Ela não tem "Contas": cai em campanhas. */
    const fonte = secao === 'tiktok' ? (dados.tiktok ?? { campanhas: [], conjuntos: [], anuncios: [] }) : dados;
    if (grao === 'campanhas' || (secao === 'tiktok' && grao === 'contas')) return fonte.campanhas ?? [];
    if (grao === 'conjuntos') return fonte.conjuntos ?? [];
    return fonte.anuncios ?? [];
  }, [dados, grao, secao, utmPor]);

  const linhas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const filtradas = linhasBrutas.filter((x) => {
      if (termo && !`${x.nome} ${x.campanha} ${x.conjunto} ${x.id}`.toLowerCase().includes(termo)) return false;
      if (soComGasto && x.gasto <= 0) return false;
      if (soSemVenda && x.pagas > 0) return false;
      if (statusObj === 'ativo' && x.status !== 'ACTIVE') return false;
      if (statusObj === 'pausado' && x.status === 'ACTIVE') return false;
      return true;
    });
    const col = PORID.get(ordenar.col);
    return [...filtradas].sort((a, b) => {
      const va = col ? col.valor(a) : a.nome;
      const vb = col ? col.valor(b) : b.nome;
      /* Nulo sempre no fim, dos dois lados da ordenação. */
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return ordenar.desc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb));
      }
      return ordenar.desc ? vb - va : va - vb;
    });
  }, [linhasBrutas, busca, soComGasto, soSemVenda, statusObj, ordenar]);

  const rodape = useMemo(
    () =>
      linhas.reduce(
        (acc, l) => {
          acc.gasto += l.gasto;
          acc.receita += l.receita;
          acc.pagas += l.pagas;
          acc.pix += l.pix;
          acc.lucro += l.d.lucro ?? 0;
          acc.temLucro = acc.temLucro || l.d.lucro !== null;
          return acc;
        },
        { gasto: 0, receita: 0, pagas: 0, pix: 0, lucro: 0, temLucro: false },
      ),
    [linhas],
  );

  const vendasFiltradas = useMemo(() => {
    const todas = dados?.vendas ?? [];
    const termo = busca.trim().toLowerCase();
    return todas.filter((v) => {
      if (statusVenda !== 'qualquer' && v.status !== statusVenda) return false;
      if (fonte === 'pago' && !v.attrib?.criativo) return false;
      if (fonte === 'naoatribuido' && v.attrib?.criativo) return false;
      /*
       * AS REDES SÃO FILTRADAS PELO QUE A VENDA CARREGA, não por uma lista de
       * campanhas: a mesma pessoa pode vir de `utm_source=tiktok` ou trazer só
       * o `ttclid` (quando o anúncio não levou UTM), e as duas são TikTok. No
       * Meta o `utm_source` chega como `fb` ou `ig` conforme o posicionamento —
       * por isso "Facebook" e "Instagram" são opções separadas, mas quem quer o
       * Meta inteiro usa "Meta (Facebook + Instagram)".
       */
      const origem = (v.attrib?.origem ?? '').toLowerCase();
      const ehTikTok = Boolean(v.attrib?.ttclid) || /tiktok|ttk/.test(origem);
      const ehMeta = !ehTikTok && (Boolean(v.attrib?.fbclid) || /^(fb|ig|facebook|instagram|meta)$/.test(origem));
      if (fonte === 'tiktok' && !ehTikTok) return false;
      if (fonte === 'meta' && !ehMeta) return false;
      if (fonte === 'fb' && origem !== 'fb' && origem !== 'facebook') return false;
      if (fonte === 'ig' && origem !== 'ig' && origem !== 'instagram') return false;
      if (fonte === 'direto' && (ehTikTok || ehMeta || origem)) return false;
      /* PIX é a ausência da marca: venda antiga não tem o campo. Ver `pagamento`. */
      if (pagamentoFiltro === 'cartao' && v.pagamento !== 'cartao') return false;
      if (pagamentoFiltro === 'pix' && v.pagamento === 'cartao') return false;
      if (termo && !`${v.nome} ${v.email} ${v.id} ${v.attrib?.criativo ?? ''}`.toLowerCase().includes(termo)) {
        return false;
      }
      return true;
    });
  }, [dados, statusVenda, fonte, pagamentoFiltro, busca]);

  const colsAtivas = useMemo(() => {
    const ids = secao === 'utms' ? COLUNAS_UTM : (colunas[grao] ?? PADRAO[grao] ?? []);
    return ids.map((id) => PORID.get(id)).filter(Boolean) as Coluna[];
  }, [colunas, grao, secao]);

  /* ------------------------------------------------------------------ */
  /* Os alertas — as "regras", avaliadas quando o painel abre            */
  /* ------------------------------------------------------------------ */

  const problemas = useMemo(() => {
    const lista: Array<{
      id: string;
      gravidade: 'ruim' | 'aviso';
      texto: string;
      alvo?: Linha;
      acao?: 'reenviar';
    }> = [];
    const i = dados?.integracoes ?? {};
    for (const [chave, nome, consequencia] of INTEGRACOES) {
      if (i[chave] === false) lista.push({ id: `int-${chave}`, gravidade: 'aviso', texto: `${nome}: ${consequencia}` });
    }
    const t = dados?.totais;
    if (t && t.atribuidas !== null && t.atribuidas < 0.9 && t.pix > 4) {
      lista.push({
        id: 'atrib',
        gravidade: 'aviso',
        texto: `${t.orfas} venda(s) sem carimbo de anúncio — ${pct(1 - t.atribuidas)} do total. O Gerenciador não vai creditar essas a criativo nenhum.`,
      });
    }
    /*
     * VENDA PAGA QUE O META NÃO RECEBEU É O ALERTA MAIS CARO DA LISTA. Ela
     * some do Gerenciador para sempre — o criativo que a gerou aparece com uma
     * venda a menos, e é sobre esse número que se decide escalar ou cortar.
     */
    /*
     * O ARMAZENAMENTO BLOQUEADO É O ALERTA MAIS GRAVE QUE EXISTE AQUI.
     * O checkout continua cobrando; o que para é o registro. Dinheiro entra,
     * ninguém recebe o produto e o Meta não sabe de nada -- e a tela mostraria
     * "0 vendas", igualzinho a um dia fraco.
     */
    const arm = dados?.armazenamento;
    if (arm && arm.listados > 0 && arm.lidos === 0) {
      lista.unshift({
        id: 'armazenamento',
        gravidade: 'ruim',
        texto: `O ARMAZENAMENTO NÃO RESPONDE. Ele tem ${arm.listados} venda(s) gravada(s) e nenhuma pôde ser lida — ${arm.motivo || 'sem detalhe'}. Enquanto isso durar, venda nova não é registrada, ninguém recebe o produto e o Meta não recebe o Purchase. NÃO suba anúncio.`,
      });
    }
    /*
     * O META RECUSANDO É ALERTA DE PRIMEIRA LINHA, e o motivo dele vai junto.
     * "Integração ligada" com gasto zero parece dia parado; "API access
     * blocked" manda a pessoa para o lugar certo em vez de procurar defeito no
     * criativo.
     */
    const me = dados?.metaErro;
    if (me?.ads) {
      lista.unshift({
        id: 'meta-ads',
        gravidade: 'ruim',
        texto: `O META RECUSOU as chamadas de anúncios: "${me.ads}". Sem elas não há gasto, ROAS, CPA nem o interruptor de pausar — e as três primeiras etapas do funil ficam em zero. Resolva no Business Manager antes de escalar.`,
      });
    }
    if (me?.capi) {
      lista.unshift({
        id: 'meta-capi',
        gravidade: 'ruim',
        texto: `O META RECUSOU a API de Conversões: "${me.capi}". Enquanto durar, venda paga NÃO chega ao Gerenciador e o robô otimiza sem saber quem comprou.`,
      });
    }
    const pf = dados?.purchaseFaltando;
    if (pf && pf.quantas > 0) {
      lista.unshift({
        id: 'purchase',
        gravidade: 'ruim',
        texto: `${pf.quantas} venda(s) paga(s), somando ${brl(pf.valor)}, que o Meta nunca recebeu. Sem elas o Gerenciador credita menos venda ao criativo do que ele realmente fez.`,
        acao: 'reenviar',
      });
    }
    const be = dados?.config?.breakEvenRoas ?? null;
    for (const l of dados?.anuncios ?? []) {
      if (l.gasto >= alertas.gastoSemVenda && l.pagas === 0) {
        lista.push({
          id: `sv-${l.id}`,
          gravidade: 'ruim',
          texto: `${l.nome || l.id} gastou ${brl(l.gasto)} e não vendeu.`,
          alvo: l,
        });
      } else if (l.d.cpa !== null && l.d.cpa > alertas.cpaTeto) {
        lista.push({
          id: `cpa-${l.id}`,
          gravidade: 'aviso',
          texto: `${l.nome || l.id} está com CPA de ${brl(l.d.cpa)}, acima do teto de ${brl(alertas.cpaTeto)}.`,
          alvo: l,
        });
      } else if (be !== null && l.d.roas !== null && l.gasto >= 20 && l.d.roas < be) {
        lista.push({
          id: `be-${l.id}`,
          gravidade: 'aviso',
          texto: `${l.nome || l.id} está com ROAS ${vezes(l.d.roas)}, abaixo do break-even de ${vezes(be)}.`,
          alvo: l,
        });
      }
    }
    return lista;
  }, [dados, alertas]);

  const configIncompleta = useMemo(() => {
    const i = dados?.integracoes;
    if (!i) return false;
    const arm = dados?.armazenamento;
    if (arm && arm.listados > 0 && arm.lidos === 0) return true;
    return (
      i.metaGasto === false ||
      i.metaPurchase === false ||
      i.custos === false ||
      i.memoria === false ||
      i.webhook === false
    );
  }, [dados]);

  /* ------------------------------------------------------------------ */
  /* A tela de senha                                                     */
  /* ------------------------------------------------------------------ */

  if (!senha) {
    return (
      <div className="adm" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <style>{CSS}</style>
        <form
          className="a-card"
          style={{ width: 'min(360px,100%)' }}
          onSubmit={(e) => {
            e.preventDefault();
            const s = rascunho.trim();
            if (!s) return;
            guardarSenha(s, salvarNoAparelho);
            setSenha(s);
          }}
        >
          {/* Mesmo motivo do título do topo: o nome do produto não fica na
              tela. Esta aqui é a PRIMEIRA que aparece, antes da senha. */}
          <h4>Painel</h4>
          {/* O campo de usuário escondido existe para o gerenciador de senhas do
              navegador reconhecer isto como login e oferecer para salvar. */}
          <input type="text" name="username" autoComplete="username" value="painel" readOnly hidden />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            placeholder="Senha do painel"
            style={{ width: '100%', marginTop: 8 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={salvarNoAparelho}
              onChange={(e) => setSalvarNoAparelho(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            <span>Salvar a senha neste aparelho</span>
          </label>
          <button className="a-btn" type="submit" style={{ width: '100%', marginTop: 10 }}>
            Entrar
          </button>
          {falha ? (
            <div className="a-sub a-neg" style={{ marginTop: 8 }}>
              {falha}
            </div>
          ) : null}
          <div className="a-sub" style={{ marginTop: 10 }}>
            {salvarNoAparelho
              ? 'A senha fica guardada neste navegador. Use só no seu aparelho — e "Sair", no topo, apaga.'
              : 'A senha fica só nesta aba. Fechou, esqueceu.'}
          </div>
        </form>
      </div>
    );
  }

  const segundos = buscadoEm ? Math.round((agora - buscadoEm) / 1000) : null;
  const t = dados?.totais;
  const ant = dados?.anterior;
  const podeGerenciar = dados?.podeGerenciar === true;

  /* ------------------------------------------------------------------ */

  return (
    <div className={`adm ${visivel ? '' : 'a-oculto'}`}>
      <style>{CSS}</style>

      {/* ---------------------------------------------------------- topbar */}
      <div className="a-top">
        {/* Só "Dashboard": o nome do produto saiu daqui a pedido do dono
            (24/09/2026). A tela é aberta na frente de outras pessoas e em
            gravação, e o nome no topo entrega a operação de graça. */}
        <span className="a-titulo">Dashboard</span>
        <button
          className="a-icone"
          data-on={visivel ? '0' : '1'}
          title={visivel ? 'Esconder os valores' : 'Mostrar os valores'}
          onClick={() => setVisivel((v) => !v)}
        >
          {visivel ? '◉' : '◎'}
        </button>
        <button className="a-icone" title="Recolher o menu" onClick={() => setSidebarFechada((v) => !v)}>
          ☰
        </button>
        <div style={{ flex: 1 }} />
        <span className="a-pil">PT-BR</span>
        {dados?.conta?.nome ? <span className="a-sub">{dados.conta.nome}</span> : null}
        {/* Apaga a senha da aba E a salva no aparelho: é o desfazer do "salvar". */}
        <button
          type="button"
          className="a-btn2"
          title="Sai do painel e apaga a senha guardada neste navegador"
          onClick={() => {
            esquecerSenha();
            setSalvarNoAparelho(false);
            setRascunho('');
            setSenha('');
          }}
        >
          Sair
        </button>
      </div>

      {/* --------------------------------------------------- banner de setup */}
      {configIncompleta ? (
        <div className="a-banner">
          <span>⚠</span>
          <div>
            <b>CONFIGURAÇÃO INCOMPLETA!</b>
            Faltam peças para o painel dizer a verdade sobre o lucro.{' '}
            <button onClick={() => setSecao('integracoes')}>Ver o que falta.</button>
          </div>
        </div>
      ) : null}

      <div className="a-corpo">
        {/* -------------------------------------------------------- sidebar */}
        <nav className="a-side" data-fechada={sidebarFechada ? '1' : '0'}>
          {SECOES.map(([id, rotulo, icone]) => {
            const pinos = id === 'notificacoes' ? problemas.filter((p) => p.gravidade === 'ruim').length : 0;
            return (
              <button key={id} className="a-item" data-ativo={secao === id ? '1' : '0'} onClick={() => setSecao(id)}>
                <span>{icone}</span>
                {!sidebarFechada ? <span>{rotulo}</span> : null}
                {pinos > 0 && !sidebarFechada ? <span className="a-pino">{pinos}</span> : null}
              </button>
            );
          })}
        </nav>

        <main className="a-main">
          {/* ------------------------------------------------ filtros globais */}
          {COM_FILTROS.includes(secao) ? (
            <div className="a-filtros">
              <label>
                Período de visualização
                <select
                  value={PERIODO_A_MAO.test(periodo) ? 'personalizado' : periodo}
                  onChange={(e) =>
                    setPeriodo(e.target.value === 'personalizado' ? `${hojeEmISO()}:${hojeEmISO()}` : e.target.value)
                  }
                >
                  {PERIODOS.map(([v, r]) => (
                    <option key={v} value={v}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Funil
                <select
                  value={funil}
                  onChange={(e) => {
                    const novo = e.target.value === 'quiz' || e.target.value === 'pedido' ? e.target.value : '';
                    setFunil(novo);
                    try {
                      sessionStorage.setItem('mpv.admin.funil', novo);
                    } catch {
                      /* sem armazenamento, o filtro vale só até recarregar */
                    }
                  }}
                  title="Mostra vendas, visitas e gasto de um funil só. O quiz é a página principal; o pedido é a /pedido."
                >
                  <option value="">Todos os funis</option>
                  <option value="quiz">Só o Quiz</option>
                  <option value="pedido">Só o Pedido de oração</option>
                  <option value="novo">Só o Funil novo (/novo)</option>
                  <option value="sinais">Só o Sinais (/sinais)</option>
                </select>
              </label>
              {/* As duas datas só aparecem quando foram pedidas — um par de campos
                  vazios em cima da barra o tempo todo só rouba espaço. */}
              {PERIODO_A_MAO.test(periodo) ? (
                <>
                  <label>
                    De
                    <input
                      type="date"
                      max={hojeEmISO()}
                      value={periodo.split(':')[0]}
                      onChange={(e) => setPeriodo(`${e.target.value || hojeEmISO()}:${periodo.split(':')[1]}`)}
                    />
                  </label>
                  <label>
                    Até
                    <input
                      type="date"
                      max={hojeEmISO()}
                      value={periodo.split(':')[1]}
                      onChange={(e) => setPeriodo(`${periodo.split(':')[0]}:${e.target.value || hojeEmISO()}`)}
                    />
                  </label>
                </>
              ) : null}
              <label>
                Conta de anúncio
                <select disabled>
                  <option>{dados?.conta?.nome ?? 'Qualquer'}</option>
                </select>
              </label>
              <label>
                Fonte de tráfego
                <select value={fonte} onChange={(e) => setFonte(e.target.value)}>
                  <option value="qualquer">Todas juntas</option>
                  <option value="meta">Meta (Facebook + Instagram)</option>
                  <option value="fb">Facebook</option>
                  <option value="ig">Instagram</option>
                  <option value="tiktok">TikTok</option>
                  <option value="direto">Direto / sem origem</option>
                  <option value="pago">Com criativo carimbado</option>
                  <option value="naoatribuido">Não atribuído</option>
                </select>
              </label>
              <label>
                Forma de pagamento
                <select value={pagamentoFiltro} onChange={(e) => setPagamentoFiltro(e.target.value)}>
                  <option value="qualquer">PIX + Cartão</option>
                  <option value="pix">Só PIX</option>
                  <option value="cartao">Só Cartão</option>
                </select>
              </label>
              <label>
                Status
                <select value={statusObj} onChange={(e) => setStatusObj(e.target.value)}>
                  <option value="qualquer">Qualquer</option>
                  <option value="ativo">Ativo</option>
                  <option value="pausado">Pausado</option>
                </select>
              </label>
              <label>
                Buscar
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="nome, ID ou e-mail" />
              </label>
              <button className="a-btn2" data-ativo={maisFiltros ? '1' : '0'} onClick={() => setMaisFiltros((v) => !v)}>
                Mais filtros ⌄
              </button>
              <div style={{ flex: 1 }} />
              <span className={`a-sub ${segundos !== null && segundos > 900 ? 'a-warn' : ''}`}>
                {segundos === null
                  ? ''
                  : segundos < 60
                    ? `Atualizado há ${segundos}s`
                    : `Atualizado há ${Math.round(segundos / 60)} min`}
              </span>
              {/*
                "Atualizar" relê o NOSSO registro; este pergunta ao GATEWAY.
                São coisas diferentes e o dono precisa das duas: quando a
                ZuckPay não avisa que o PIX foi pago, atualizar a tela mil
                vezes mostra sempre o mesmo "em aberto" — foi o que aconteceu
                em 08/09/2026, com R$ 168 de venda invisível.
              */}
              <button
                className="a-btn2"
                disabled={conferindo || carregando}
                title="Pergunta ao gateway se algum PIX em aberto já foi pago"
                onClick={() => void conferirPendentes()}
              >
                {conferindo ? 'Conferindo…' : 'Conferir PIX no gateway'}
              </button>
              <button className="a-btn" disabled={carregando} onClick={() => void buscar(senha, periodo, comparar)}>
                {carregando ? 'Buscando…' : 'Atualizar'}
              </button>
            </div>
          ) : null}

          {maisFiltros && COM_FILTROS.includes(secao) ? (
            <div className="a-filtros">
              <label>
                Status da venda
                <select value={statusVenda} onChange={(e) => setStatusVenda(e.target.value)}>
                  <option value="qualquer">Qualquer</option>
                  <option value="completed">Paga</option>
                  <option value="pending">Pendente</option>
                  <option value="refunded">Reembolsada</option>
                  <option value="expired">Expirada</option>
                  <option value="cancelled">Recusada</option>
                </select>
              </label>
              <label className="a-chk">
                <input type="checkbox" checked={soComGasto} onChange={(e) => setSoComGasto(e.target.checked)} />
                Somente com gasto &gt; 0
              </label>
              <label className="a-chk">
                <input type="checkbox" checked={soSemVenda} onChange={(e) => setSoSemVenda(e.target.checked)} />
                Somente sem venda
              </label>
              <label className="a-chk">
                <input type="checkbox" checked={comparar} onChange={(e) => setComparar(e.target.checked)} />
                Comparar com o período anterior
              </label>
            </div>
          ) : null}

          {falha ? (
            <div className="a-card a-neg" style={{ marginBottom: 12 }}>
              {falha}
            </div>
          ) : null}

          {!dados && carregando ? (
            <div className="a-grid">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="a-card" style={{ gridColumn: 'span 3' }}>
                  <div className="a-fantasma" style={{ height: 12, width: '55%' }} />
                  <div className="a-fantasma" style={{ height: 24, width: '75%', marginTop: 10 }} />
                </div>
              ))}
            </div>
          ) : null}

          {/* ================================================== RESUMO */}
          {/*
            ================================================== RESUMO
            O mosaico da seção 5 do design.md, em três linhas:
              1. os quatro números que se olha primeiro
              2. o FUNIL à esquerda (8 col) + a coluna de custos à direita
              3. produto · pendentes/reembolsadas/fonte · aprovação
          */}
          {secao === 'resumo' && t ? (
            <div className="a-grid">
              {/* --------------------------------------------------- linha 1 */}
              <Cartao
                titulo="Faturamento líquido"
                span={4}
                valor={brl(t.liquido)}
                ruim={t.liquido !== null && t.liquido < 0}
                dica="Faturamento bruto − taxa do checkout − imposto sobre vendas. Precisa de Taxas configurado."
                sub={
                  <>
                    Bruto {brl(t.receita)} · {inteiro(t.pagas)} pagas
                    <Delta agora={t.receita} antes={ant?.receita} />
                  </>
                }
              />
              <Cartao
                titulo="Gastos com anúncios"
                span={4}
                valor={brl(t.gasto)}
                sub={<Delta agora={t.gasto} antes={ant?.gasto} invertido />}
              />
              <Cartao
                titulo="ROAS"
                span={2}
                valor={vezes(t.roas)}
                /*
                 * O BREAK-EVEN MANDA, e o 1x só entra quando ele não existe.
                 * Vender R$ 1 para cada R$ 1 gasto não é empate: sobra a taxa,
                 * o imposto e o custo do produto para pagar. Quem configurou o
                 * alvo em Taxas vê o vermelho na hora certa.
                 */
                ruim={t.roas !== null && t.roas < (dados?.config?.breakEvenRoas ?? 1)}
                dica="Faturamento bruto ÷ gasto. N/A quando não houve gasto."
                sub={<Delta agora={t.roas} antes={ant?.roas} />}
              />
              <Cartao
                titulo="Lucro"
                span={2}
                valor={t.lucro === null ? 'configure' : brl(t.lucro)}
                ruim={t.lucro !== null && t.lucro < 0}
                dica="Líquido − anúncios − custo do produto − despesas − reembolsos − imposto sobre a mídia."
                sub={
                  t.lucro === null ? (
                    <button className="a-btn2" onClick={() => setSecao('taxas')}>
                      Configurar taxa e imposto
                    </button>
                  ) : (
                    <Delta agora={t.lucro} antes={ant?.lucro} />
                  )
                }
              />

              {/* --------------------------------------------------- linha 2 */}
              {/*
                O RESUMO DESENHA O FUNIL DO SITE, não o atribuído ao Meta
                (18/09/2026). Ver o comentário de ETAPAS_SITE para o que essa
                troca conserta. O funil atribuído ao Meta chegou a ficar na aba
                Meta e saiu de lá em 19/09/2026 — o motivo está escrito lá.
                ESTE É O ÚNICO FUNIL DE TELA CHEIA DO PAINEL; o outro que
                sobrou é o pequeno, dentro da gaveta de cada anúncio.
              */}
              <MetaConversionFunnel
                titulo="Funil do site (todas as origens)"
                passos={ETAPAS_SITE}
                dados={dados?.funilSite ?? {}}
                rodape={
                  <>
                    As seis etapas são do <b>nosso registro do site</b> e contam{' '}
                    <b>qualquer origem</b> — Meta, TikTok ou direto. Para ver o funil de{' '}
                    <b>um anúncio só</b>, abra a gaveta dele nas abas Meta ou TikTok.
                  </>
                }
              />

              <div style={{ gridColumn: 'span 4' }} className="a-grid">
                <Cartao titulo="ROI" span={6} valor={pct(t.roi)} ruim={t.roi !== null && t.roi < 0} dica="Lucro ÷ gasto." />
                <Cartao
                  titulo="Margem"
                  span={6}
                  valor={pct(t.margem)}
                  ruim={t.margem !== null && t.margem < 0}
                  dica="Lucro ÷ faturamento bruto."
                />
                <Cartao
                  titulo="Custos de produto"
                  span={6}
                  valor={brl(t.custoProduto)}
                  dica="Custo por venda × vendas pagas. Configurado em Taxas."
                />
                <Cartao titulo="Taxas do checkout" span={6} valor={brl(t.taxas)} />
                <Cartao
                  titulo="Reembolso %"
                  span={6}
                  valor={pct(t.reembolsoPct)}
                  ruim={t.reembolsoPct !== null && t.reembolsoPct > 0.05}
                />
                <Cartao
                  titulo="Chargeback %"
                  span={6}
                  valor="N/A"
                  sensivel={false}
                  dica="O gateway entrega chargeback e reembolso com o MESMO status. Enquanto ele não separar os dois, este número seria uma cópia do reembolso — e cópia com nome diferente é número inventado."
                />
                <Cartao
                  titulo="Despesas adicionais"
                  span={6}
                  valor={brl(t.despesas)}
                  sub={
                    <button className="a-btn2" onClick={() => setSecao('despesas')}>
                      Lançar
                    </button>
                  }
                />
                <Cartao
                  titulo="Imposto Meta Ads"
                  span={6}
                  valor={brl(t.impostoAds)}
                  dica="Provisão sobre a mídia. Opcional, configurada em Taxas."
                />
                <Cartao titulo="Imposto sobre vendas" span={6} valor={brl(t.impostoVendas)} />
                <Cartao titulo="CPA" span={6} valor={brl(t.cpa)} sub={<Delta agora={t.cpa} antes={ant?.cpa} invertido />} />
              </div>

              {/* --------------------------------------------------- linha 3 */}
              <div className="a-card" style={{ gridColumn: 'span 4' }}>
                <h4>Vendas por produto</h4>
                <PorProduto vendas={vendasFiltradas} />
              </div>

              <div style={{ gridColumn: 'span 4', display: 'grid', gap: 10 }}>
                <Cartao
                  titulo="Vendas pendentes"
                  span={1}
                  valor={inteiro(t.pendentes)}
                  sub={`${brl(t.receitaPendente)} em aberto`}
                />
                <Cartao
                  titulo="Vendas reembolsadas"
                  span={1}
                  valor={inteiro(t.reembolsadas)}
                  ruim={t.reembolsadas > 0}
                  sub={brl(t.receitaReembolsada)}
                />
                <div className="a-card">
                  <h4>Vendas por fonte</h4>
                  <PorFonte vendas={vendasFiltradas} />
                </div>
              </div>

              <div style={{ gridColumn: 'span 4', display: 'grid', gap: 10 }}>
                <div className="a-card">
                  <h4>Vendas por pagamento</h4>
                  <PorPagamento total={t.pagas} />
                </div>
                <div className="a-card">
                  <h4>Taxa de aprovação</h4>
                  <Aprovacao pix={t.aprovacao} />
                </div>
                <Cartao
                  titulo="Saúde do rastreio"
                  span={1}
                  sensivel={false}
                  valor={pct(t.atribuidas)}
                  ruim={t.atribuidas !== null && t.atribuidas < 0.95}
                  dica="Quanto das cobranças tem carimbo de anúncio. O resto o Gerenciador não credita a criativo nenhum."
                  sub={`${inteiro(t.orfas)} sem anúncio de ${inteiro(t.pix)} cobranças`}
                />
                {/*
                  ESTE CARTÃO SÓ APARECE QUANDO HÁ O QUE RECUPERAR — e some
                  quando não há. Cartão de problema que fica na tela mostrando
                  zero vira paisagem, e no dia em que o número sobe ninguém vê.
                */}
                {dados?.purchaseFaltando && dados.purchaseFaltando.quantas > 0 ? (
                  <Cartao
                    titulo="Vendas que o Meta não recebeu"
                    span={1}
                    valor={`${inteiro(dados.purchaseFaltando.quantas)} · ${brl(dados.purchaseFaltando.valor)}`}
                    ruim
                    dica="Pagas aqui e ausentes no Gerenciador. O criativo que as gerou aparece com menos venda do que fez — e é sobre esse número que se decide escalar."
                    sub={
                      <button className="a-btn" disabled={reenviando} onClick={() => void reenviarPurchase()}>
                        {reenviando ? 'Reenviando…' : 'Reenviar ao Meta'}
                      </button>
                    }
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {/* ==================================================== META */}
          {secao === 'meta' && dados ? (
            <>
              <div className="a-tabs">
                {(['contas', 'campanhas', 'conjuntos', 'anuncios'] as Grao[]).map((g) => (
                  <button key={g} className="a-tab" data-ativo={grao === g ? '1' : '0'} onClick={() => setGrao(g)}>
                    {g === 'contas' ? 'Contas' : g === 'campanhas' ? 'Campanhas' : g === 'conjuntos' ? 'Conjuntos' : 'Anúncios'}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                {grao !== 'contas' ? (
                  <button className="a-tab" onClick={() => setModalColunas(true)} title="Personalize as colunas">
                    ⚙ Colunas
                  </button>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                {marcadas.size > 0 ? (
                  <>
                    <span className="a-sub">{marcadas.size} selecionado(s)</span>
                    <button className="a-btn2" disabled={!podeGerenciar} onClick={() => void trocarStatus([...marcadas], 'ACTIVE')}>
                      Ativar
                    </button>
                    <button className="a-btn2" disabled={!podeGerenciar} onClick={() => void trocarStatus([...marcadas], 'PAUSED')}>
                      Pausar
                    </button>
                  </>
                ) : null}
                <div style={{ flex: 1 }} />
                {t ? (
                  <span
                    className="a-pil"
                    data-t={t.atribuidas !== null && t.atribuidas >= 0.95 ? 'ok' : 'aviso'}
                    title="Vendas com carimbo de anúncio."
                  >
                    {t.atribuidas === null
                      ? 'Sem vendas no período'
                      : t.atribuidas >= 0.95
                        ? 'Todas as vendas trackeadas'
                        : `${inteiro(t.orfas)} venda(s) sem anúncio`}
                  </span>
                ) : null}
                {!podeGerenciar && dados.integracoes?.metaGasto ? (
                  <span className="a-pil" data-t="aviso" title="O token conectado não tem ads_management.">
                    Interruptor desligado — falta permissão
                  </span>
                ) : null}
              </div>

              {/* AQUI NÃO VAI FUNIL (19/09/2026). Ele esteve neste lugar por um
                  dia e saiu a pedido do dono: no dia em que o Meta não gasta —
                  e hoje ele passa dias assim, com o tráfego no TikTok — as cinco
                  etapas aparecem 0,0% em cima da tela inteira, ocupando a dobra
                  com o nada. A pergunta desta aba é "qual anúncio vendeu", e
                  quem responde isso é a TABELA logo abaixo. O funil por criativo
                  continua existindo, na gaveta de cada anúncio, onde ele tem
                  contexto; e o funil do site inteiro fica no Resumo. */}

              {grao === 'contas' ? (
                <ContaCard conta={dados.conta ?? null} totais={t ?? null} />
              ) : (
                <Tabela
                  linhas={linhas}
                  colunas={colsAtivas}
                  grao={grao}
                  ordenar={ordenar}
                  setOrdenar={setOrdenar}
                  marcadas={marcadas}
                  setMarcadas={setMarcadas}
                  mexendo={mexendo}
                  podeGerenciar={podeGerenciar}
                  trocarStatus={trocarStatus}
                  aoAbrir={setAberta}
                  rodape={rodape}
                />
              )}
            </>
          ) : null}

          {/* ================================================== TIKTOK */}
          {secao === 'cartao' && dados ? (
            <>
              {!dados.cartao?.ligado ? (
                <div className="a-card" style={{ marginBottom: 12 }}>
                  <h4>
                    <span className="a-neg">●</span> API da Kiwify não conectada
                  </h4>
                  <div className="a-sub" style={{ lineHeight: 1.7 }}>
                    Sem ela esta aba só mostra o que o <b>webhook</b> gravou de 19/09/2026 em diante — o histórico anterior do
                    cartão fica de fora, e com ele o faturamento some do ROAS. Faltam três variáveis na Vercel:{' '}
                    <b>KIWIFY_CLIENT_ID</b>, <b>KIWIFY_CLIENT_SECRET</b> e <b>KIWIFY_ACCOUNT_ID</b>, todas na tela{' '}
                    <b>Apps → API</b> do painel da Kiwify.
                  </div>
                </div>
              ) : null}
              {dados.cartao?.erro ? (
                <div className="a-card" style={{ marginBottom: 12 }}>
                  <h4>
                    <span className="a-neg">●</span> A Kiwify recusou a leitura
                  </h4>
                  <div className="a-sub">{dados.cartao.erro}</div>
                </div>
              ) : null}

              <div className="a-grid">
                <Cartao
                  titulo="Faturamento no cartão"
                  span={3}
                  valor={brl(dados.cartao?.faturamento ?? 0)}
                  sub={`${inteiro(dados.cartao?.pagas ?? 0)} venda(s) paga(s)`}
                  dica="O que a pessoa pagou, juros do parcelamento inclusos. É o mesmo dinheiro que já conta no Resumo — aqui é só o recorte do cartão."
                />
                <Cartao
                  titulo="Líquido pra você"
                  span={3}
                  valor={brl(dados.cartao?.liquido ?? 0)}
                  sub="já sem a taxa da Kiwify"
                  dica="Número da própria Kiwify, não conta nossa: é o que cai na conta."
                />
                <Cartao
                  titulo="Recusado"
                  span={3}
                  valor={brl(dados.cartao?.perdido ?? 0)}
                  sub={`${inteiro(dados.cartao?.recusadas ?? 0)} tentativa(s) negada(s)`}
                  ruim={(dados.cartao?.recusadas ?? 0) > 0}
                  dica="Gente que quis comprar e o cartão não passou. Veja o motivo abaixo."
                />
                <Cartao
                  titulo="Taxa de recusa"
                  span={3}
                  valor={`${Math.round((dados.cartao?.taxaDeRecusa ?? 0) * 100)}%`}
                  sub="dos cartões tentados no período"
                  ruim={(dados.cartao?.taxaDeRecusa ?? 0) >= 0.2}
                  dica="Acima de 20% já é alto. Em 19/09/2026 estava em 44%."
                />
              </div>

              {/*
                O CAMINHO ATÉ A KIWIFY, em três números. Existe porque quem
                clica no cartão SAI do site: até 19/09/2026 essa pessoa
                evaporava do relatório — contava em "abriu o checkout" e
                sumia — e o degrau checkout→PIX levava a culpa por gente que
                não desistiu, só foi pagar de outro jeito.
              */}
              <div className="a-grid" style={{ marginTop: 10 }}>
                <Cartao
                  titulo="Abriram o checkout"
                  span={4}
                  valor={inteiro(dados.cartao?.abriramCheckout ?? 0)}
                  sub="pessoas que chegaram na tela de pagamento"
                  sensivel={false}
                />
                <Cartao
                  titulo="Clicaram em pagar com cartão"
                  span={4}
                  valor={inteiro(dados.cartao?.cliques ?? 0)}
                  sub={
                    (dados.cartao?.abriramCheckout ?? 0) > 0
                      ? `${Math.round(((dados.cartao?.cliques ?? 0) / (dados.cartao?.abriramCheckout ?? 1)) * 100)}% de quem abriu o checkout`
                      : 'saíram daqui para a Kiwify'
                  }
                  sensivel={false}
                  dica="Contagem nossa, por sessão. Quem toca no botão sai do site — sem este número ele sumia do funil."
                />
                <Cartao
                  titulo="Viraram venda paga"
                  span={4}
                  valor={
                    (dados.cartao?.cliques ?? 0) > 0
                      ? `${Math.round(((dados.cartao?.pagas ?? 0) / (dados.cartao?.cliques ?? 1)) * 100)}%`
                      : '—'
                  }
                  sub={`${inteiro(dados.cartao?.pagas ?? 0)} de ${inteiro(dados.cartao?.cliques ?? 0)} que clicaram`}
                  sensivel={false}
                  dica="Se este número for baixo, o problema está na página da Kiwify — não no nosso checkout."
                />
              </div>

              <div className="a-grid" style={{ marginTop: 10 }}>
                {/*
                  POR QUE O MOTIVO DA RECUSA TEM CARD PRÓPRIO: `refused_bank` e
                  `insufficient_funds` são do banco do comprador e ninguém aqui
                  resolve. `duplicate_link_order_email` é regra da KIWIFY — quem
                  teve o cartão negado e tentou de novo com outro é barrado por
                  e-mail repetido. Em 19/09/2026 eram 4 de 12 recusas. Separar os
                  motivos é a diferença entre "o mercado está ruim" e "tem uma
                  configuração sua barrando quem quer pagar".
                */}
                <div className="a-card" style={{ gridColumn: 'span 6' }}>
                  <h4>Por que o cartão foi negado</h4>
                  {Object.keys(dados.cartao?.motivos ?? {}).length === 0 ? (
                    <div className="a-sub">Nenhuma recusa no período.</div>
                  ) : (
                    <div style={{ fontSize: 12 }}>
                      {Object.entries(dados.cartao?.motivos ?? {})
                        .sort((a, b) => b[1].quantas - a[1].quantas)
                        .map(([motivo, m]) => (
                          <div key={motivo} style={{ display: 'flex', gap: 8, padding: '5px 0', alignItems: 'baseline' }}>
                            <span style={{ flex: 1 }}>
                              {motivo === 'duplicate_link_order_email' ? (
                                <>
                                  <b className="a-warn">e-mail repetido no mesmo link</b>
                                  <div className="a-sub">
                                    Regra da Kiwify, não do banco: a pessoa teve o cartão negado, tentou de novo com outro e
                                    foi barrada. É o único destes motivos que está na sua mão.
                                  </div>
                                </>
                              ) : motivo === 'refused_bank' ? (
                                <>
                                  banco negou
                                  <div className="a-sub">decisão do emissor do cartão — nada a fazer daqui</div>
                                </>
                              ) : motivo === 'insufficient_funds' ? (
                                <>
                                  limite insuficiente
                                  <div className="a-sub">o cartão não tinha limite para o valor</div>
                                </>
                              ) : (
                                motivo
                              )}
                            </span>
                            <span className="a-mut">{inteiro(m.quantas)}×</span>
                            <span className="a-neg">{brl(m.valor)}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/*
                  O PARCELAMENTO EXPLICA PARTE DA RECUSA. Medido em 19/09/2026:
                  um terço de quem pagou escolheu 11x ou 12x — R$ 47 em doze
                  vezes é R$ 4 por mês, e quem faz isso costuma estar com o
                  limite no talo. Casa com os `refused_bank`.
                */}
                <div className="a-card" style={{ gridColumn: 'span 6' }}>
                  <h4>
                    Em quantas vezes parcelaram
                    <span
                      className="a-dica"
                      title="Parcela longa e recusa andam juntas: R$ 47 em 12x é R$ 4 por mês, e quem escolhe isso costuma estar com o limite no talo."
                    >
                      ⓘ
                    </span>
                  </h4>
                  {Object.keys(dados.cartao?.parcelas ?? {}).length === 0 ? (
                    <div className="a-sub">Nenhuma venda paga no cartão no período.</div>
                  ) : (
                    <div style={{ fontSize: 12 }}>
                      {Object.entries(dados.cartao?.parcelas ?? {})
                        .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0))
                        .map(([p, n]) => (
                          <div key={p} style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
                            <span style={{ flex: 1 }}>{p === '—' ? 'não informado' : p}</span>
                            <span className={(parseInt(p, 10) || 0) >= 10 ? 'a-warn' : 'a-mut'}>{inteiro(n)} venda(s)</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="a-card" style={{ marginTop: 10 }}>
                <h4>De onde vieram as vendas no cartão</h4>
                <div className="a-sub" style={{ marginBottom: 8 }}>
                  A Kiwify devolve a UTM de cada venda — é assim que o cartão passa a contar no ROAS do criativo, junto do PIX.
                  Estas vendas <b>já estão</b> no Resumo, no Meta e no TikTok; aqui é só o recorte.
                </div>
                <PorLinhaSimples linhas={dados.cartao?.porOrigem ?? []} rotulo="Origem" />
              </div>

              <div className="a-card" style={{ marginTop: 10 }}>
                <h4>Por campanha</h4>
                <PorLinhaSimples linhas={dados.cartao?.porCampanha ?? []} rotulo="Campanha" />
              </div>
            </>
          ) : null}

          {secao === 'tiktok' && dados ? (
            <>
              {!dados.tiktok?.ligado ? (
                <div className="a-card" style={{ marginBottom: 12 }}>
                  <h4>
                    <span className="a-neg">●</span> TikTok Ads não conectado
                  </h4>
                  <div className="a-sub" style={{ lineHeight: 1.7 }}>
                    Para ler campanhas, grupos e anúncios do TikTok, o servidor precisa de duas variáveis na Vercel:{' '}
                    <b>TIKTOK_ADS_TOKEN</b> (chave da <b>Marketing API</b>, de um app de desenvolvedor autorizado pela conta de
                    anúncios) e <b>TIKTOK_ADVERTISER_ID</b> (o id da conta de anúncios). A chave da Events API — a que manda a
                    compra — não serve aqui: uma não abre a porta da outra.
                    <br />
                    Enquanto isso, as vendas que vieram do TikTok (com <b>ttclid</b>) já aparecem na aba Vendas e contam no
                    Resumo como "sem anúncio Meta".
                  </div>
                </div>
              ) : null}
              {dados.tiktok?.erro ? (
                <div className="a-card" style={{ marginBottom: 12 }}>
                  <h4>
                    <span className="a-neg">●</span> O TikTok recusou a leitura
                  </h4>
                  <div className="a-sub">{dados.tiktok.erro}</div>
                </div>
              ) : null}

              <div className="a-tabs">
                {(['campanhas', 'conjuntos', 'anuncios'] as Grao[]).map((g) => (
                  <button
                    key={g}
                    className="a-tab"
                    data-ativo={grao === g || (grao === 'contas' && g === 'campanhas') ? '1' : '0'}
                    onClick={() => setGrao(g)}
                  >
                    {g === 'campanhas' ? 'Campanhas' : g === 'conjuntos' ? 'Grupos' : 'Anúncios'}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <button className="a-tab" onClick={() => setModalColunas(true)} title="Personalize as colunas">
                  ⚙ Colunas
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <span className="a-sub">
                  Só leitura: pausar e ativar é no TikTok Ads Manager. Cada venda vai para UMA rede — aqui só as que
                  chegaram com <b>ttclid</b>.
                </span>
                <div style={{ flex: 1 }} />
                {dados.tiktok && dados.tiktok.semCarimbo > 0 ? (
                  <span
                    className="a-pil"
                    data-t="aviso"
                    title="Venda do TikTok sem utm_content na URL do anúncio: entra no total do TikTok, mas não cai em criativo nenhum. Acrescente utm_content=__CID__ e utm_term=__AID__ nos parâmetros de URL do anúncio."
                  >
                    {inteiro(dados.tiktok.semCarimbo)} venda(s) do TikTok sem criativo
                  </span>
                ) : null}
              </div>

              <Tabela
                linhas={linhas}
                colunas={colsAtivas}
                grao={grao === 'contas' ? 'campanhas' : grao}
                semStatus
                ordenar={ordenar}
                setOrdenar={setOrdenar}
                marcadas={marcadas}
                setMarcadas={setMarcadas}
                mexendo={mexendo}
                podeGerenciar={false}
                trocarStatus={trocarStatus}
                aoAbrir={setAberta}
                rodape={rodape}
              />
            </>
          ) : null}

          {/* ==================================================== UTMs */}
          {secao === 'utms' && dados ? (
            <>
              <div className="a-tabs">
                {(
                  [
                    ['origem', 'utm_source'],
                    ['campanha', 'utm_campaign'],
                    ['conjunto', 'utm_medium'],
                    ['criativo', 'utm_content'],
                    ['termo', 'utm_term'],
                  ] as Array<[string, string]>
                ).map(([v, r]) => (
                  <button key={v} className="a-tab" data-ativo={utmPor === v ? '1' : '0'} onClick={() => setUtmPor(v)}>
                    {r}
                  </button>
                ))}
              </div>
              <div className="a-card a-sub" style={{ marginBottom: 10 }}>
                Esta tabela <b>não tem gasto</b>, e não é esquecimento: o gasto do Meta vem por <code>ad_id</code>, e
                &quot;quanto gastei no utm_source&quot; não existe — ratear aqui produziria um ROAS por origem que
                parece informação e é chute. O que ela responde é de onde vem o dinheiro que o Gerenciador não credita a
                ninguém. A linha <b>(sem marcação)</b> é a marcação quebrada.
              </div>
              <Tabela
                linhas={linhas}
                colunas={colsAtivas}
                grao="anuncios"
                semStatus
                ordenar={ordenar}
                setOrdenar={setOrdenar}
                marcadas={marcadas}
                setMarcadas={setMarcadas}
                mexendo={mexendo}
                podeGerenciar={false}
                trocarStatus={trocarStatus}
                aoAbrir={setAberta}
                rodape={rodape}
              />
            </>
          ) : null}

          {/* ============================================ INTEGRAÇÕES */}
          {secao === 'integracoes' && dados ? (
            <div className="a-grid">
              <GatewaysPix senha={senha} avisar={avisar} aoSalvar={() => void buscar(senha, periodo, comparar)} />
              <PixelsTikTok senha={senha} avisar={avisar} />
              {INTEGRACOES.map(([chave, nome, consequencia]) => {
                const ok = dados.integracoes?.[chave] === true;
                return (
                  <div key={chave} className="a-card" style={{ gridColumn: 'span 6' }}>
                    <h4>
                      <span className={ok ? 'a-pos' : 'a-neg'}>●</span> {nome}
                    </h4>
                    <div className="a-sub">{ok ? 'Ligada.' : consequencia}</div>
                  </div>
                );
              })}
              <div className="a-card" style={{ gridColumn: 'span 12' }}>
                <h4>Permissão do token de anúncios</h4>
                <div className="a-sub">
                  {podeGerenciar
                    ? 'O token tem ads_management: pausar e ativar pelo painel funciona.'
                    : 'O token só lê (ads_read). O interruptor fica desligado até a permissão ads_management ser concedida ao usuário de sistema na BM.'}
                </div>
              </div>
            </div>
          ) : null}

          {/* ================================================== REGRAS */}
          {secao === 'regras' ? (
            <>
              <div className="a-card" style={{ marginBottom: 10 }}>
                <h4>Como as regras funcionam aqui</h4>
                <div className="a-sub">
                  Elas são avaliadas <b>quando o painel abre</b>, e não a cada 15 minutos num servidor. Isto é honesto e
                  não é preguiça: sem um processo próprio rodando, uma regra que promete pausar sozinha às 3h da manhã
                  não pausaria — e alguém dormiria confiando nela. Cada alerta abaixo traz o botão de pausar; a decisão
                  continua sendo de quem lê.
                </div>
              </div>
              <div className="a-filtros">
                <label>
                  Gastou sem vender (R$)
                  <input
                    type="number"
                    value={alertas.gastoSemVenda}
                    onChange={(e) => setAlertas((a) => ({ ...a, gastoSemVenda: Number(e.target.value) || 0 }))}
                  />
                </label>
                <label>
                  Teto de CPA (R$)
                  <input
                    type="number"
                    value={alertas.cpaTeto}
                    onChange={(e) => setAlertas((a) => ({ ...a, cpaTeto: Number(e.target.value) || 0 }))}
                  />
                </label>
                <label>
                  Break-even ROAS
                  <input value={dados?.config?.breakEvenRoas ?? ''} disabled placeholder="defina em Taxas" />
                </label>
              </div>
              <ListaDeAlertas
                problemas={problemas}
                podeGerenciar={podeGerenciar}
                mexendo={mexendo}
                trocarStatus={trocarStatus}
                reenviarPurchase={() => void reenviarPurchase()}
                reenviando={reenviando}
              />
            </>
          ) : null}

          {/* =================================================== TAXAS */}
          {secao === 'taxas' && dados ? (
            <FormTaxas
              config={dados.config ?? null}
              senha={senha}
              avisar={avisar}
              aoSalvar={() => void buscar(senha, periodo, comparar)}
            />
          ) : null}

          {/* ================================================ DESPESAS */}
          {secao === 'despesas' && dados ? (
            <FormDespesas
              config={dados.config ?? null}
              senha={senha}
              avisar={avisar}
              aoSalvar={() => void buscar(senha, periodo, comparar)}
            />
          ) : null}

          {/* ============================================== RELATÓRIOS */}
          {secao === 'relatorios' && dados ? (
            <div className="a-grid">
              <div className="a-card" style={{ gridColumn: 'span 6' }}>
                <h4>A tabela como está na tela</h4>
                <div className="a-sub">
                  {linhas.length} linha(s), nível {grao}, com as colunas visíveis e os filtros aplicados.
                </div>
                <button
                  className="a-btn"
                  style={{ marginTop: 10 }}
                  onClick={() =>
                    baixarCsv(`${grao}-${dados.periodo?.de}-a-${dados.periodo?.ate}.csv`, linhasParaCsv(linhas, colsAtivas))
                  }
                >
                  Baixar CSV
                </button>
              </div>
              <div className="a-card" style={{ gridColumn: 'span 6' }}>
                <h4>As vendas do período</h4>
                <div className="a-sub">
                  {vendasFiltradas.length} venda(s). <b>Contém nome, e-mail e telefone de quem comprou</b> — o arquivo
                  vai para a pasta de downloads e fica lá.
                </div>
                <button
                  className="a-btn"
                  style={{ marginTop: 10 }}
                  onClick={() =>
                    baixarCsv(`vendas-${dados.periodo?.de}-a-${dados.periodo?.ate}.csv`, vendasParaCsv(vendasFiltradas))
                  }
                >
                  Baixar CSV
                </button>
              </div>
              <div className="a-card" style={{ gridColumn: 'span 12' }}>
                <h4>Vendas do período</h4>
                <TabelaVendas
                  vendas={vendasFiltradas}
                  aoApagar={(v) => void apagarPedido(v)}
                  aoMarcarPaga={(v) => void marcarComoPaga(v)}
                />
              </div>
            </div>
          ) : null}

          {/* ================================================= EVENTOS */}
          {secao === 'clientes' && dados ? <ClientesEPix vendas={vendasFiltradas} /> : null}

          {secao === 'eventos' && dados ? <Eventos vendas={vendasFiltradas} /> : null}

          {/* =========================================== NOTIFICAÇÕES */}
          {secao === 'leads' ? <Leads senha={senha} avisar={avisar} /> : null}
          {secao === 'rastreio' ? <CentralDeRastreio senha={senha} avisar={avisar} /> : null}
          {secao === 'notificacoes' ? <AvisoNoCelular senha={senha} avisar={avisar} /> : null}
          {secao === 'notificacoes' ? (
            <ListaDeAlertas
                problemas={problemas}
                podeGerenciar={podeGerenciar}
                mexendo={mexendo}
                trocarStatus={trocarStatus}
                reenviarPurchase={() => void reenviarPurchase()}
                reenviando={reenviando}
              />
          ) : null}
        </main>
      </div>

      {/* ---------------------------------------------------------- gaveta */}
      {aberta ? (
        <>
          <div className="a-gaveta-fundo" onClick={() => setAberta(null)} />
          <aside className="a-gaveta">
            <Gaveta
              linha={aberta}
              vendas={vendasDaLinha(
                dados?.vendas ?? [],
                aberta,
                grao,
                aberta.plataforma === 'tiktok' ? (dados?.tiktok?.anuncios ?? []) : (dados?.anuncios ?? []),
              )}
              grao={grao}
              linkExterno={
                aberta.plataforma === 'tiktok'
                  ? `https://ads.tiktok.com/i18n/perf/campaign${dados?.tiktok?.advertiserId ? `?aadvid=${dados.tiktok.advertiserId}` : ''}`
                  : undefined
              }
              conta={dados?.conta ?? null}
              podeGerenciar={podeGerenciar}
              mexendo={mexendo.has(aberta.id)}
              trocarStatus={trocarStatus}
              aoFechar={() => setAberta(null)}
            />
          </aside>
        </>
      ) : null}

      {/* ----------------------------------------------- modal de colunas */}
      {modalColunas ? (
        <ModalColunas
          ativas={colunas[grao] ?? PADRAO[grao] ?? []}
          aoFechar={() => setModalColunas(false)}
          aoSalvar={(novas) => {
            setColunas((c) => ({ ...c, [grao]: novas }));
            setModalColunas(false);
          }}
        />
      ) : null}

      {esquina ? (
        <div className="a-esq" data-t={esquina.tipo}>
          {esquina.texto}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* A TABELA                                                                    */
/* -------------------------------------------------------------------------- */

function celula(c: Coluna, l: Linha): { texto: string; classe: string } {
  const v = c.valor(l);
  if (typeof v === 'string') return { texto: v, classe: '' };
  if (v === null || v === undefined) return { texto: 'N/A', classe: 'a-mut' };

  let texto: string;
  if (c.tipo === 'moeda') texto = brl(v);
  else if (c.tipo === 'int') texto = inteiro(v);
  else if (c.tipo === 'pct') texto = pct(v);
  else if (c.tipo === 'x') texto = vezes(v);
  else texto = String(v);

  /*
   * ONDE A COR ENTRA, E ONDE ELA NÃO ENTRA.
   *
   * Vermelho é para dinheiro perdido: lucro negativo, e ROAS abaixo de 1 EM
   * LINHA QUE GASTOU. Anúncio com gasto zero e ROAS N/A não é ruim, é novo —
   * pintá-lo de vermelho ensina o olho a ignorar a cor, e aí ela deixa de
   * servir na linha que importa.
   */
  let classe = '';
  if (c.id === 'lucro' || c.id === 'roi' || c.id === 'margem') classe = v < 0 ? 'a-neg' : v > 0 ? 'a-pos' : '';
  if (c.id === 'roas') classe = l.gasto > 0 ? (v >= 1 ? 'a-pos' : 'a-neg') : '';
  return { texto, classe };
}

function Tabela({
  linhas,
  colunas,
  grao,
  semStatus,
  ordenar,
  setOrdenar,
  marcadas,
  setMarcadas,
  mexendo,
  podeGerenciar,
  trocarStatus,
  aoAbrir,
  rodape,
}: {
  linhas: Linha[];
  colunas: Coluna[];
  grao: Grao;
  semStatus?: boolean;
  ordenar: { col: string; desc: boolean };
  setOrdenar: (o: { col: string; desc: boolean }) => void;
  marcadas: Set<string>;
  setMarcadas: (s: Set<string>) => void;
  mexendo: Set<string>;
  podeGerenciar: boolean;
  trocarStatus: (ids: string[], para: 'ACTIVE' | 'PAUSED') => void;
  aoAbrir: (l: Linha) => void;
  rodape: { gasto: number; receita: number; pagas: number; pix: number; lucro: number; temLucro: boolean };
}) {
  const clicarCabecalho = (id: string) => setOrdenar({ col: id, desc: ordenar.col === id ? !ordenar.desc : true });

  if (linhas.length === 0) {
    return (
      <div className="a-card a-mut" style={{ textAlign: 'center', padding: 32 }}>
        Nenhuma venda por aqui.
      </div>
    );
  }

  /*
   * O RODAPÉ SÓ SOMA O QUE SE SOMA. CTR total não é a soma dos CTRs, e um
   * rodapé com "ROAS 43,7x" (a soma dos ROAS de vinte anúncios) seria pior que
   * rodapé nenhum. Só as grandezas absolutas aparecem; o resto fica em branco
   * de propósito.
   */
  const totalDaColuna: Record<string, string> = {
    gasto: brl(rodape.gasto),
    receita: brl(rodape.receita),
    pagas: inteiro(rodape.pagas),
    pix: inteiro(rodape.pix),
    lucro: rodape.temLucro ? brl(rodape.lucro) : 'N/A',
  };

  return (
    <div className="a-rolo">
      <table className="a-tab-t">
        <thead>
          <tr>
            {!semStatus ? (
              <th className="esq" style={{ width: 34 }}>
                <input
                  type="checkbox"
                  checked={marcadas.size > 0 && marcadas.size === linhas.length}
                  onChange={(e) => setMarcadas(e.target.checked ? new Set(linhas.map((l) => l.id)) : new Set())}
                />
              </th>
            ) : null}
            {!semStatus ? (
              <th className="esq" style={{ width: 60 }}>
                Status
              </th>
            ) : null}
            <th className="esq" onClick={() => clicarCabecalho('nome')}>
              {grao === 'campanhas' ? 'Campanha' : grao === 'conjuntos' ? 'Conjunto' : 'Anúncio'}
            </th>
            {colunas.map((c) => (
              <th key={c.id} onClick={() => clicarCabecalho(c.id)} title={c.dica}>
                {c.rotulo}
                {ordenar.col === c.id ? (ordenar.desc ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.id} onClick={() => aoAbrir(l)}>
              {!semStatus ? (
                <td className="esq" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={marcadas.has(l.id)}
                    onChange={(e) => {
                      const n = new Set(marcadas);
                      if (e.target.checked) n.add(l.id);
                      else n.delete(l.id);
                      setMarcadas(n);
                    }}
                  />
                </td>
              ) : null}
              {!semStatus ? (
                <td className="esq">
                  <Interruptor
                    ligado={l.status === 'ACTIVE'}
                    podeMexer={podeGerenciar && /^\d{5,}$/.test(l.id)}
                    carregando={mexendo.has(l.id)}
                    motivo={
                      !podeGerenciar
                        ? 'Conecte a conta Meta com permissão de gerenciar anúncios (ads_management).'
                        : 'Esta linha não é um objeto do Meta.'
                    }
                    aoTrocar={() => trocarStatus([l.id], l.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')}
                  />
                </td>
              ) : null}
              <td className="esq">
                <div className="a-nome">
                  {l.thumb ? (
                    <img
                      src={l.thumb}
                      alt=""
                      loading="lazy"
                      /*
                       * O LINK DA MINIATURA VENCE. O Meta assina a URL do
                       * thumbnail e ela expira; sem isto, a linha fica com um
                       * retângulo cinza que parece criativo sem imagem — e o
                       * dono procura defeito no anúncio.
                       */
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : null}
                  <div style={{ minWidth: 0 }}>
                    <div className="a-nome-t">
                      {l.nome || l.id}
                      {/*
                        LIGADO E PARADO É O ESTADO QUE MAIS ENGANA. O interruptor
                        mostra o status DESTE objeto, que é o que ele troca — mas
                        um anúncio ACTIVE dentro de campanha pausada não roda. Sem
                        este selo, o painel mostraria dez interruptores verdes numa
                        conta que não está entregando nada, e alguém esperaria
                        venda a semana inteira.
                      */}
                      {l.status === 'ACTIVE' && l.efetivo && l.efetivo !== 'ACTIVE' ? (
                        <span className="a-pil" data-t="aviso" style={{ marginLeft: 6 }}>
                          {l.efetivo.toLowerCase().replace(/_/g, ' ')}
                        </span>
                      ) : null}
                    </div>
                    <div className="a-nome-s">
                      {grao === 'anuncios' && (l.campanha || l.conjunto)
                        ? `${l.campanha}${l.conjunto ? ` · ${l.conjunto}` : ''}`
                        : `${inteiro(l.cliques)} cliques · ${inteiro(l.impressoes)} impressões`}
                    </div>
                  </div>
                </div>
              </td>
              {colunas.map((c) => {
                const { texto, classe } = celula(c, l);
                return (
                  <td key={c.id} className={`${classe} ${c.tipo === 'moeda' ? 'a-sensivel' : ''}`}>
                    {texto}
                    {c.id === 'orcamento' && l.tipoOrcamento ? (
                      <div className="a-sub">{l.tipoOrcamento === 'diario' ? 'Diário' : 'Vitalício'}</div>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            {!semStatus ? <td /> : null}
            {!semStatus ? <td /> : null}
            <td className="esq">
              {linhas.length} {grao === 'campanhas' ? 'campanhas' : grao === 'conjuntos' ? 'conjuntos' : 'linhas'}
            </td>
            {colunas.map((c) => (
              <td key={c.id} className="a-sensivel">
                {totalDaColuna[c.id] ?? ''}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* MODAL DE COLUNAS                                                            */
/* -------------------------------------------------------------------------- */

function ModalColunas({
  ativas,
  aoFechar,
  aoSalvar,
}: {
  ativas: string[];
  aoFechar: () => void;
  aoSalvar: (n: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>(ativas);
  const [busca, setBusca] = useState('');
  const arrastando = useRef<number | null>(null);
  const [sobre, setSobre] = useState<number | null>(null);

  const termo = busca.trim().toLowerCase();

  return (
    <div className="a-modal-fundo" onClick={aoFechar}>
      <div className="a-modal" onClick={(e) => e.stopPropagation()}>
        <div className="a-modal-h">Personalize as colunas</div>
        <div className="a-modal-b">
          <div className="a-modal-col">
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por coluna"
              style={{ width: '100%', marginBottom: 8 }}
            />
            {GRUPOS.map((g) => {
              const doGrupo = COLUNAS.filter((c) => c.grupo === g && (!termo || c.rotulo.toLowerCase().includes(termo)));
              if (doGrupo.length === 0) return null;
              return (
                <div key={g}>
                  <div className="a-grupo">{g}</div>
                  {doGrupo.map((c) => (
                    <label key={c.id} className="a-chk" title={c.dica}>
                      <input
                        type="checkbox"
                        checked={sel.includes(c.id)}
                        onChange={(e) => setSel((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                      />
                      {c.rotulo}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="a-modal-col">
            <div className="a-grupo">Colunas ativas — arraste para reordenar</div>
            {sel.length === 0 ? <div className="a-sub">Nenhuma coluna escolhida.</div> : null}
            {sel.map((id, i) => {
              const c = PORID.get(id);
              if (!c) return null;
              return (
                <div
                  key={id}
                  className="a-arr"
                  data-sobre={sobre === i ? '1' : '0'}
                  draggable
                  onDragStart={() => {
                    arrastando.current = i;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setSobre(i);
                  }}
                  onDragLeave={() => setSobre(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const de = arrastando.current;
                    setSobre(null);
                    arrastando.current = null;
                    if (de === null || de === i) return;
                    setSel((s) => {
                      const n = [...s];
                      const [movido] = n.splice(de, 1);
                      n.splice(i, 0, movido);
                      return n;
                    });
                  }}
                >
                  <span className="a-mut">⣿</span>
                  <span style={{ flex: 1 }}>{c.rotulo}</span>
                  <button className="a-mut" onClick={() => setSel((s) => s.filter((x) => x !== id))} title="Remover">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="a-modal-f">
          <button className="a-btn2" onClick={aoFechar}>
            Cancelar
          </button>
          <button className="a-btn" onClick={() => aoSalvar(sel)}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* GAVETA                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * O ID DO ANÚNCIO CARIMBADO NA VENDA: o último pedaço do `utm_content`
 * ("nome|id" ou só "id"). Espelho exato de `adIdDaVenda` em api/index.ts — os
 * dois precisam concordar, senão a tabela soma uma coisa e a gaveta lista outra.
 */
function adIdDaVenda(v: Venda): string {
  const bruto = (v.attrib?.criativo ?? '').trim();
  if (!bruto) return '';
  return bruto.includes('|') ? (bruto.split('|').pop() ?? '').trim() : bruto;
}

/**
 * AS VENDAS DE UMA LINHA, EM QUALQUER GRÃO.
 *
 * A gaveta abre para anúncio, conjunto e campanha, mas a venda só carrega o id
 * do ANÚNCIO. A primeira versão comparava esse id com `linha.id` sempre — e na
 * aba Campanhas a gaveta dizia "Nenhuma venda" com "Vendas 2" logo acima, porque
 * estava comparando id de anúncio com id de campanha.
 *
 * Para conjunto/campanha, o caminho é o MESMO que o servidor usa para somar
 * `pagas`: subir pela hierarquia dos anúncios do período (`campanhaId` /
 * `conjuntoId`). A UTM da campanha (`utm_campaign`) e do conjunto (`utm_term`)
 * entram só como rede de segurança, para a venda cujo anúncio não aparece na
 * lista do período (pausado hoje, clique de ontem).
 */
function vendasDaLinha(vendas: Venda[], linha: Linha, grao: Grao, anuncios: Linha[]): Venda[] {
  if (grao === 'contas') return vendas;
  if (grao === 'anuncios') return vendas.filter((v) => adIdDaVenda(v) === linha.id);
  const campo: 'campanhaId' | 'conjuntoId' = grao === 'campanhas' ? 'campanhaId' : 'conjuntoId';
  const utm = grao === 'campanhas' ? 'campanha' : 'termo';
  const idsDosAnuncios = new Set(anuncios.filter((a) => a[campo] === linha.id).map((a) => a.id));
  return vendas.filter(
    (v) => idsDosAnuncios.has(adIdDaVenda(v)) || (v.attrib?.[utm] ?? '').trim() === linha.id,
  );
}

function Gaveta({
  linha,
  vendas,
  grao,
  conta,
  podeGerenciar,
  mexendo,
  trocarStatus,
  aoFechar,
  linkExterno,
}: {
  linha: Linha;
  vendas: Venda[];
  grao: Grao;
  conta: Conta | null;
  podeGerenciar: boolean;
  mexendo: boolean;
  trocarStatus: (ids: string[], para: 'ACTIVE' | 'PAUSED') => void;
  aoFechar: () => void;
  /** Para linha do TikTok: o endereço do TikTok Ads Manager. O link do Meta é montado aqui dentro. */
  linkExterno?: string | null;
}) {
  const d = linha.d;
  const eTikTok = linha.plataforma === 'tiktok';
  const oQue = grao === 'campanhas' ? 'desta campanha' : grao === 'conjuntos' ? 'deste conjunto' : 'deste anúncio';
  const link = eTikTok
    ? (linkExterno ?? null)
    : conta?.id && /^\d{5,}$/.test(linha.id)
      ? `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${conta.id.replace('act_', '')}&selected_ad_ids=${linha.id}`
      : null;

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {linha.thumb ? (
          <img src={linha.thumb} alt="" style={{ width: 64, height: 64, borderRadius: 6, objectFit: 'cover' }} />
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{linha.nome || linha.id}</div>
          <div className="a-sub">
            {linha.campanha} {linha.conjunto ? `· ${linha.conjunto}` : ''}
          </div>
          <div className="a-sub">{linha.id}</div>
        </div>
        <button className="a-icone" onClick={aoFechar}>
          ✕
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '14px 0', flexWrap: 'wrap' }}>
        <Interruptor
          ligado={linha.status === 'ACTIVE'}
          podeMexer={podeGerenciar && !eTikTok && /^\d{5,}$/.test(linha.id)}
          carregando={mexendo}
          motivo={
            eTikTok
              ? 'Pausar e ativar anúncio do TikTok é pelo TikTok Ads Manager — este painel só lê o TikTok.'
              : 'Conecte a conta Meta com permissão de gerenciar anúncios.'
          }
          aoTrocar={() => trocarStatus([linha.id], linha.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')}
        />
        <span className="a-sub">
          {linha.status === 'ACTIVE' ? 'Ativo' : 'Pausado'}
          {linha.efetivo && linha.efetivo !== linha.status
            ? ` · o Meta diz: ${linha.efetivo.toLowerCase().replace(/_/g, ' ')}`
            : ''}
        </span>
        <div style={{ flex: 1 }} />
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="a-btn2">
            {eTikTok ? 'Abrir no TikTok Ads ↗' : 'Abrir no Gerenciador ↗'}
          </a>
        ) : null}
      </div>

      <div className="a-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <Cartao titulo="Gasto" span={1} valor={brl(linha.gasto)} />
        <Cartao titulo="Faturamento" span={1} valor={brl(linha.receita)} />
        <Cartao titulo="ROAS" span={1} valor={vezes(d.roas)} cor={d.roas === null ? undefined : d.roas >= 1 ? 'pos' : 'neg'} />
        <Cartao
          titulo="Lucro"
          span={1}
          valor={d.lucro === null ? 'N/A' : brl(d.lucro)}
          cor={d.lucro === null ? 'mut' : d.lucro < 0 ? 'neg' : 'pos'}
        />
        <Cartao titulo="PIX gerado" span={1} valor={inteiro(linha.pix)} sensivel={false} />
        <Cartao titulo="Vendas" span={1} valor={inteiro(linha.pagas)} sensivel={false} />
        <Cartao titulo="CPA" span={1} valor={brl(d.cpa)} />
        <Cartao titulo="CTR" span={1} valor={pct(d.ctr)} sensivel={false} />
      </div>

      {/*
        O MESMO FUNIL DO TOPO, SÓ QUE DESTE ITEM. Os cliques são os NO LINK,
        como no funil geral (o `cliques` cru do Meta conta curtida); se o Meta
        não trouxe cliques no link, cai para o cru em vez de mostrar zero.
      */}
      <MetaConversionFunnel
        embutido
        rede={eTikTok ? 'tiktok' : 'meta'}
        titulo={`Funil ${oQue}`}
        dados={{
          cliques: linha.cliquesNoLink || linha.cliques,
          lpViews: linha.lpViews,
          ics: linha.ics,
          vendasIniciadas: linha.pix,
          vendasAprovadas: linha.pagas,
        }}
      />

      {/*
        O CAMINHO INTEIRO NUMA LINHA. É a pergunta que a tabela não responde:
        ONDE o dinheiro parou. Clique que não vira visita é site lento ou link
        errado; visita que não vira PIX é oferta; PIX que não vira venda é preço
        ou confiança. Sem isto, "o CV1 não vendeu" não diz por quê.
      */}
      <div className="a-card" style={{ marginTop: 12 }}>
        <h4>O caminho</h4>
        <div style={{ fontSize: 12, lineHeight: 1.9 }}>
          {inteiro(linha.impressoes)} impressões → {inteiro(linha.cliques)} cliques → {inteiro(linha.lpViews)} abriram a
          página → {inteiro(linha.pix)} geraram PIX → <b>{inteiro(linha.pagas)} pagaram</b>
        </div>
        <div className="a-sub">
          {linha.lpViews > 0
            ? `Taxa de conexão ${pct(razao(linha.lpViews, linha.cliques))} · ICR ${pct(razao(linha.pix, linha.lpViews))}`
            : 'Sem visualizações de página no período — o PageView do Pixel pode não estar chegando para este anúncio.'}
        </div>
      </div>

      {linha.videoIniciados > 0 ? (
        <div className="a-card" style={{ marginTop: 10 }}>
          <h4>O vídeo</h4>
          <div className="a-sub">
            Hook {pct(razao(linha.video3s, linha.impressoes))} · Retenção até 75%{' '}
            {pct(razao(linha.video75, linha.videoIniciados))} · CTA {pct(razao(linha.cliquesNoLink, linha.video75))}
          </div>
        </div>
      ) : null}

      <div className="a-card" style={{ marginTop: 10 }}>
        <h4>Últimas vendas {oQue}</h4>
        {vendas.length === 0 ? (
          <div className="a-sub">
            {linha.pagas > 0
              ? /* A tabela contou, a lista não achou: o carimbo dessas vendas não bate com este id. Dizer "ninguém chegou" aqui seria mentir contra o número logo acima. */
                `${inteiro(linha.pagas)} venda(s) contadas na tabela, mas o carimbo (utm) delas não aponta para este id — veja a aba Vendas.`
              : linha.gasto > 0
                ? `Nenhuma. Gastou ${brl(linha.gasto)} e ninguém chegou ao checkout.`
                : 'Nenhuma venda e nenhum gasto no período.'}
          </div>
        ) : (
          <div style={{ fontSize: 12 }}>
            {vendas.slice(0, 20).map((v) => (
              <div key={v.id} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--bd)' }}>
                <span className={v.status === 'completed' ? 'a-pos' : 'a-mut'}>●</span>
                <span className="a-sensivel" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {v.nome}
                </span>
                <span className="a-sensivel">{brl(v.valor)}</span>
                <span className="a-mut">{dataCurta(v.criadoEm)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/*
        AS UTMs, MAS NÃO O `fbc` INTEIRO.
        A primeira versão despejava o `attrib` cru aqui, e a caixa virava uma
        parede de 400 caracteres de identificador de clique — ilegível, e com o
        `fbclid` de uma pessoa específica na tela de um painel que se abre em
        reunião. O que interessa saber é se o carimbo CHEGOU, não qual era.
      */}
      <div className="a-card" style={{ marginTop: 10 }}>
        <h4>Como a marcação chegou</h4>
        {vendas.length === 0 ? (
          <div className="a-sub">—</div>
        ) : (
          <div style={{ fontSize: 12 }}>
            {(
              [
                ['origem', 'utm_source'],
                ['campanha', 'utm_campaign'],
                ['conjunto', 'utm_medium'],
                ['criativo', 'utm_content'],
                ['termo', 'utm_term'],
              ] as Array<[string, string]>
            ).map(([campo, rotulo]) => {
              const valores = [...new Set(vendas.map((v) => (v.attrib?.[campo] ?? '').trim()).filter(Boolean))];
              return (
                <div key={campo} style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
                  <span className="a-mut" style={{ flex: '0 0 110px' }}>
                    {rotulo}
                  </span>
                  <span style={{ flex: 1, wordBreak: 'break-word' }}>
                    {valores.length === 0 ? <span className="a-neg">não veio</span> : valores.slice(0, 3).join(' · ')}
                  </span>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, padding: '3px 0', borderTop: '1px solid var(--bd)', marginTop: 4 }}>
              <span className="a-mut" style={{ flex: '0 0 110px' }} title="É o que faz o Meta casar a venda com o CLIQUE. Sem ele, a venda entra no Gerenciador sem dono.">
                fbc / fbclid
              </span>
              <span style={{ flex: 1 }}>
                {vendas.filter((v) => v.attrib?.fbc || v.attrib?.fbclid).length} de {vendas.length} vendas
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
              <span className="a-mut" style={{ flex: '0 0 110px' }} title="O clique do TikTok. Venda com ttclid vai SÓ para o TikTok (Events API), nunca para o Meta.">
                ttclid (TikTok)
              </span>
              <span style={{ flex: 1 }}>
                {vendas.filter((v) => v.attrib?.ttclid).length} de {vendas.length} vendas
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* O FUNIL DE CONVERSÃO                                                        */
/* -------------------------------------------------------------------------- */

interface FunilMeta {
  cliques: number;
  lpViews: number;
  ics: number;
  vendasIniciadas: number;
  vendasAprovadas: number;
}

/**
 * O FUNIL DO SITE — uma régua só, e é por isso que ele existe.
 *
 * O funil de baixo (ETAPAS_FUNIL) tira as três primeiras etapas do Meta
 * Insights: ele conta só o que consegue atribuir aos anúncios DELE. Enquanto
 * todo o tráfego vinha do Meta isso batia. Com o TikTok trazendo a maior parte,
 * virou mentira — em 18/09/2026 o Pixel recebeu 62 InitiateCheckout e o Resumo
 * desenhava **1**, porque só 1 tinha vindo de anúncio do Meta.
 *
 * Estas etapas saem do NOSSO contador de sessões, que não sabe o que é Meta nem
 * TikTok. É a única régua que não muda quando a fonte de tráfego muda.
 */
const ETAPAS_SITE: Array<{ rotulo: string; campo: string; dica: string }> = [
  { rotulo: 'Chegaram', campo: 'chegou', dica: 'Sessões que abriram o site no período, de qualquer origem.' },
  { rotulo: 'Quiz', campo: 'quiz', dica: 'Começaram a responder o quiz — o primeiro sinal de interesse real.' },
  { rotulo: 'VSL', campo: 'vsl', dica: 'Chegaram na tela do vídeo de vendas.' },
  { rotulo: 'Checkout', campo: 'checkout', dica: 'Abriram o checkout abaixo da VSL.' },
  { rotulo: 'PIX gerado', campo: 'pix', dica: 'Geraram a cobrança. Daqui para a frente é só pagar.' },
  { rotulo: 'Pagaram', campo: 'pagas', dica: 'Pagamento confirmado pelo gateway. Mesmo número do faturamento do topo.' },
];

const ETAPAS_FUNIL: Array<{ rotulo: string; campo: keyof FunilMeta; fonte: 'meta' | 'nosso'; dica: string }> = [
  { rotulo: 'Cliques', campo: 'cliques', fonte: 'meta', dica: 'Cliques NO LINK. O "cliques" cru do Meta conta curtida e comentário.' },
  { rotulo: 'Vis. Página', campo: 'lpViews', fonte: 'meta', dica: 'O Pixel confirmou que a página abriu.' },
  { rotulo: 'ICs', campo: 'ics', fonte: 'meta', dica: 'InitiateCheckout — o clique no botão da VSL.' },
  {
    rotulo: 'Vendas Inic.',
    campo: 'vendasIniciadas',
    fonte: 'nosso',
    dica: 'PIX gerado: todos os pedidos do período, inclusive os que perderam o carimbo do anúncio na URL.',
  },
  {
    rotulo: 'Vendas Apr.',
    campo: 'vendasAprovadas',
    fonte: 'nosso',
    dica: 'Pagos. É o MESMO número do cartão de faturamento do topo — se os dois discordarem, um dos dois está errado.',
  },
];

/**
 * ============================================================================
 * A ÁREA É SIMÉTRICA E A ESCALA É RAIZ QUADRADA — as duas coisas de propósito
 * ============================================================================
 *
 * `halfHeight = 90 * sqrt(n / cliques)`. Com escala linear, a última etapa
 * (5 vendas em 868 cliques) teria meia-altura de 0,5 px: o bico do funil
 * simplesmente sumiria, e a etapa que mais importa seria a invisível. A raiz
 * comprime o topo e mantém o fim legível.
 *
 * A CONSEQUÊNCIA, e ela é honesta de dizer: **a área não é proporcional ao
 * número.** Quem lê a forma vê a ordem de grandeza, não a razão — e é por isso
 * que a porcentagem e o valor absoluto estão escritos em cima de cada eixo. O
 * desenho orienta; o número informa.
 *
 * A CURVA É UM CÚBICO COM CONTROLES NO MEIO DO VÃO, e não Catmull-Rom. O
 * Catmull-Rom passa pelos pontos mas ULTRAPASSA entre eles quando a queda é
 * brusca — e aqui a queda de 189 para 12 é brusca. Uma barriga acima do valor
 * real desenharia uma etapa que não existe. Este cúbico é monotônico por
 * construção: entre dois eixos ele nunca sobe acima do maior nem desce abaixo
 * do menor.
 */
function MetaConversionFunnel({
  dados,
  titulo = 'Funil de Conversão (Meta Ads)',
  embutido = false,
  rede = 'meta',
  passos,
  rodape,
}: {
  dados: FunilMeta | Record<string, number>;
  /** As etapas a desenhar. Sem isto, usa as cinco do Meta. */
  passos?: Array<{ rotulo: string; campo: string; fonte?: 'meta' | 'nosso'; dica: string }>;
  /** A frase de baixo, quando o funil não é o do Meta. */
  rodape?: React.ReactNode;
  /** Título do card. A gaveta passa "Funil deste anúncio" / "…desta campanha". */
  titulo?: string;
  /** De onde vêm as três primeiras etapas — só muda o rótulo da fonte no rodapé. */
  rede?: 'meta' | 'tiktok';
  /**
   * EMBUTIDO = dentro da gaveta (520 px de largura). Sai da grade de 8 colunas
   * e as letras do SVG crescem 1,7x: o desenho tem 800 unidades e ali é
   * escalado para ~440 px — sem o fator, o texto de 12 unidades viraria 6 px
   * na tela, e o funil que existe para ser lido ficaria ilegível.
   */
  embutido?: boolean;
}) {
  const [sobre, setSobre] = useState<number | null>(null);
  const F = embutido ? 1.7 : 1;

  /*
   * AS ETAPAS SÃO UMA LISTA, e não cinco fixas. O funil do site tem seis; o do
   * Meta tem cinco. Os eixos são calculados a partir da quantidade — com X
   * escrito na mão, a sexta etapa cairia fora do desenho.
   */
  const etapas: Array<{ rotulo: string; campo: string; fonte?: 'meta' | 'nosso'; dica: string }> =
    passos ?? (ETAPAS_FUNIL as Array<{ rotulo: string; campo: string; fonte?: 'meta' | 'nosso'; dica: string }>);
  const L = 800;
  const A = 260;
  const MEIO = 130;
  const MAX = 90;
  const MARGEM = 80;
  const X = etapas.map((_, i) =>
    etapas.length === 1 ? L / 2 : MARGEM + (i * (L - 2 * MARGEM)) / (etapas.length - 1),
  );

  const contagens = etapas.map((e) => Math.max(0, Number((dados as Record<string, unknown>)?.[e.campo] ?? 0)));
  const base = contagens[0];

  /* Sem clique não há denominador. Os cinco eixos aparecem zerados -- esconder
     o card faria parecer que a medição sumiu, quando ela só está em zero. */
  const fracao = (n: number) => (base > 0 ? n / base : 0);
  const meia = (n: number) => (base > 0 ? MAX * Math.sqrt(fracao(n)) : 0);
  const meias = contagens.map(meia);

  /** Uma borda: cúbico por vão, com os dois controles na metade horizontal. */
  const borda = (pts: readonly (readonly [number, number])[]) => {
    let s = '';
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const mx = (x1 + x2) / 2;
      s += ` C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    }
    return s;
  };

  const topo = X.map((x, i) => [x, MEIO - meias[i]] as const);
  const baixo = X.map((x, i) => [x, MEIO + meias[i]] as const).reverse();
  const d = `M ${topo[0][0]} ${topo[0][1]}${borda(topo)} L ${baixo[0][0]} ${baixo[0][1]}${borda(baixo)} Z`;

  return (
    /*
     * `alignSelf: stretch` E O DESENHO CENTRADO: sem os dois, o funil termina
     * na altura do proprio conteudo e a coluna de custos ao lado -- que e mais
     * alta -- deixa um buraco de 150 px de nada embaixo dele.
     */
    <div
      className={embutido ? 'a-card a-funil-card' : 'a-card a-funil-card'}
      style={embutido ? { marginTop: 12 } : { gridColumn: 'span 8', alignSelf: 'stretch' }}
    >
      <h4>
        {titulo}
        <span
          className="a-dica"
          title={
            embutido
              ? 'Percentual de cada etapa sobre os CLIQUES NO LINK deste item, não sobre a etapa anterior. Cliques, Vis. Página e ICs vêm do Meta; Vendas Inic. e Vendas Apr. são os pedidos do nosso registro carimbados com este anúncio (ou com os anúncios deste conjunto/campanha).'
              : 'Percentual de cada etapa sobre os CLIQUES do período, não sobre a etapa anterior. Cliques, Vis. Página e ICs vêm do Meta; Vendas Inic. e Vendas Apr. do nosso registro, e contam TODOS os pedidos do período — inclusive os que perderam o carimbo do anúncio na URL, que continuam fora da tabela por criativo.'
          }
        >
          ⓘ
        </span>
      </h4>

      <div className="a-funil-rolo">
        <svg
          viewBox={`0 0 ${L} ${A}`}
          className={embutido ? 'a-funil a-funil--gaveta' : 'a-funil'}
          role="img"
          aria-label="Funil de conversão"
        >
          <defs>
            <linearGradient id="a-funil-g" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#2563eb" />
              <stop offset="55%" stopColor="#4f46e5" />
              <stop offset="100%" stopColor="#c026d3" />
            </linearGradient>
          </defs>

          {X.map((x, i) => (
            <line key={`e${i}`} x1={x} y1={34} x2={x} y2={232} stroke="#3a4558" strokeWidth={1} />
          ))}

          <path d={d} fill="url(#a-funil-g)" opacity={0.95} />

          {etapas.map((etapa, i) => {
            const n = contagens[i];
            const p = fracao(n);
            /*
             * O RÓTULO SAI DE DENTRO QUANDO A FATIA APERTA. Abaixo de ~11 px de
             * meia-altura o texto encosta nas duas bordas e fica ilegível sobre
             * o gradiente; aí ele sobe para cima da linha, que é o que a
             * referência faz nas duas últimas etapas.
             */
            const dentro = meias[i] >= 11 * F;
            return (
              <g key={etapa.rotulo}>
                <text x={X[i]} y={18} textAnchor="middle" fill="#8b95a8" fontSize={12 * F}>
                  {etapa.rotulo}
                </text>
                <text
                  x={X[i]}
                  y={dentro ? MEIO + 5 * F : MEIO - meias[i] - 8 * F}
                  textAnchor="middle"
                  fill={dentro ? '#ffffff' : '#e8edf5'}
                  fontSize={13 * F}
                  fontWeight={600}
                >
                  {base > 0 ? `${n1.format(p * 100)}%` : '0,0%'}
                </text>
                <text x={X[i]} y={248} textAnchor="middle" fill="#8b95a8" fontSize={12 * F}>
                  {inteiro(n)}
                </text>
                {/* A área de toque é a coluna inteira, não a linha de 1 px. */}
                <rect
                  x={X[i] - 78}
                  y={0}
                  width={156}
                  height={A}
                  fill="transparent"
                  style={{ cursor: 'help' }}
                  onMouseEnter={() => setSobre(i)}
                  onMouseLeave={() => setSobre(null)}
                />
              </g>
            );
          })}
        </svg>
      </div>

      {/*
        O DROP FICA NO HOVER, e não escrito no desenho -- a referência não tem
        essa linha, e escrever oito números a mais em cima do gradiente é o que
        transforma um gráfico em tabela ruim.
      */}
      <div className="a-sub" style={{ minHeight: 32 }}>
        {sobre === null ? (
          rodape ? (
            rodape
          ) : embutido ? (
            <>
              O caminho de quem clicou <b>neste item</b>. As três primeiras etapas o <b>Meta</b> conta; as duas
              últimas são os pedidos do <b>nosso registro</b> carimbados com ele.
            </>
          ) : (
            <>
              Os cinco eixos são o caminho de quem clicou no anúncio. As três primeiras etapas o{' '}
              <b>Meta</b> conta; as duas últimas são o <b>nosso registro</b> de pedidos, e batem com o
              faturamento do topo.
            </>
          )
        ) : (
          (() => {
            const e = etapas[sobre];
            const n = contagens[sobre];
            const ant = sobre > 0 ? contagens[sobre - 1] : null;
            const passou = ant && ant > 0 ? n / ant : null;
            return (
              <>
                <b>{e.rotulo}</b> · {inteiro(n)} · {base > 0 ? pct(fracao(n)) : 'N/A'} dos cliques
                {passou !== null ? (
                  <>
                    {' '}
                    · <b>{pct(passou)}</b> seguiram da etapa anterior (perderam {pct(1 - passou)})
                  </>
                ) : null}
                <br />
                <span className="a-mut">
                  fonte: {e.fonte === 'meta' ? (rede === 'tiktok' ? 'TikTok Reporting' : 'Meta Insights') : 'nosso registro do site'} — {e.dica}
                </span>
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* PEDAÇOS DO RESUMO                                                           */
/* -------------------------------------------------------------------------- */

const NOMES_PRODUTO: Record<string, string> = {
  main: 'Oração Sagrada',
  salmos_150: 'Guia dos Salmos',
  vela_7dias: 'Vela de 7 dias',
  /* A oferta de saída (o "voltar" do celular): os mesmos produtos, mais baratos. */
  main_volta: 'Oração (saída R$ 27)',
  salmos_150_volta: 'Guia dos Salmos (saída)',
  vela_7dias_volta: 'Vela de 7 dias (saída)',
  semente_10: 'Gratidão +R$ 10',
  semente_25: 'Gratidão +R$ 25',
  semente_50: 'Gratidão +R$ 50',
  upsell: 'Upsell',
  downsell: 'Downsell',
};

/**
 * O share vem sobre o TOTAL DE ITENS VENDIDOS, e não sobre o número de pedidos.
 *
 * Um pedido carrega o principal mais os bumps, então a soma dos itens é maior
 * que a de pedidos. Dividir pelos pedidos daria 60% + 40% + 40% = 140%, e uma
 * porcentagem que passa de cem é a coisa mais rápida de fazer alguém parar de
 * confiar no painel inteiro.
 */
function PorProduto({ vendas }: { vendas: Venda[] }) {
  const pagas = vendas.filter((v) => v.status === 'completed');
  const mapa = new Map<string, number>();
  for (const v of pagas) for (const i of v.itens ?? []) mapa.set(i, (mapa.get(i) ?? 0) + 1);
  const lista = [...mapa.entries()].sort((a, b) => b[1] - a[1]);
  const total = lista.reduce((s, [, n]) => s + n, 0);
  if (lista.length === 0) return <div className="a-sub">Nenhuma venda por aqui.</div>;
  return (
    <div style={{ fontSize: 12 }}>
      {lista.map(([id, n]) => {
        const share = total > 0 ? n / total : 0;
        return (
          <div key={id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {NOMES_PRODUTO[id] ?? id}
            </span>
            <span className="a-mut">{n}</span>
            <span
              className="a-rosca"
              style={{ background: `conic-gradient(var(--ac) 0 ${share * 100}%, var(--bd) ${share * 100}% 100%)` }}
              title={`${n} de ${total} itens vendidos`}
            >
              <i>{n0.format(share * 100)}%</i>
            </span>
          </div>
        );
      })}
      <div className="a-sub" style={{ marginTop: 6 }}>
        {total} item(ns) em {pagas.length} pedido(s) pago(s).
      </div>
    </div>
  );
}

/**
 * O donut de formas de pagamento. Nesta operação ele tem uma fatia só, e o
 * texto diz isso em vez de fingir variedade: o cartão sai pela Kiwify e não
 * nasce aqui, então este painel nunca o vê. O boleto saiu da tela em 16/09/2026.
 */
function PorPagamento({ total }: { total: number }) {
  if (total === 0) return <div className="a-sub">Nenhuma venda por aqui.</div>;
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
      <div
        style={{
          width: 68,
          height: 68,
          borderRadius: '50%',
          background: 'conic-gradient(var(--ac) 0 100%)',
          display: 'grid',
          placeItems: 'center',
          flex: '0 0 68px',
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'var(--card)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
          }}
        >
          {total}
        </div>
      </div>
      <div style={{ fontSize: 12 }}>
        <div>
          <span style={{ color: 'var(--ac)' }}>●</span> Pix — {total} (100%)
        </div>
        <div className="a-mut">O cartão sai pela Kiwify — não passa por este servidor.</div>
      </div>
    </div>
  );
}

/**
 * A tabelinha de origem/campanha da aba Cartão.
 *
 * NÃO USA O CATÁLOGO DE ~45 COLUNAS de propósito: ali a pergunta é "qual
 * criativo escalar", com ROAS, CPA e o interruptor do Meta. Aqui a pergunta é
 * mais curta — "de onde veio o dinheiro do cartão" — e as três colunas que
 * respondem isso cabem sem o peso da tabela grande, que precisa de gasto por
 * linha para não mostrar ROAS vazio. Gasto por rede já está nas abas Meta e
 * TikTok, onde o cartão agora entra somado.
 */
function PorLinhaSimples({ linhas, rotulo }: { linhas: Linha[]; rotulo: string }) {
  const comVenda = linhas.filter((l) => l.pagas > 0 || l.receita > 0).sort((a, b) => b.receita - a.receita);
  if (comVenda.length === 0) return <div className="a-sub">Nenhuma venda no cartão neste período.</div>;
  const total = comVenda.reduce((s, l) => s + l.receita, 0);
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 8, padding: '4px 0', fontWeight: 600 }} className="a-mut">
        <span style={{ flex: 1 }}>{rotulo}</span>
        <span style={{ width: 70, textAlign: 'right' }}>Vendas</span>
        <span style={{ width: 90, textAlign: 'right' }}>Faturamento</span>
        <span style={{ width: 54, textAlign: 'right' }}>Fatia</span>
      </div>
      {/* `--bd` é o token de borda do painel; cor fixa aqui quebraria o tema —
          é a regra 12 do NOTAS.md. */}
      {comVenda.map((l) => (
        <div key={l.id || l.nome} style={{ display: 'flex', gap: 8, padding: '4px 0', borderTop: '1px solid var(--bd)' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.nome}>
            {l.nome || '(sem carimbo)'}
          </span>
          <span style={{ width: 70, textAlign: 'right' }}>{inteiro(l.pagas)}</span>
          <span style={{ width: 90, textAlign: 'right' }} className="a-sensivel">
            {brl(l.receita)}
          </span>
          <span style={{ width: 54, textAlign: 'right' }} className="a-mut">
            {total > 0 ? `${Math.round((l.receita / total) * 100)}%` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function PorFonte({ vendas }: { vendas: Venda[] }) {
  const pagas = vendas.filter((v) => v.status === 'completed');
  if (pagas.length === 0) return <div className="a-sub">Nenhuma venda por aqui.</div>;
  const mapa = new Map<string, number>();
  for (const v of pagas) {
    const a = v.attrib ?? {};
    const f = a.criativo ? 'Meta (pago)' : a.origem ? a.origem : 'Não atribuído';
    mapa.set(f, (mapa.get(f) ?? 0) + 1);
  }
  return (
    <div style={{ fontSize: 12 }}>
      {[...mapa.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => (
          <div key={f} style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
            <span style={{ flex: 1 }}>{f}</span>
            <span className="a-mut">{n}</span>
          </div>
        ))}
    </div>
  );
}

function Aprovacao({ pix }: { pix: number | null }) {
  const linha = (rotulo: string, v: number | null) => {
    const cor = v === null ? 'a-mut' : v >= 0.7 ? 'a-pos' : v >= 0.4 ? 'a-warn' : 'a-neg';
    return (
      <div key={rotulo} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12 }}>
        <span style={{ flex: 1 }}>{rotulo}</span>
        <span className={cor}>{pct(v)}</span>
      </div>
    );
  };
  return (
    <div>
      {linha('Pix', pix)}
      {/* Cartão existe no checkout, mas cobra na Kiwify: daqui não dá para medir aprovação dele. */}
      {linha('Cartão (Kiwify)', null)}
    </div>
  );
}

function ContaCard({ conta, totais }: { conta: Conta | null; totais: Derivados | null }) {
  if (!conta) {
    return <div className="a-card a-mut">A conta de anúncios não está conectada (META_ADS_TOKEN / META_AD_ACCOUNT).</div>;
  }
  const situacoes: Record<number, string> = {
    1: 'Ativa',
    2: 'Desativada',
    3: 'Sem método de pagamento',
    7: 'Em análise',
    9: 'Em período de carência',
    101: 'Fechada',
  };
  const ok = conta.situacao === 1;
  return (
    <div className="a-grid">
      <Cartao titulo="Conta" span={4} valor={conta.nome} sensivel={false} sub={conta.id} />
      <Cartao
        titulo="Situação"
        span={4}
        valor={situacoes[conta.situacao] ?? `Código ${conta.situacao}`}
        cor={ok ? 'pos' : 'neg'}
        sensivel={false}
        sub={ok ? '' : 'Conta nesta situação para de entregar sem nenhum aviso na tabela de anúncios.'}
      />
      <Cartao titulo="Gasto no período" span={4} valor={brl(totais?.gasto ?? 0)} />
      <Cartao titulo="Gasto total da conta" span={4} valor={brl(conta.gastoTotal)} />
      <Cartao titulo="Teto de gasto" span={4} valor={conta.teto > 0 ? brl(conta.teto) : 'sem teto'} />
      <Cartao
        titulo="Fuso da conta"
        span={4}
        valor={conta.fuso || '—'}
        sensivel={false}
        sub="O gasto do Meta é contado neste fuso; as vendas, em America/Sao_Paulo."
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ALERTAS, EVENTOS E FORMULÁRIOS                                              */
/* -------------------------------------------------------------------------- */

function ListaDeAlertas({
  problemas,
  podeGerenciar,
  mexendo,
  trocarStatus,
  reenviarPurchase,
  reenviando,
}: {
  problemas: Array<{
    id: string;
    gravidade: 'ruim' | 'aviso';
    texto: string;
    alvo?: Linha;
    acao?: 'reenviar';
  }>;
  podeGerenciar: boolean;
  mexendo: Set<string>;
  trocarStatus: (ids: string[], para: 'ACTIVE' | 'PAUSED') => void;
  reenviarPurchase: () => void;
  reenviando: boolean;
}) {
  if (problemas.length === 0) {
    return <div className="a-card a-pos">Nada pedindo atenção agora.</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {problemas.map((p) => (
        <div key={p.id} className="a-card" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className={p.gravidade === 'ruim' ? 'a-neg' : 'a-warn'}>●</span>
          <span style={{ flex: 1, fontSize: 12 }}>{p.texto}</span>
          {p.acao === 'reenviar' ? (
            <button className="a-btn" disabled={reenviando} onClick={reenviarPurchase}>
              {reenviando ? 'Reenviando…' : 'Reenviar ao Meta'}
            </button>
          ) : null}
          {p.alvo && p.alvo.status === 'ACTIVE' ? (
            <button
              className="a-btn2"
              disabled={!podeGerenciar || mexendo.has(p.alvo.id)}
              onClick={() => trocarStatus([p.alvo!.id], 'PAUSED')}
            >
              Pausar agora
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * O FEED. É ele que faz alguém confiar no rastreio: dá para ver o Purchase
 * saindo, o PIX nascendo e a entrega indo pelo WhatsApp, em ordem, com hora.
 * Sem isso, "o Meta recebeu?" só se responde abrindo o Gerenciador.
 */
/**
 * QUEM GEROU PIX, E O QUE O ROBÔ FEZ COM CADA UM.
 *
 * O PIX gerado e não pago é a maior perda deste funil -- em 07/09/2026 foram
 * 8 de 10. Esta tela existe para essa perda ter ROSTO e TELEFONE: sem ela, o
 * abandono é um número no resumo e ninguém liga para ninguém.
 *
 * As três colunas do robô (lembrete, entrega, erro) respondem a pergunta que o
 * dono faz toda vez: "o robô chegou a mandar?". `whatsappLembreteEm` vazio num
 * pedido pendente antigo significa que a janela passou -- o lembrete só sai
 * entre 4 e 15 minutos, porque o código do PIX morre em 20.
 */
/** A letra do servidor, com o nome que o dono usa no cartão de Integrações. */
function nomeDaOrigem(origem: string | undefined): string {
  /* Uma letra maiúscula sozinha é gateway (S, Z, P, G, A): gateway novo não
     precisa lembrar de entrar nesta lista para aparecer com nome. */
  if (origem && /^[A-Z]$/.test(origem)) return `Gateway ${origem}`;
  return origem || '—';
}

/**
 * A PLANILHA DE CONTATOS — UMA LINHA POR PESSOA (11/10/2026).
 *
 * O dono baixa este arquivo e entrega ao robô do WhatsApp. Por isso ela não é a
 * lista de pedidos: quem gerou três PIX e pagou um apareceria três vezes, duas
 * delas como "não pagou" — e receberia cobrança depois de ter comprado. Aqui a
 * pessoa é o telefone sem 55 e sem o nono dígito (a mesma régua do robô, em
 * servico-whatsapp/contatos.mjs), e a SITUAÇÃO vem por extenso, com a data de
 * cada passo no horário de Brasília: quem lê não pode ter de adivinhar código
 * nem fuso.
 *
 * "Pagou" se divide em dois porque são duas tarefas diferentes — uma é dívida
 * nossa (entregar), a outra é oferta (upsell).
 *
 * Ficam de fora a venda de cartão e a Kiwify como "compradora" (o telefone é
 * da plataforma, não de cliente) e os nossos pedidos de teste.
 */
function contatosParaCsv(vendas: Venda[]): string {
  const quando = (iso?: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d
      .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      .replace(',', '');
  };
  const reais = (v: number) => (v ? v.toFixed(2).replace('.', ',') : '');
  const depois = (a: string | null, b?: string | null) => (!b ? a : !a || Date.parse(b) > Date.parse(a) ? b : a);

  interface Pessoa {
    telefone: string;
    nome: string;
    email: string;
    primeiro: string;
    ultimo: string;
    pixEm: string | null;
    pagoEm: string | null;
    entregueEm: string | null;
    lembreteEm: string | null;
    pedidos: number;
    pagos: number;
    valorPago: number;
    emAberto: number;
    faltaEntregar: boolean;
    itens: string[];
    gateway: string;
    origem: string;
    campanha: string;
    criativo: string;
    funil: string;
  }
  const pessoas = new Map<string, Pessoa>();
  const emOrdem = [...vendas].sort((a, b) => Date.parse(a.criadoEm) - Date.parse(b.criadoEm));
  for (const v of emOrdem) {
    if (v.pagamento === 'cartao') continue;
    const nome = String(v.nome ?? '').trim();
    if (/^(kiwify|teste)(\s|$)/i.test(nome) || /@kiwify\./i.test(String(v.email ?? ''))) continue;
    const digitos = String(v.telefone ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (digitos.length < 10) continue;
    const chave = digitos.length === 11 ? digitos.slice(0, 2) + digitos.slice(3) : digitos;
    let p = pessoas.get(chave);
    if (!p) {
      p = {
        telefone: '', nome: '', email: '', primeiro: v.criadoEm, ultimo: v.criadoEm, pixEm: null, pagoEm: null,
        entregueEm: null, lembreteEm: null, pedidos: 0, pagos: 0, valorPago: 0, emAberto: 0, faltaEntregar: false,
        itens: [], gateway: '', origem: '', campanha: '', criativo: '', funil: '',
      };
      pessoas.set(chave, p);
    }
    /* Da mais antiga para a mais nova: nome, e-mail e número ficam os do último pedido. */
    p.telefone = '55' + digitos;
    if (nome) p.nome = nome;
    if (v.email) p.email = v.email;
    p.ultimo = v.criadoEm;
    p.pedidos += 1;
    p.pixEm = depois(p.pixEm, v.criadoEm);
    p.lembreteEm = depois(p.lembreteEm, v.whatsappLembreteEm);
    p.gateway = v.origem ?? p.gateway;
    /* A origem é a do PRIMEIRO pedido que a tiver: é o anúncio que trouxe a pessoa. */
    if (!p.origem && !p.campanha) {
      p.origem = v.attrib?.origem ?? '';
      p.campanha = (v.attrib?.campanha ?? '').split('|')[0];
      p.criativo = (v.attrib?.criativo ?? '').split('|')[0];
    }
    if (!p.funil) p.funil = (v as { funil?: string }).funil ?? 'quiz';
    if (v.status === 'completed') {
      p.pagos += 1;
      p.valorPago += Number(v.valor) || 0;
      p.pagoEm = depois(p.pagoEm, v.pagoEm ?? v.criadoEm);
      p.entregueEm = depois(p.entregueEm, v.whatsappEnviadoEm);
      if (!v.whatsappEnviadoEm) p.faltaEntregar = true;
      for (const i of v.itens ?? []) if (!p.itens.includes(i)) p.itens.push(i);
    } else {
      /* O que ela deixou na mesa: o valor do PIX mais recente que não pagou. */
      p.emAberto = Number(v.valor) || 0;
    }
  }

  /* A ordem é a da urgência: primeiro quem pagou e espera, depois quem falta pagar. */
  const peso = (p: Pessoa) => (p.pagos ? (p.faltaEntregar ? 0 : 2) : 1);
  const lista = [...pessoas.values()].sort((a, b) => peso(a) - peso(b) || Date.parse(b.ultimo) - Date.parse(a.ultimo));
  return paraCsv(
    [
      'situacao', 'o_que_fazer', 'nome', 'whatsapp', 'primeiro_contato', 'ultimo_pix_gerado_em', 'pago_em', 'entregue_em',
      'lembrete_enviado_em', 'valor_pago', 'valor_do_pix_nao_pago', 'pedidos', 'pedidos_pagos', 'produtos', 'gateway',
      'origem', 'campanha', 'anuncio', 'funil', 'email',
    ],
    lista.map((p) => {
      const [situacao, oQueFazer] = p.pagos
        ? p.faltaEntregar
          ? ['PAGOU E NAO RECEBEU', 'Entregar o acesso pelo WhatsApp']
          : ['PAGOU E RECEBEU', 'Cliente: upsell e comunidade']
        : ['GEROU O PIX E NAO PAGOU', 'Lembrete do PIX / recuperacao'];
      return [
        situacao,
        oQueFazer,
        p.nome,
        p.telefone,
        quando(p.primeiro),
        quando(p.pixEm),
        quando(p.pagoEm),
        quando(p.entregueEm),
        quando(p.lembreteEm),
        reais(p.valorPago),
        /* Quem já pagou não tem "em aberto" para cobrar: o segundo PIX dela é assunto de upsell. */
        p.pagos ? '' : reais(p.emAberto),
        String(p.pedidos),
        String(p.pagos),
        p.itens.join(' + '),
        p.gateway,
        p.origem,
        p.campanha,
        p.criativo,
        p.funil,
        p.email,
      ];
    }),
  );
}

function ClientesEPix({ vendas }: { vendas: Venda[] }) {
  const [busca, setBusca] = useState('');
  const [filtroPedido, setFiltroPedido] = useState('todos');
  const [filtroZap, setFiltroZap] = useState('todos');
  const [detalhe, setDetalhe] = useState<Venda | null>(null);

  const todas = [...vendas].sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm));

  /*
   * A BUSCA ACEITA TELEFONE E ID, e nao so nome.
   *
   * Quando o cliente chama no WhatsApp, o que o dono tem na mao e o NUMERO --
   * e quando quem pergunta e o gateway, e o id do pedido. Buscar so por nome
   * seria o unico caminho que ele nunca tem no momento em que precisa.
   */
  const linhas = todas.filter((v) => {
    const q = busca.trim().toLowerCase();
    if (q) {
      const alvo = `${v.nome ?? ''} ${v.telefone ?? ''} ${v.email ?? ''} ${v.id}`.toLowerCase();
      if (!alvo.includes(q)) return false;
    }
    if (filtroPedido === 'pagos' && v.status !== 'completed') return false;
    if (filtroPedido === 'aberto' && v.status !== 'pending') return false;
    if (filtroPedido === 'outros' && (v.status === 'completed' || v.status === 'pending')) return false;
    if (filtroZap === 'entregue' && !v.whatsappEnviadoEm) return false;
    if (filtroZap === 'lembrete' && !v.whatsappLembreteEm) return false;
    if (filtroZap === 'sem' && (v.whatsappEnviadoEm || v.whatsappLembreteEm)) return false;
    if (filtroZap === 'falha' && !v.whatsappErro) return false;
    return true;
  });

  /* Os cartoes somam o PERIODO INTEIRO, nao o filtro: numero de topo que muda
     quando se digita na busca nao e indicador, e armadilha. */
  const pagas = todas.filter((v) => v.status === 'completed');
  const pendentes = todas.filter((v) => v.status === 'pending');
  const emAberto = pendentes.reduce((s, v) => s + (Number(v.valor) || 0), 0);
  const lembrados = todas.filter((v) => v.whatsappLembreteEm).length;
  const entregues = pagas.filter((v) => v.whatsappEnviadoEm).length;
  /* Quem pagou e não recebeu é o número mais grave desta tela: é cliente
     esperando um produto que ele já comprou. */
  const semReceber = pagas.length - entregues;
  const comErro = todas.filter((v) => v.whatsappErro);

  return (
    <>
      <div className="a-grid">
        <Cartao titulo="PIX gerados" valor={inteiro(todas.length)} sub={`${pagas.length} pagos`} sensivel={false} />
        <Cartao
          titulo="Conversão do PIX"
          valor={todas.length ? pct(pagas.length / todas.length) : 'N/A'}
          sub="pagos ÷ gerados"
          sensivel={false}
        />
        <Cartao titulo="Em aberto" valor={brl(emAberto)} sub={`${pendentes.length} sem pagar`} cor="neg" sensivel={false} />
        <Cartao titulo="Lembretes enviados" valor={inteiro(lembrados)} sub="recuperação pelo robô" sensivel={false} />
        <Cartao
          titulo="Pagos sem receber"
          valor={inteiro(semReceber)}
          sub={semReceber > 0 ? 'clientes esperando o produto' : 'todos entregues'}
          ruim={semReceber > 0}
          sensivel={false}
        />
      </div>

      {comErro.length > 0 ? (
        <div className="a-card" style={{ marginTop: 10 }}>
          <h4 className="a-card h4 a-neg">O robô falhou em {comErro.length}</h4>
          <div className="a-sub">
            {comErro.slice(0, 4).map((v) => `${v.nome}: ${v.whatsappErro}`).join(' · ')}
          </div>
        </div>
      ) : null}

      <div className="a-card" style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Nome, telefone, e-mail ou id do pedido"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={{ minWidth: 220, flex: '1 1 220px' }}
        />
        <select value={filtroPedido} onChange={(e) => setFiltroPedido(e.target.value)}>
          <option value="todos">Pedido: todos</option>
          <option value="aberto">Em aberto</option>
          <option value="pagos">Pagos</option>
          <option value="outros">Outros estados</option>
        </select>
        <select value={filtroZap} onChange={(e) => setFiltroZap(e.target.value)}>
          <option value="todos">WhatsApp: todos</option>
          <option value="sem">Sem mensagem</option>
          <option value="lembrete">Lembrete enviado</option>
          <option value="entregue">Entrega feita</option>
          <option value="falha">Falhou</option>
        </select>
        <span className="a-mut">
          {linhas.length} de {todas.length}
        </span>
        {/* A planilha leva o PERÍODO INTEIRO escolhido no topo, e não a busca:
            ela é a lista de pessoas para o robô, e meia lista seria armadilha. */}
        <button
          className="a-btn2"
          disabled={todas.length === 0}
          title="Uma linha por pessoa, com a situação e as datas. Para levar tudo, escolha Todo o período no topo."
          onClick={() => baixarCsv(`contatos-${new Date().toISOString().slice(0, 10)}.csv`, contatosParaCsv(todas))}
        >
          Baixar planilha de contatos (CSV)
        </button>
      </div>

      <div className="a-rolo" style={{ marginTop: 10 }}>
        <table className="a-tab-t">
          <thead>
            <tr>
              <th className="esq">Quando</th>
              <th className="esq">Cliente</th>
              <th className="esq">Oferta</th>
              <th className="esq">WhatsApp</th>
              <th>Valor</th>
              <th className="esq">Pagou?</th>
              <th className="esq">Gateway</th>
              <th className="esq">Lembrete</th>
              <th className="esq">Entrega</th>
              <th className="esq">Anúncio</th>
            </tr>
          </thead>
          <tbody>
            {linhas.slice(0, 300).map((v) => {
              const pago = v.status === 'completed';
              const criativo = (v.attrib?.criativo ?? '').split('|')[0] || '—';
              return (
                <tr key={v.id} onClick={() => setDetalhe(v)} style={{ cursor: 'pointer' }}>
                  <td className="esq a-mut">{dataCurta(v.criadoEm)}</td>
                  <td className="esq a-sensivel">
                    <div>{v.nome || '—'}</div>
                    <div className="a-mut" style={{ fontSize: 11 }}>
                      {v.email || ''}
                    </div>
                  </td>
                  <td className="esq a-mut">
                    {(v.itens ?? []).length > 1
                      ? `${v.itens[0]} +${v.itens.length - 1}`
                      : (v.itens ?? [])[0] || '—'}
                  </td>
                  <td className="esq a-sensivel">{v.telefone || '—'}</td>
                  <td>{brl(Number(v.valor) || 0)}</td>
                  <td className="esq">
                    {pago ? (
                      <span className="a-pos">● pago</span>
                    ) : v.status === 'pending' ? (
                      <span className="a-warn">● em aberto</span>
                    ) : (
                      <span className="a-mut">● {v.status}</span>
                    )}
                  </td>
                  <td className="esq">{nomeDaOrigem(v.origem)}</td>
                  <td className="esq">
                    {v.whatsappLembreteEm ? (
                      <span className="a-pos">enviado {dataCurta(v.whatsappLembreteEm)}</span>
                    ) : pago ? (
                      <span className="a-mut">não precisou</span>
                    ) : (
                      <span className="a-mut">não enviado</span>
                    )}
                  </td>
                  <td className="esq">
                    {v.whatsappEnviadoEm ? (
                      <span className="a-pos">entregue {dataCurta(v.whatsappEnviadoEm)}</span>
                    ) : pago ? (
                      <span className="a-neg">ESPERANDO</span>
                    ) : (
                      <span className="a-mut">—</span>
                    )}
                  </td>
                  <td className="esq a-mut">{criativo}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detalhe ? <DetalheDoPedido venda={detalhe} aoFechar={() => setDetalhe(null)} /> : null}
    </>
  );
}

/**
 * O PEDIDO INTEIRO, NUMA TELA SO.
 *
 * Existe para a pergunta que chega pelo WhatsApp: "paguei e nao recebi".
 * Responder isso exigia abrir o painel do gateway, o CRM do robo e o
 * Gerenciador do Meta -- tres abas para uma frase.
 *
 * NAO tem botao de reenviar entrega, e a ausencia e deliberada: quem entrega e
 * o robo, que PUXA a fila deste servidor de dentro da casa do dono. Um botao
 * aqui prometeria uma acao que esta tela nao tem como executar, e botao que
 * mente custa mais caro que botao ausente.
 */
function DetalheDoPedido({ venda: v, aoFechar }: { venda: Venda; aoFechar: () => void }) {
  const pago = v.status === 'completed';
  const criativo = (v.attrib?.criativo ?? '').split('|')[0] || '';
  const linha = (rotulo: string, valor: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
      <span className="a-mut">{rotulo}</span>
      <span style={{ textAlign: 'right' }}>{valor}</span>
    </div>
  );
  return (
    <>
      <div className="a-modal-fundo" onClick={aoFechar} />
      <div className="a-modal" role="dialog" aria-label="Detalhes do pedido">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <h3 className="a-sensivel">{v.nome || 'Pedido'}</h3>
          <button className="a-icone" onClick={aoFechar} title="Fechar">
            ✕
          </button>
        </div>
        <div className="a-sub" style={{ marginBottom: 8 }}>
          {pago ? <span className="a-pos">● pago</span> : <span className="a-warn">● em aberto</span>}
          {' · '}
          <span className="a-mut">{v.id}</span>
        </div>

        <div className="a-card">
          <h4>O pedido</h4>
          {linha('Criado', dataCurta(v.criadoEm))}
          {linha('Pago', v.pagoEm ? dataCurta(v.pagoEm) : '—')}
          {linha('Valor', brl(Number(v.valor) || 0))}
          {linha('Itens', (v.itens ?? []).join(', ') || '—')}
          {linha('Gateway', nomeDaOrigem(v.origem))}
          {linha('Situação no gateway', v.status)}
          {/*
            O QUE ENTROU DE VERDADE, e a taxa que a venda pagou.

            `valor` é o que a cliente pagou; `valorLiquido` é o que a ZuckPay
            diz ter liquidado — o número do extrato dela, não uma conta nossa.
            A diferença entre os dois é a taxa REAL daquela venda, e é por isso
            que ela aparece ao lado: ninguém precisa saber a porcentagem, nem
            configurar nada em Taxas, para ver quanto o gateway levou.

            SÓ APARECE EM VENDA PAGA. Antes da liquidação não há líquido, e
            mostrar "R$ 0,00" num PIX em aberto seria dizer que a venda não
            valeu nada.

            Venda marcada à mão não passou pela ZuckPay, então não tem líquido
            para mostrar — e o texto diz isso, em vez de deixar a lacuna muda.
          */}
          {pago
            ? linha(
                'Líquido recebido',
                v.valorLiquido != null ? (
                  <>
                    {brl(v.valorLiquido)}{' '}
                    <span className="a-mut" style={{ fontSize: 11 }}>
                      (taxa {brl((Number(v.valor) || 0) - v.valorLiquido)})
                    </span>
                  </>
                ) : v.pagoForaDoGateway ? (
                  <span className="a-mut">pago fora do gateway</span>
                ) : (
                  <span className="a-mut">o gateway não informou</span>
                ),
              )
            : null}
          {/*
            A ADQUIRENTE some da tela quando não existe, e some quase sempre:
            medido em 08/09/2026, a resposta da ZuckPay tem apenas
            `statusCode, transactionId, external_id_client, status, amount,
            amount_liquid, payment_method, pix_code, checkout_url,
            confirmed_date, created_at` — nenhum campo de adquirente.

            Uma linha fixa dizendo "não informado" em toda venda seria ruído
            permanente. Renderizar só quando existe faz ela aparecer sozinha no
            dia em que eles passarem a mandar, sem ninguém precisar lembrar.

            E NUNCA aparece "ZuckPay" aqui. Ela é a intermediária; quem liquida
            é o PSP atrás dela. Repetir o nome do gateway responderia com o que
            já se sabe justamente na pergunta que se faz quando o dinheiro não
            bate no extrato.
          */}
          {v.adquirente ? linha('Adquirente', v.adquirente) : null}
        </div>

        <div className="a-card" style={{ marginTop: 8 }}>
          <h4>De onde veio</h4>
          {linha('Anúncio', criativo || 'sem atribuição')}
          {linha('Campanha', v.attrib?.campanha?.split('|')[0] || '—')}
          {linha('Origem', v.attrib?.origem || '—')}
          {/* De qual conta do TikTok: o pixel do `?tt=` do link. Sem ele, é o principal. */}
          {v.attrib?.ttpx ? linha('Pixel do TikTok', v.attrib.ttpx) : null}
          {linha(
            'Purchase no Meta',
            v.metaEnviadoEm ? dataCurta(v.metaEnviadoEm) : <span className="a-neg">não enviado</span>,
          )}
        </div>

        <div className="a-card" style={{ marginTop: 8 }}>
          <h4>O cliente</h4>
          {linha('Nome', <span className="a-sensivel">{v.nome || '—'}</span>)}
          {linha('WhatsApp', <span className="a-sensivel">{v.telefone || '—'}</span>)}
          {linha('E-mail', <span className="a-sensivel">{v.email || '—'}</span>)}
          {/* O pedido de BOLETO traz o CPF: é com nome, CPF e e-mail que o dono emite o boleto. */}
          {v.cpf ? linha('CPF', <span className="a-sensivel">{v.cpf}</span>) : null}
          {v.pagamento === 'boleto' ? linha('Forma', `boleto — pedido ${v.id.slice(0, 10)}`) : null}
        </div>

        <div className="a-card" style={{ marginTop: 8 }}>
          <h4>O robô</h4>
          {linha('Lembrete', v.whatsappLembreteEm ? dataCurta(v.whatsappLembreteEm) : 'não enviado')}
          {linha(
            'Entrega',
            v.whatsappEnviadoEm ? (
              dataCurta(v.whatsappEnviadoEm)
            ) : pago ? (
              <span className="a-neg">ESPERANDO</span>
            ) : (
              '—'
            ),
          )}
          {v.whatsappErro ? linha('Falha', <span className="a-neg">{v.whatsappErro}</span>) : null}
        </div>
      </div>
    </>
  );
}

function Eventos({ vendas }: { vendas: Venda[] }) {
  const linhas: Array<{ quando: string; tipo: string; texto: string; cor: string }> = [];
  for (const v of vendas) {
    linhas.push({ quando: v.criadoEm, tipo: 'PIX criado', texto: `${v.nome} · ${brl(v.valor)}`, cor: 'a-mut' });
    if (v.pagoEm) linhas.push({ quando: v.pagoEm, tipo: 'Pagamento', texto: `${v.nome} · ${brl(v.valor)}`, cor: 'a-pos' });
    if (v.metaEnviadoEm) {
      linhas.push({ quando: v.metaEnviadoEm, tipo: 'Purchase → Meta', texto: `pedido ${v.id}`, cor: 'a-pos' });
    }
    if (v.whatsappLembreteEm) {
      linhas.push({ quando: v.whatsappLembreteEm, tipo: 'Lembrete WhatsApp', texto: v.nome, cor: 'a-warn' });
    }
    if (v.whatsappEnviadoEm) {
      linhas.push({ quando: v.whatsappEnviadoEm, tipo: 'Entrega WhatsApp', texto: v.nome, cor: 'a-pos' });
    }
  }
  linhas.sort((a, b) => Date.parse(b.quando) - Date.parse(a.quando));
  if (linhas.length === 0) return <div className="a-card a-mut">Nenhum evento no período.</div>;
  return (
    <div className="a-rolo">
      <table className="a-tab-t">
        <thead>
          <tr>
            <th className="esq">Quando</th>
            <th className="esq">Evento</th>
            <th className="esq">Detalhe</th>
          </tr>
        </thead>
        <tbody>
          {linhas.slice(0, 300).map((l, i) => (
            <tr key={`${l.tipo}-${l.quando}-${i}`}>
              <td className="esq a-mut">{dataCurta(l.quando)}</td>
              <td className="esq">
                <span className={l.cor}>●</span> {l.tipo}
              </td>
              <td className="esq a-sensivel">{l.texto}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabelaVendas({
  vendas,
  aoApagar,
  aoMarcarPaga,
}: {
  vendas: Venda[];
  aoApagar?: (v: Venda) => void;
  aoMarcarPaga?: (v: Venda) => void;
}) {
  if (vendas.length === 0) return <div className="a-sub">Nenhuma venda por aqui.</div>;
  return (
    <div className="a-rolo" style={{ marginTop: 8 }}>
      <table className="a-tab-t">
        <thead>
          <tr>
            <th className="esq">Quando</th>
            <th className="esq">Quem</th>
            <th className="esq">Status</th>
            <th>Valor</th>
            <th className="esq">Anúncio</th>
            <th className="esq">Meta</th>
            {aoApagar ? <th className="esq" style={{ width: 36 }} /> : null}
          </tr>
        </thead>
        <tbody>
          {vendas.map((v) => (
            <tr key={v.id}>
              <td className="esq a-mut">{dataCurta(v.criadoEm)}</td>
              <td className="esq a-sensivel">
                <div>{v.nome}</div>
                <div className="a-sub">{v.email}</div>
              </td>
              <td className="esq">
                <span className={v.status === 'completed' ? 'a-pos' : v.status === 'pending' ? 'a-warn' : 'a-mut'}>
                  {v.status}
                </span>
              </td>
              <td className="a-sensivel">{brl(v.valor)}</td>
              <td className="esq a-mut">{(v.attrib?.criativo ?? '').split('|')[0] || '(sem anúncio)'}</td>
              <td className="esq">
                {v.metaEnviadoEm ? <span className="a-pos">enviado</span> : <span className="a-mut">—</span>}
              </td>
              {/*
                O ✕ SÓ APARECE EM PEDIDO QUE NUNCA VIROU DINHEIRO.
                Venda paga não tem botão de apagar aqui, e o servidor recusa
                mesmo se alguém chamar a rota na mão (409 PAID_ORDER) — a trava
                de verdade é lá, esta é só para o dedo não escorregar.
              */}
              {aoApagar ? (
                <td className="esq" style={{ whiteSpace: 'nowrap' }}>
                  {v.status === 'completed' || v.metaEnviadoEm ? null : (
                    <>
                      {/*
                        R$ ANTES DO ✕, e não depois: os dois ficam lado a lado e
                        um deles apaga o pedido. O que registra dinheiro vem
                        primeiro, e o destrutivo fica na ponta — dedo que
                        escorrega, escorrega para a direita.
                      */}
                      {aoMarcarPaga ? (
                        <button
                          className="a-icone"
                          /* Era só "R$": o dono não sabia que o botão existia (13/10/2026). */
                          style={{ width: 'auto', padding: '0 10px', fontWeight: 700, color: '#34d399' }}
                          title="Ela pagou por fora (boleto, PIX direto): marcar como paga e enviar o evento de compra"
                          onClick={() => aoMarcarPaga(v)}
                        >
                          ✓ Pagou
                        </button>
                      ) : null}
                      <button
                        className="a-icone"
                        title="Apagar este pedido (nunca foi pago)"
                        onClick={() => aoApagar(v)}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FormTaxas({
  config,
  senha,
  avisar,
  aoSalvar,
}: {
  config: Config | null;
  senha: string;
  avisar: (t: string, tipo?: 'ruim') => void;
  aoSalvar: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>(() => ({
    taxaPct: config?.taxaPct === null || config?.taxaPct === undefined ? '' : String(config.taxaPct),
    impostoPct: config?.impostoPct === null || config?.impostoPct === undefined ? '' : String(config.impostoPct),
    custoPorVenda:
      config?.custoPorVenda === null || config?.custoPorVenda === undefined ? '' : String(config.custoPorVenda),
    impostoAdsPct:
      config?.impostoAdsPct === null || config?.impostoAdsPct === undefined ? '' : String(config.impostoAdsPct),
    breakEvenRoas:
      config?.breakEvenRoas === null || config?.breakEvenRoas === undefined ? '' : String(config.breakEvenRoas),
  }));
  const [salvando, setSalvando] = useState(false);

  const salvar = async () => {
    setSalvando(true);
    try {
      const r = await fetch(`${BASE}/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
        body: JSON.stringify(f),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) avisar(String(corpo?.error?.message ?? `HTTP ${r.status}`), 'ruim');
      else {
        avisar('Salvo. O lucro passa a usar estes números.');
        aoSalvar();
      }
    } catch {
      avisar('Não consegui salvar.', 'ruim');
    } finally {
      setSalvando(false);
    }
  };

  const campo = (chave: string, rotulo: string, dica: string) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div style={{ fontSize: 12, marginBottom: 3 }}>{rotulo}</div>
      <input
        value={f[chave] ?? ''}
        onChange={(e) => setF((v) => ({ ...v, [chave]: e.target.value }))}
        style={{ width: 160 }}
        inputMode="decimal"
      />
      <div className="a-sub">{dica}</div>
    </label>
  );

  return (
    <div className="a-grid">
      <div className="a-card" style={{ gridColumn: 'span 7' }}>
        <h4>Taxas e custos</h4>
        {campo('taxaPct', 'Taxa do checkout (%)', 'O que o gateway retém de cada venda.')}
        {campo('impostoPct', 'Imposto sobre vendas (%)', 'O que sai em imposto sobre o faturamento.')}
        {campo('custoPorVenda', 'Custo do produto por venda (R$)', 'Zero para produto digital sem custo por unidade.')}
        {campo('impostoAdsPct', 'Imposto sobre a mídia (%)', 'Opcional. Provisão sobre o gasto com anúncios.')}
        {campo('breakEvenRoas', 'ROAS de break-even', 'Abaixo disso o painel avisa. Vazio = não avisa.')}
        <button className="a-btn" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        {config?.atualizadoEm ? (
          <div className="a-sub" style={{ marginTop: 8 }}>
            Última alteração: {dataCurta(config.atualizadoEm)}
          </div>
        ) : null}
      </div>
      <div className="a-card" style={{ gridColumn: 'span 5' }}>
        <h4>Por que estes dois campos travam o lucro</h4>
        <div className="a-sub">
          Sem <b>taxa</b> e <b>imposto</b> preenchidos, todo lugar que mostraria lucro mostra &quot;configure&quot;. É
          de propósito: vazio não é zero. Uma versão anterior tratava campo em branco como 0% e o painel anunciou
          &quot;lucro R$ 77,91&quot; num dia sem nenhum custo cadastrado. Lucro inventado é pior que lucro ausente,
          porque se decide em cima dele.
        </div>
      </div>
    </div>
  );
}

/**
 * OS GATEWAYS DE PIX — um cartão para cada, com URL, Client ID, Secret e o
 * interruptor.
 *
 * "S" e "Z", e não o nome, pelo mesmo motivo de INTEGRACOES: este arquivo vai
 * para o domínio público. S é a primeira, Z a segunda, P a terceira e G a quarta — o NOTAS.md diz.
 *
 * O SECRET NUNCA VOLTA DO SERVIDOR. O campo nasce vazio e mostra só os quatro
 * últimos caracteres do que está salvo; deixar vazio ao salvar mantém a chave.
 *
 * UM LIGADO POR VEZ: ligar um desliga o outro no servidor, e por isso os dois
 * cartões são remontados depois de cada gravação (`versao`) — senão o outro
 * continuaria dizendo "Ligado" sem estar. Ligar testa a chave antes.
 */
interface EstadoGateway {
  url: string;
  clientId: string;
  temSecret: boolean;
  finalDoSecret: string;
  ligado: boolean;
  pronto: boolean;
  urlDoAviso: string;
  semEnderecoPublico: boolean;
  outroPronto: boolean;
  atualizadoEm: string;
}

/**
 * OS PIXELS DO TIKTOK — uma conta de anúncio, um pixel, um link.
 *
 * O principal mora na Vercel e recebe quem chega sem `?tt=`. Os outros são
 * cadastrados aqui (ID + token da Events API) e cada um ganha o SEU link: é o
 * `?tt=<id>` do link que diz ao site de qual conta veio a visita, e a venda vai
 * só para aquele pixel. Sem o link certo no anúncio, a venda cai no principal.
 *
 * O TOKEN NUNCA VOLTA DO SERVIDOR: a lista mostra só os quatro últimos
 * caracteres. Para trocar o token de um pixel, cadastre o mesmo ID de novo.
 */
interface PixelDoPainel {
  id: string;
  nome: string;
  temToken: boolean;
  finalDoToken: string;
  criadoEm: string;
  link: string;
}

interface EstadoDosPixels {
  principal: { id: string; temToken: boolean; link: string };
  pixels: PixelDoPainel[];
  aviso?: string | null;
}

function PixelsTikTok({ senha, avisar }: { senha: string; avisar: (t: string, tipo?: 'ruim') => void }) {
  const endereco = `${BASE}/admin/tiktok-pixels`;
  const [estado, setEstado] = useState<EstadoDosPixels | null>(null);
  const [f, setF] = useState({ id: '', nome: '', token: '' });
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    fetch(endereco, { headers: { 'x-admin-token': senha } })
      .then((r) => r.json())
      .then((corpo) => {
        if (vivo && corpo?.success) setEstado(corpo.data as EstadoDosPixels);
      })
      .catch(() => {
        if (vivo) avisar('Não consegui ler os pixels do TikTok.', 'ruim');
      });
    return () => {
      vivo = false;
    };
  }, [endereco, senha, avisar]);

  const enviar = async (corpo: Record<string, unknown>, deuCerto: string) => {
    setSalvando(true);
    try {
      const r = await fetch(endereco, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
        body: JSON.stringify(corpo),
      });
      const resposta = await r.json().catch(() => ({}));
      if (!r.ok || !resposta?.success) {
        avisar(String(resposta?.error?.message ?? resposta?.message ?? `HTTP ${r.status}`), 'ruim');
        return false;
      }
      const d = resposta.data as EstadoDosPixels;
      setEstado(d);
      avisar(d.aviso ? `${deuCerto} ${d.aviso}` : deuCerto);
      return true;
    } catch {
      avisar('Não consegui salvar.', 'ruim');
      return false;
    } finally {
      setSalvando(false);
    }
  };

  const copiar = (texto: string) => {
    void navigator.clipboard?.writeText(texto).then(
      () => avisar('Link copiado.'),
      () => avisar('Não consegui copiar — selecione o link e copie à mão.', 'ruim'),
    );
  };

  if (!estado) {
    return (
      <div className="a-card" style={{ gridColumn: 'span 12' }}>
        <h4>Pixels do TikTok</h4>
        <div className="a-sub">Carregando…</div>
      </div>
    );
  }

  const linhaDoPixel = (id: string, titulo: string, detalhe: React.ReactNode, link: string, aoApagar?: () => void) => (
    <div key={id} style={{ borderTop: '1px solid var(--bd)', padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <b>{titulo}</b> <span className="a-mut">{id || 'não configurado'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {link ? (
            <button type="button" className="a-btn" onClick={() => copiar(link)}>
              Copiar link
            </button>
          ) : null}
          {aoApagar ? (
            <button type="button" className="a-btn2" disabled={salvando} onClick={aoApagar}>
              Remover
            </button>
          ) : null}
        </div>
      </div>
      <div className="a-sub">{detalhe}</div>
      {link ? (
        <code style={{ userSelect: 'all', wordBreak: 'break-all', fontSize: 12 }}>{link}</code>
      ) : null}
    </div>
  );

  const campo = (chave: 'id' | 'nome' | 'token', rotulo: string, dica: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label style={{ display: 'block', marginBottom: 10, flex: '1 1 220px' }}>
      <div style={{ fontSize: 12, marginBottom: 3 }}>{rotulo}</div>
      <input
        value={f[chave]}
        onChange={(e) => setF((v) => ({ ...v, [chave]: e.target.value }))}
        style={{ width: '100%' }}
        autoComplete="off"
        spellCheck={false}
        {...extra}
      />
      <div className="a-sub">{dica}</div>
    </label>
  );

  return (
    <div className="a-card" style={{ gridColumn: 'span 12' }}>
      <h4>Pixels do TikTok — um por conta de anúncio</h4>
      <div className="a-sub" style={{ marginBottom: 8 }}>
        Cada conta usa o <b>link dela</b> nos anúncios. É o final do link (<code>?tt=…</code>) que diz ao site de qual
        conta veio a visita: o site carrega só aquele pixel, e a venda vai só para ele. Anúncio com o link sem{' '}
        <code>?tt=</code> conta no pixel principal.
      </div>

      {linhaDoPixel(
        estado.principal.id,
        'Principal',
        estado.principal.temToken ? (
          'Recebe quem chega sem ?tt= no link. Configurado na Vercel.'
        ) : (
          <span className="a-neg">Sem token na Vercel: as vendas dele não são enviadas ao TikTok.</span>
        ),
        estado.principal.link,
      )}
      {estado.pixels.map((x) =>
        linhaDoPixel(
          x.id,
          x.nome || 'Conta sem nome',
          x.temToken ? `Token salvo, termina em …${x.finalDoToken}.` : <span className="a-neg">Sem token.</span>,
          x.link,
          () => {
            if (window.confirm(`Remover o pixel ${x.id}? As vendas do link dele deixam de ser enviadas ao TikTok.`)) {
              void enviar({ id: x.id, apagar: true }, 'Pixel removido.');
            }
          },
        ),
      )}

      <div style={{ borderTop: '1px solid var(--bd)', paddingTop: 12, marginTop: 4 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Adicionar pixel de outra conta</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {campo('nome', 'Nome da conta', 'Só para você reconhecer. Ex.: Conta 2.')}
          {campo('id', 'ID do pixel', 'Do Events Manager do TikTok. Uns 20 caracteres, letras e números.')}
          {campo('token', 'Token de acesso (Events API)', 'Gerado no pixel, em Configurações. Fica só no servidor.', { type: 'password' })}
        </div>
        <button
          className="a-btn"
          disabled={salvando}
          onClick={() => {
            void enviar({ id: f.id, nome: f.nome, token: f.token }, 'Pixel salvo.').then((ok) => {
              if (ok) setF({ id: '', nome: '', token: '' });
            });
          }}
        >
          {salvando ? 'Salvando…' : 'Salvar pixel'}
        </button>
      </div>
    </div>
  );
}

/**
 * O AVISO NO CELULAR — para onde o servidor manda "PIX gerado" e "venda paga".
 *
 * A URL é a do aplicativo de notificação do dono e NUNCA volta do servidor: a
 * tela mostra o domínio e o fim dela. Deixar o campo vazio ao salvar mantém a
 * que está salva. Cada tipo de aviso tem o seu interruptor.
 */
interface EstadoDoAviso {
  temUrl: boolean;
  dominio: string;
  finalDaUrl: string;
  pixGerado: boolean;
  vendaPaga: boolean;
  atualizadoEm: string;
  teste?: { ok: boolean; motivo?: string } | null;
}

function AvisoNoCelular({ senha, avisar }: { senha: string; avisar: (t: string, tipo?: 'ruim') => void }) {
  const endereco = `${BASE}/admin/notificacoes`;
  const [estado, setEstado] = useState<EstadoDoAviso | null>(null);
  const [url, setUrl] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    fetch(endereco, { headers: { 'x-admin-token': senha } })
      .then((r) => r.json())
      .then((corpo) => {
        if (vivo && corpo?.success) setEstado(corpo.data as EstadoDoAviso);
      })
      .catch(() => {
        if (vivo) avisar('Não consegui ler o aviso no celular.', 'ruim');
      });
    return () => {
      vivo = false;
    };
  }, [endereco, senha, avisar]);

  const enviar = async (corpo: Record<string, unknown>, deuCerto: string) => {
    setSalvando(true);
    try {
      const r = await fetch(endereco, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
        body: JSON.stringify({ ...(url.trim() ? { url: url.trim() } : {}), ...corpo }),
      });
      const resposta = await r.json().catch(() => ({}));
      if (!r.ok || !resposta?.success) {
        avisar(String(resposta?.error?.message ?? resposta?.message ?? `HTTP ${r.status}`), 'ruim');
        return;
      }
      const d = resposta.data as EstadoDoAviso;
      setEstado(d);
      setUrl('');
      if (d.teste && !d.teste.ok) avisar(`Salvei, mas o teste NÃO chegou: ${d.teste.motivo ?? 'sem resposta'}.`, 'ruim');
      else avisar(d.teste ? 'Teste enviado — olhe o celular.' : deuCerto);
    } catch {
      avisar('Não consegui salvar.', 'ruim');
    } finally {
      setSalvando(false);
    }
  };

  if (!estado) {
    return (
      <div className="a-card" style={{ marginBottom: 10 }}>
        <h4>Aviso no celular</h4>
        <div className="a-sub">Carregando…</div>
      </div>
    );
  }

  const interruptor = (ligado: boolean, rotulo: string, campo: 'pixGerado' | 'vendaPaga') => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <button
        type="button"
        className="a-sw"
        data-on={ligado ? '1' : '0'}
        data-off="0"
        data-carregando={salvando ? '1' : '0'}
        disabled={salvando}
        onClick={() => void enviar({ [campo]: !ligado }, ligado ? `${rotulo}: desligado.` : `${rotulo}: ligado.`)}
      >
        <i />
      </button>
      <span>{rotulo}</span>
    </div>
  );

  return (
    <div className="a-card" style={{ marginBottom: 10 }}>
      <h4>
        <span className={estado.temUrl ? 'a-pos' : 'a-neg'}>●</span> Aviso no celular
      </h4>
      <div className="a-sub" style={{ marginBottom: 10 }}>
        {estado.temUrl
          ? `Enviando para ${estado.dominio} (a URL termina em …${estado.finalDaUrl}).`
          : 'Sem URL salva: nenhum aviso é enviado.'}
      </div>
      {interruptor(estado.vendaPaga, 'Avisar quando uma venda for paga', 'vendaPaga')}
      {interruptor(estado.pixGerado, 'Avisar quando um PIX for gerado', 'pixGerado')}
      <label style={{ display: 'block', margin: '10px 0' }}>
        <div style={{ fontSize: 12, marginBottom: 3 }}>URL de notificação</div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={estado.temUrl ? 'deixe vazio para manter a que está salva' : 'https://…'}
          style={{ width: '100%', maxWidth: 520 }}
        />
        <div className="a-sub">A URL do seu aplicativo de notificação. Fica só no servidor.</div>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="a-btn" disabled={salvando} onClick={() => void enviar({}, 'Salvo.')}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        <button className="a-btn2" disabled={salvando} onClick={() => void enviar({ testar: true }, 'Salvo.')}>
          Enviar teste
        </button>
      </div>
    </div>
  );
}

/**
 * OS LEADS — quem deixou o WhatsApp no funil `/novo` antes de comprar.
 *
 * Duas coisas na mesma tela: EM QUAL PASSO as pessoas saem (os últimos 7 dias
 * do funil novo, um número por tela) e A LISTA de contatos, com o que cada um
 * fez depois: gerou PIX? pagou? É a lista de quem ainda dá para chamar.
 *
 * O que NÃO aparece aqui, porque não existe: o que a pessoa respondeu no quiz.
 * Isso não sai do navegador dela.
 */
interface LeadDoPainel {
  telefone: string;
  nome: string;
  idade?: string;
  funil?: string;
  attrib?: Record<string, string>;
  criadoEm: string;
  checkoutEm?: string;
  gerouPix: boolean;
  comprou: boolean;
  /** Em qual grupo de mensagem o lead está. Vem pronto do servidor (`grupoDoLead`). */
  grupo: 'antes' | 'checkout' | 'pix' | 'comprou';
}

/**
 * OS GRUPOS DE MENSAGEM, como o dono definiu (10/10/2026). Só recebe mensagem
 * quem CHEGOU NO CHECKOUT; a mensagem muda conforme o que a pessoa fez depois.
 */
const GRUPOS_DE_LEAD: Array<[LeadDoPainel['grupo'], string, string, string]> = [
  ['checkout', 'Chegou no checkout e não gerou o PIX', 'Recebe a mensagem 1.', 'a-warn'],
  ['pix', 'Gerou o PIX e não pagou', 'Recebe a mensagem 2.', 'a-warn'],
  ['comprou', 'Pagou', 'Recebe a entrega (e depois o upsell).', 'a-pos'],
  ['antes', 'Saiu antes do checkout', 'NÃO recebe mensagem.', 'a-mut'],
];

const PASSOS_DO_FUNIL_NOVO: Array<[string, string]> = [
  ['chegou', 'Chegaram'],
  ['n1', 'Nome'],
  ['n2', 'Área'],
  ['n3', 'Idade'],
  ['n6', 'Sinais'],
  ['n7', 'Compromisso'],
  ['n8', 'Resultado + WhatsApp'],
  ['vsl', 'VSL'],
  ['checkout', 'Checkout'],
  ['pix', 'PIX gerado'],
];

const ROTULO_DA_IDADE: Record<string, string> = { 'ate-29': 'até 29', '30-45': '30 a 45', '46-60': '46 a 60', '61+': '61 ou mais' };

/* ===========================================================================
 * CENTRAL DE RASTREIO
 *
 * A aba que responde "o que eu colo no anúncio para saber de onde vem o lead".
 *
 * Existe porque o painel sabia LER `utm_content` em quatro telas diferentes e
 * nunca dizia como carimbá-lo. Quem monta a URL errado não vê erro nenhum: as
 * vendas chegam, só que sem anúncio, e o Gerenciador não credita ninguém.
 *
 * Tudo aqui é cópia de um clique. Nada de "monte você mesmo".
 * =========================================================================== */

/** As macros que cada plataforma troca sozinha na hora do clique. */
const URLS_DE_ANUNCIO: Array<{
  id: string;
  nome: string;
  params: string;
  nota: string;
}> = [
  {
    id: 'meta',
    nome: 'Meta (Facebook / Instagram)',
    params:
      'utm_source=facebook&utm_campaign={{campaign.name}}&utm_medium={{adset.name}}&utm_content={{ad.id}}&utm_term={{placement}}',
    nota: 'Cole em Configurações do anúncio → Parâmetros de URL. O Meta troca as chaves {{ }} sozinho. O fbclid ele acrescenta automaticamente.',
  },
  {
    id: 'tiktok',
    nome: 'TikTok Ads',
    params:
      'utm_source=tiktok&utm_campaign=__CAMPAIGN_NAME__&utm_medium=__AID_NAME__&utm_content=__CID__&utm_term=__AID__',
    nota: 'Cole em Configurações do anúncio → URL Tracking. O utm_content tem de ser __CID__: é ele que identifica o criativo.',
  },
  {
    id: 'google',
    nome: 'Google Ads',
    params:
      'utm_source=google&utm_campaign={campaignid}&utm_medium={adgroupid}&utm_content={creative}&utm_term={keyword}',
    nota: 'Cole em Configurações da campanha → Modelo de acompanhamento, ou use o sufixo final de URL.',
  },
];

/** Uma linha de estado: verde quando a peça está de pé. */
function LinhaDeEstado({ ok, titulo, detalhe }: { ok: boolean; titulo: string; detalhe: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 8,
        background: ok ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
        border: `1px solid ${ok ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
        marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 16, lineHeight: '20px', color: ok ? '#22c55e' : '#ef4444' }}>
        {ok ? '✓' : '✕'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{titulo}</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{detalhe}</div>
      </div>
    </div>
  );
}

/** Campo somente-leitura com botão de copiar. */
function CampoCopiavel({
  valor,
  avisar,
  mono = true,
}: {
  valor: string;
  avisar: (t: string, tipo?: 'ruim') => void;
  mono?: boolean;
}) {
  const copiar = () => {
    navigator.clipboard
      .writeText(valor)
      .then(() => avisar('Copiado.'))
      .catch(() => avisar('Não consegui copiar — selecione e copie à mão.', 'ruim'));
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 6 }}>
      <input
        readOnly
        value={valor}
        onFocus={(e) => e.currentTarget.select()}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '9px 11px',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,.15)',
          background: 'rgba(0,0,0,.25)',
          color: 'inherit',
          fontFamily: mono ? 'ui-monospace, Menlo, Consolas, monospace' : 'inherit',
          fontSize: 12,
        }}
      />
      <button type="button" onClick={copiar} style={{ whiteSpace: 'nowrap', padding: '9px 14px' }}>
        Copiar
      </button>
    </div>
  );
}

function CentralDeRastreio({
  senha,
  avisar,
}: {
  senha: string;
  avisar: (t: string, tipo?: 'ruim') => void;
}) {
  const [estado, setEstado] = useState<{
    site: string;
    leads: number;
    eventos: number;
    etapas: string[];
    funil: Record<string, number>;
    tabelasOk: boolean;
    trackingOk: boolean;
    erro?: string;
  } | null>(null);

  const [plataforma, setPlataforma] = useState('meta');

  /* O endereço do site é o da própria página: o painel vive no mesmo domínio
     que o funil, então não há o que configurar nem o que errar. */
  const site = typeof location !== 'undefined' ? location.origin : '';

  useEffect(() => {
    let vivo = true;
    fetch(`${BASE}/admin/rastreio`, { headers: { 'x-admin-token': senha } })
      .then((r) => r.json())
      .then((corpo) => {
        if (!vivo) return;
        if (corpo?.success) setEstado({ ...corpo.data, site });
        else setEstado({ site, leads: 0, eventos: 0, etapas: [], funil: {}, tabelasOk: false, trackingOk: false, erro: corpo?.message });
      })
      .catch(() => {
        if (vivo) avisar('Não consegui ler o estado do rastreio.', 'ruim');
      });
    return () => {
      vivo = false;
    };
  }, [senha, avisar, site]);

  const escolhida = URLS_DE_ANUNCIO.find((p) => p.id === plataforma) ?? URLS_DE_ANUNCIO[0];
  const urlCompleta = `${site}/?${escolhida.params}`;

  return (
    <div style={{ display: 'grid', gap: 22 }}>
      {/* ---------------------------------------------------- 1. ESTADO */}
      <section>
        <h3 style={{ margin: '0 0 4px' }}>Estado do rastreio</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.7 }}>
          Se alguma linha estiver vermelha, o lead chega mas não é gravado.
        </p>

        {estado ? (
          <>
            <LinhaDeEstado
              ok={estado.tabelasOk}
              titulo="Tabelas do banco"
              detalhe={
                estado.tabelasOk
                  ? 'leads, funnel_events e painel_config existem no Supabase.'
                  : 'FALTAM. Rode o arquivo supabase-painel.sql no SQL Editor do Supabase — sem isso nenhum lead é gravado.'
              }
            />
            <LinhaDeEstado
              ok={estado.trackingOk}
              titulo="Script no site"
              detalhe={
                estado.trackingOk
                  ? 'O funil está mandando as etapas para /api/track.'
                  : 'Nenhum evento recebido ainda. Abra o site numa aba anônima e volte aqui.'
              }
            />
            <LinhaDeEstado
              ok={estado.leads > 0}
              titulo={`${estado.leads} lead(s) gravado(s)`}
              detalhe={
                estado.leads > 0
                  ? 'Os dados estão chegando. Veja na aba Leads.'
                  : 'Ainda nenhum. Um lead nasce quando alguém informa CPF ou telefone.'
              }
            />
          </>
        ) : (
          <p style={{ opacity: 0.6, fontSize: 13 }}>Carregando…</p>
        )}
      </section>

      {/* ------------------------------------------ 2. URL DO ANÚNCIO */}
      <section>
        <h3 style={{ margin: '0 0 4px' }}>A URL que vai no anúncio</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.7 }}>
          O <code>utm_content</code> é o que responde <em>qual anúncio vendeu</em>. Sem ele a venda
          entra no total, mas não cai em criativo nenhum.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {URLS_DE_ANUNCIO.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlataforma(p.id)}
              style={{
                padding: '7px 13px',
                borderRadius: 7,
                fontSize: 12,
                border: '1px solid rgba(255,255,255,.15)',
                background: plataforma === p.id ? 'rgba(59,130,246,.25)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              {p.nome}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85 }}>
          Só os parâmetros (é isto que a maioria dos gerenciadores pede)
        </div>
        <CampoCopiavel valor={escolhida.params} avisar={avisar} />

        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, marginTop: 14 }}>
          URL completa (quando o campo pedir o endereço inteiro)
        </div>
        <CampoCopiavel valor={urlCompleta} avisar={avisar} />

        <p
          style={{
            marginTop: 12,
            fontSize: 12,
            opacity: 0.75,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(59,130,246,.08)',
            border: '1px solid rgba(59,130,246,.2)',
          }}
        >
          {escolhida.nota}
        </p>
      </section>

      {/* ------------------------------------------- 3. O QUE É LIDO */}
      <section>
        <h3 style={{ margin: '0 0 4px' }}>O que o painel guarda de cada lead</h3>
        <p style={{ margin: '0 0 10px', fontSize: 12, opacity: 0.7 }}>
          A origem é capturada na <strong>primeira</strong> visita e nunca é apagada: se a pessoa
          recarregar ou voltar depois, o crédito continua com o anúncio que a trouxe.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
            gap: 8,
            fontSize: 12,
          }}
        >
          {[
            ['utm_source', 'de qual plataforma'],
            ['utm_campaign', 'campanha'],
            ['utm_medium', 'conjunto de anúncios'],
            ['utm_content', 'O ANÚNCIO — o que importa'],
            ['utm_term', 'posicionamento / palavra'],
            ['fbclid', 'clique do Facebook'],
            ['ttclid', 'clique do TikTok'],
            ['gclid', 'clique do Google'],
            ['_fbp / _fbc', 'cookies do pixel'],
            ['nome, CPF, e-mail', 'o que a pessoa digitou'],
            ['telefone', 'contato'],
            ['IP e navegador', 'rastro técnico'],
          ].map(([campo, oque]) => (
            <div
              key={campo}
              style={{
                padding: '8px 10px',
                borderRadius: 7,
                background: 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.08)',
              }}
            >
              <div style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11 }}>
                {campo}
              </div>
              <div style={{ opacity: 0.65, marginTop: 2 }}>{oque}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ 4. O FUNIL */}
      {estado && estado.etapas.length > 0 ? (
        <section>
          <h3 style={{ margin: '0 0 4px' }}>Etapas do funil</h3>
          <p style={{ margin: '0 0 10px', fontSize: 12, opacity: 0.7 }}>
            Quantas pessoas <strong>únicas</strong> chegaram a cada etapa hoje. Recarregar a página
            não conta duas vezes.
          </p>
          <div style={{ display: 'grid', gap: 6 }}>
            {estado.etapas.map((etapa) => {
              const n = estado.funil[etapa] ?? 0;
              const topo = estado.funil[estado.etapas[0]] || 1;
              const pct = Math.round((n / topo) * 100);
              return (
                <div key={etapa} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 110, fontSize: 12, opacity: 0.8 }}>{etapa}</div>
                  <div
                    style={{
                      flex: 1,
                      height: 20,
                      borderRadius: 5,
                      background: 'rgba(255,255,255,.06)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: 'rgba(59,130,246,.55)',
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                  <div style={{ width: 70, textAlign: 'right', fontSize: 12 }}>
                    {n} <span style={{ opacity: 0.5 }}>({pct}%)</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------- 5. ENDEREÇOS */}
      <section>
        <h3 style={{ margin: '0 0 10px' }}>Endereços</h3>
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85 }}>Site (o que vai no anúncio)</div>
        <CampoCopiavel valor={site} avisar={avisar} />
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, marginTop: 12 }}>
          Painel (este endereço)
        </div>
        <CampoCopiavel valor={`${site}/admin`} avisar={avisar} />
      </section>
    </div>
  );
}

function Leads({ senha, avisar }: { senha: string; avisar: (t: string, tipo?: 'ruim') => void }) {
  const [dados, setDados] = useState<{
    passos: Record<string, number>;
    grupos: Record<LeadDoPainel['grupo'], number>;
    total: number;
    comPix: number;
    compraram: number;
    leads: LeadDoPainel[];
  } | null>(null);
  const [grupo, setGrupo] = useState<'' | LeadDoPainel['grupo']>('');

  useEffect(() => {
    let vivo = true;
    fetch(`${BASE}/admin/leads`, { headers: { 'x-admin-token': senha } })
      .then((r) => r.json())
      .then((corpo) => {
        if (vivo && corpo?.success) setDados(corpo.data);
      })
      .catch(() => {
        if (vivo) avisar('Não consegui ler os leads.', 'ruim');
      });
    return () => {
      vivo = false;
    };
  }, [senha, avisar]);

  if (!dados) {
    return (
      <div className="a-card">
        <h4>Leads</h4>
        <div className="a-sub">Carregando…</div>
      </div>
    );
  }

  const lista = grupo ? dados.leads.filter((l) => l.grupo === grupo) : dados.leads;
  const topo = dados.passos.chegou || 0;

  const baixar = () => {
    const linhas = [['quando', 'nome', 'whatsapp', 'idade', 'origem', 'campanha', 'grupo', 'gerou_pix', 'comprou']].concat(
      lista.map((l) => [
        l.criadoEm,
        l.nome,
        l.telefone,
        l.idade ?? '',
        l.attrib?.origem ?? '',
        (l.attrib?.campanha ?? '').split('|')[0],
        l.grupo,
        l.gerouPix ? 'sim' : 'nao',
        l.comprou ? 'sim' : 'nao',
      ]),
    );
    const csv = linhas.map((c) => c.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'leads.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="a-grid" style={{ marginBottom: 10 }}>
        <div className="a-card" style={{ gridColumn: 'span 4' }}>
          <h4>Contatos capturados</h4>
          <div className="a-valor">{dados.total}</div>
          <div className="a-sub">Deixaram o WhatsApp antes da VSL.</div>
        </div>
        <div className="a-card" style={{ gridColumn: 'span 4' }}>
          <h4>Geraram PIX</h4>
          <div className="a-valor">{dados.comPix}</div>
          <div className="a-sub">{dados.total ? `${((100 * dados.comPix) / dados.total).toFixed(1)}% dos contatos.` : '—'}</div>
        </div>
        <div className="a-card" style={{ gridColumn: 'span 4' }}>
          <h4>Compraram</h4>
          <div className="a-valor">{dados.compraram}</div>
          <div className="a-sub">{dados.total ? `${((100 * dados.compraram) / dados.total).toFixed(1)}% dos contatos.` : '—'}</div>
        </div>
      </div>

      <div className="a-card" style={{ marginBottom: 10 }}>
        <h4>Grupos de mensagem</h4>
        <div className="a-sub" style={{ marginBottom: 8 }}>
          Só recebe mensagem quem chegou no checkout. Toque num grupo para ver a lista dele.
        </div>
        <div className="a-grid">
          {GRUPOS_DE_LEAD.map(([chave, titulo, oQueRecebe, cor]) => (
            <button
              key={chave}
              type="button"
              className="a-card"
              onClick={() => setGrupo(grupo === chave ? '' : chave)}
              style={{ gridColumn: 'span 3', textAlign: 'left', cursor: 'pointer', outline: grupo === chave ? '2px solid var(--ac)' : 'none' }}
            >
              <div className="a-valor">{dados.grupos?.[chave] ?? 0}</div>
              <div style={{ fontWeight: 600 }}>{titulo}</div>
              <div className={`a-sub ${cor}`}>{oQueRecebe}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="a-card" style={{ marginBottom: 10 }}>
        <h4>Em qual passo as pessoas saem — funil novo, últimos 7 dias</h4>
        {topo === 0 ? (
          <div className="a-sub">Ainda sem visitas no funil novo.</div>
        ) : (
          <div className="a-rolo">
            <table className="a-tab-t">
              <thead>
                <tr>
                  <th className="esq">Passo</th>
                  <th>Pessoas</th>
                  <th>% de quem chegou</th>
                  <th>Perdeu do passo anterior</th>
                </tr>
              </thead>
              <tbody>
                {PASSOS_DO_FUNIL_NOVO.map(([chave, rotulo], i) => {
                  const n = dados.passos[chave] ?? 0;
                  const antes = i === 0 ? n : (dados.passos[PASSOS_DO_FUNIL_NOVO[i - 1][0]] ?? 0);
                  const perdeu = antes > 0 ? 100 - (100 * n) / antes : 0;
                  return (
                    <tr key={chave}>
                      <td className="esq">{rotulo}</td>
                      <td>{n}</td>
                      <td>{((100 * n) / topo).toFixed(1)}%</td>
                      <td className={i > 0 && perdeu >= 30 ? 'a-neg' : ''}>{i === 0 ? '—' : `${perdeu.toFixed(0)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="a-filtros">
        <select value={grupo} onChange={(e) => setGrupo(e.target.value as '' | LeadDoPainel['grupo'])}>
          <option value="">Todos os grupos</option>
          {GRUPOS_DE_LEAD.map(([chave, titulo]) => (
            <option key={chave} value={chave}>
              {titulo}
            </option>
          ))}
        </select>
        <span className="a-mut">
          {lista.length} de {dados.leads.length}
        </span>
        <button className="a-btn2" onClick={baixar} disabled={lista.length === 0}>
          Baixar lista (CSV)
        </button>
      </div>

      <div className="a-rolo" style={{ marginTop: 10 }}>
        <table className="a-tab-t">
          <thead>
            <tr>
              <th className="esq">Quando</th>
              <th className="esq">Nome</th>
              <th className="esq">WhatsApp</th>
              <th className="esq">Idade</th>
              <th className="esq">Origem</th>
              <th className="esq">Depois disso</th>
            </tr>
          </thead>
          <tbody>
            {lista.slice(0, 500).map((l) => (
              <tr key={l.telefone}>
                <td className="esq a-mut">{dataCurta(l.criadoEm)}</td>
                <td className="esq a-sensivel">{l.nome || '—'}</td>
                <td className="esq a-sensivel">{l.telefone}</td>
                <td className="esq a-mut">{l.idade ? (ROTULO_DA_IDADE[l.idade] ?? l.idade) : '—'}</td>
                <td className="esq a-mut">
                  {[l.attrib?.origem, (l.attrib?.campanha ?? '').split('|')[0]].filter(Boolean).join(' · ') || '—'}
                </td>
                <td className="esq">
                  {l.grupo === 'comprou' ? (
                    <span className="a-pos">● pagou</span>
                  ) : l.grupo === 'pix' ? (
                    <span className="a-warn">● gerou o PIX e não pagou</span>
                  ) : l.grupo === 'checkout' ? (
                    <span className="a-warn">● chegou no checkout e não gerou o PIX</span>
                  ) : (
                    <span className="a-mut">● saiu antes do checkout</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GatewaysPix({
  senha,
  avisar,
  aoSalvar,
}: {
  senha: string;
  avisar: (t: string, tipo?: 'ruim') => void;
  aoSalvar: () => void;
}) {
  const [versao, setVersao] = useState(0);
  const gravou = useCallback(() => {
    setVersao((v) => v + 1);
    aoSalvar();
  }, [aoSalvar]);
  return (
    <>
      <FormGateway key={`s${versao}`} letra="s" senha={senha} avisar={avisar} aoSalvar={gravou} />
      <FormGateway key={`z${versao}`} letra="z" senha={senha} avisar={avisar} aoSalvar={gravou} />
      <FormGateway key={`p${versao}`} letra="p" senha={senha} avisar={avisar} aoSalvar={gravou} />
      <FormGateway key={`g${versao}`} letra="g" senha={senha} avisar={avisar} aoSalvar={gravou} />
      <FormGateway key={`b${versao}`} letra="b" senha={senha} avisar={avisar} aoSalvar={gravou} />
    </>
  );
}

function FormGateway({
  letra,
  senha,
  avisar,
  aoSalvar,
}: {
  letra: 's' | 'z' | 'p' | 'g' | 'b';
  senha: string;
  avisar: (t: string, tipo?: 'ruim') => void;
  aoSalvar: () => void;
}) {
  const nome = `Gateway ${letra.toUpperCase()}`;
  const endereco = `${BASE}/admin/gateways/${letra}`;
  const [estado, setEstado] = useState<EstadoGateway | null>(null);
  const [f, setF] = useState({ url: '', clientId: '', secret: '' });
  const [salvando, setSalvando] = useState(false);

  const aplicar = useCallback((d: EstadoGateway) => {
    setEstado(d);
    setF({ url: d.url, clientId: d.clientId, secret: '' });
  }, []);

  useEffect(() => {
    let vivo = true;
    fetch(endereco, { headers: { 'x-admin-token': senha } })
      .then((r) => r.json())
      .then((corpo) => {
        if (vivo && corpo?.success) aplicar(corpo.data as EstadoGateway);
      })
      .catch(() => {
        if (vivo) avisar(`Não consegui ler o ${nome}.`, 'ruim');
      });
    return () => {
      vivo = false;
    };
  }, [endereco, nome, senha, aplicar, avisar]);

  /* Um envio só para os campos e para o interruptor: ligar com o formulário
     ainda não salvo usaria a chave velha no teste. */
  const enviar = async (ligado: boolean) => {
    setSalvando(true);
    try {
      const r = await fetch(endereco, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
        body: JSON.stringify({ ...f, ligado }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok || !corpo?.success) {
        avisar(String(corpo?.error?.message ?? corpo?.message ?? `HTTP ${r.status}`), 'ruim');
        return;
      }
      const d = corpo.data as EstadoGateway;
      avisar(d.ligado ? `Ligado: o PIX passa a nascer no ${nome}.` : `${nome} salvo.`);
      aoSalvar();
    } catch {
      avisar('Não consegui salvar.', 'ruim');
    } finally {
      setSalvando(false);
    }
  };

  if (!estado) {
    return (
      <div className="a-card" style={{ gridColumn: 'span 6' }}>
        <h4>{nome}</h4>
        <div className="a-sub">Carregando…</div>
      </div>
    );
  }

  const campo = (
    chave: 'url' | 'clientId' | 'secret',
    rotulo: string,
    dica: string,
    extra: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div style={{ fontSize: 12, marginBottom: 3 }}>{rotulo}</div>
      <input
        value={f[chave]}
        onChange={(e) => setF((v) => ({ ...v, [chave]: e.target.value }))}
        style={{ width: '100%' }}
        autoComplete="off"
        spellCheck={false}
        {...extra}
      />
      <div className="a-sub">{dica}</div>
    </label>
  );

  return (
    <div className="a-card" style={{ gridColumn: 'span 6' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <button
          type="button"
          className="a-sw"
          data-on={estado.ligado ? '1' : '0'}
          data-off="0"
          data-carregando={salvando ? '1' : '0'}
          disabled={salvando}
          title={estado.ligado ? 'Desligar' : 'Ligar: testa a chave, passa a cobrar por aqui e desliga o outro'}
          onClick={() => void enviar(!estado.ligado)}
        >
          <i />
        </button>
        <h4 style={{ margin: 0 }}>
          <span className={estado.pronto ? 'a-pos' : 'a-neg'}>●</span> {nome} — {estado.ligado ? 'Ligado' : 'Desligado'}
        </h4>
      </div>

      {campo('url', 'URL da API', 'Vazio usa o endereço padrão. Tem de começar com https://', { placeholder: 'https://…' })}
      {/* O P tem uma chave só: pedir Client ID ali seria um campo que nada lê. */}
      {letra === 'p' || letra === 'g' || letra === 'b' ? null : campo('clientId', 'Client ID', 'O identificador da credencial no painel do gateway.')}
      {campo(
        'secret',
        letra === 's' ? 'Secret (token)' : letra === 'p' || letra === 'g' || letra === 'b' ? 'Chave secreta' : 'Client Secret',
        estado.temSecret
          ? `Salvo, termina em …${estado.finalDoSecret}. Deixe vazio para manter.`
          : 'Ainda não salvo. O painel do gateway costuma mostrar a chave uma vez só.',
        { type: 'password', placeholder: estado.temSecret ? '••••••••' : '' },
      )}

      <button className="a-btn" disabled={salvando} onClick={() => void enviar(estado.ligado)}>
        {salvando ? 'Salvando…' : 'Salvar'}
      </button>

      <div className="a-sub" style={{ marginTop: 12 }}>
        {estado.semEnderecoPublico ? (
          <b className="a-neg">Falta PUBLIC_BASE_URL na Vercel: sem ela o aviso de pagamento não tem endereço e não dá para ligar.</b>
        ) : estado.urlDoAviso ? (
          <>
            URL de webhook (já vai junto de cada cobrança; cole no painel do gateway se ele pedir):
            <br />
            <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{estado.urlDoAviso}</code>
          </>
        ) : (
          'Salve o Secret para ver a URL de webhook.'
        )}
      </div>
      {!estado.pronto && !estado.outroPronto ? (
        <div className="a-sub a-neg" style={{ marginTop: 8 }}>
          Nenhum gateway ligado: o checkout não gera PIX.
        </div>
      ) : null}
      {estado.atualizadoEm ? (
        <div className="a-sub" style={{ marginTop: 8 }}>Última alteração: {dataCurta(estado.atualizadoEm)}</div>
      ) : null}
    </div>
  );
}

function FormDespesas({
  config,
  senha,
  avisar,
  aoSalvar,
}: {
  config: Config | null;
  senha: string;
  avisar: (t: string, tipo?: 'ruim') => void;
  aoSalvar: () => void;
}) {
  const [lista, setLista] = useState(() => config?.despesas ?? []);
  const [salvando, setSalvando] = useState(false);
  const hoje = new Date().toISOString().slice(0, 10);

  const salvar = async () => {
    setSalvando(true);
    try {
      const r = await fetch(`${BASE}/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': senha },
        body: JSON.stringify({ despesas: lista }),
      });
      if (!r.ok) avisar('Não consegui salvar.', 'ruim');
      else {
        avisar('Despesas salvas.');
        aoSalvar();
      }
    } catch {
      avisar('Não consegui salvar.', 'ruim');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="a-card">
      <h4>Despesas do período</h4>
      <div className="a-sub" style={{ marginBottom: 10 }}>
        Copy, ferramenta, equipe. Elas entram no lucro do período que cruzarem — e <b>não</b> entram na linha de nenhum
        anúncio: &quot;assinatura de ferramenta&quot; não pertence a um criativo, e dividi-la por todos faria todo mundo
        aparecer no prejuízo.
      </div>
      {lista.map((d, i) => (
        <div key={d.id} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <input
            value={d.descricao}
            placeholder="descrição"
            style={{ flex: 1, minWidth: 160 }}
            onChange={(e) => setLista((l) => l.map((x, j) => (j === i ? { ...x, descricao: e.target.value } : x)))}
          />
          <input
            value={String(d.valor)}
            placeholder="0,00"
            style={{ width: 100 }}
            inputMode="decimal"
            onChange={(e) =>
              setLista((l) =>
                l.map((x, j) => (j === i ? { ...x, valor: Number(e.target.value.replace(',', '.')) || 0 } : x)),
              )
            }
          />
          <input
            type="date"
            value={d.de}
            onChange={(e) => setLista((l) => l.map((x, j) => (j === i ? { ...x, de: e.target.value } : x)))}
          />
          <input
            type="date"
            value={d.ate}
            onChange={(e) => setLista((l) => l.map((x, j) => (j === i ? { ...x, ate: e.target.value } : x)))}
          />
          <button className="a-btn2" onClick={() => setLista((l) => l.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          className="a-btn2"
          onClick={() =>
            setLista((l) => [
              ...l,
              { id: `d${Math.random().toString(36).slice(2, 10)}`, descricao: '', valor: 0, de: hoje, ate: hoje },
            ])
          }
        >
          + Lançar despesa
        </button>
        <button className="a-btn" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * O separador é `;` e o arquivo leva BOM. Os dois por causa do Excel em
 * português: com vírgula ele joga a linha inteira numa célula só, e sem BOM ele
 * lê o arquivo como Latin-1 e "Oração" vira "OraÃ§Ã£o".
 */
function paraCsv(cabecalho: string[], linhas: string[][]): string {
  const esc = (c: string) => `"${String(c ?? '').replace(/"/g, '""')}"`;
  return `﻿${[cabecalho, ...linhas].map((l) => l.map(esc).join(';')).join('\r\n')}`;
}

function linhasParaCsv(linhas: Linha[], colunas: Coluna[]): string {
  return paraCsv(
    ['Nome', 'ID', 'Campanha', 'Conjunto', 'Status', ...colunas.map((c) => c.rotulo)],
    linhas.map((l) => [
      l.nome,
      l.id,
      l.campanha,
      l.conjunto,
      l.status,
      ...colunas.map((c) => {
        const v = c.valor(l);
        if (v === null || v === undefined) return '';
        /* Número sai com vírgula decimal: é o que a planilha em pt-BR entende. */
        return typeof v === 'number' ? String(v).replace('.', ',') : String(v);
      }),
    ]),
  );
}

function vendasParaCsv(vendas: Venda[]): string {
  return paraCsv(
    ['Pedido', 'Quando', 'Nome', 'E-mail', 'Telefone', 'Status', 'Valor', 'Itens', 'Anúncio', 'Campanha', 'Meta'],
    vendas.map((v) => [
      v.id,
      v.criadoEm,
      v.nome,
      v.email,
      v.telefone,
      v.status,
      String(v.valor).replace('.', ','),
      (v.itens ?? []).join('|'),
      v.attrib?.criativo ?? '',
      v.attrib?.campanha ?? '',
      v.metaEnviadoEm ? 'enviado' : '',
    ]),
  );
}

function baixarCsv(nome: string, conteudo: string): void {
  const url = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  /* O objeto fica na memória até ser solto — e o painel abre isto muitas vezes. */
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

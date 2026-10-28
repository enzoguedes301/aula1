/* ===========================================================================
 * RASTREIO DO FUNIL — por onde o lead passou.
 *
 * Carregado no <head> do index.html, antes do bundle. Não depende de React,
 * de gateway, nem de nada do bundle: é JS puro e fala só com /api/track/*.
 *
 * O QUE ELE FAZ
 *
 *   1. Captura a atribuição (de qual anúncio a pessoa veio) na PRIMEIRA carga
 *      e guarda. Recarga/voltar chega com URL limpa e não apaga o que já tem.
 *   2. Acompanha a navegação do SPA (pushState/replaceState/popstate) e manda
 *      uma batida por etapa alcançada.
 *   3. Intercepta o /api/pix para capturar os dados que a pessoa digitou
 *      (nome, CPF, e-mail, telefone) e mandar para o painel.
 *
 * REGRA QUE NÃO SE QUEBRA: nada aqui pode derrubar o funil. Todo caminho tem
 * try/catch e todo fetch tem .catch(). Medição que quebra a venda é pior do
 * que medição nenhuma.
 * =========================================================================== */
(function () {
  'use strict';

  var API = '/api/track';
  var CHAVE_ATRIB = 'funil.atribuicao';
  var CHAVE_SESSAO = 'funil.sessao';
  var FUNIL = 'cnh';

  /* --- utilidades ------------------------------------------------------- */

  function corta(obj) {
    var saida = {};
    for (var k in obj) {
      var v = obj[k];
      if (typeof v === 'string' && v.trim()) saida[k] = v.trim().slice(0, 300);
    }
    return saida;
  }

  function cookie(nome) {
    try {
      var achado = document.cookie.split('; ').find(function (c) {
        return c.indexOf(nome + '=') === 0;
      });
      return achado ? decodeURIComponent(achado.slice(nome.length + 1)) : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /* Um id por aba. Sobrevive a recarga, morre ao fechar. É ele que faz a
     contagem ser de pessoas e não de pageviews. */
  function sessao() {
    try {
      var v = sessionStorage.getItem(CHAVE_SESSAO);
      if (v) return v;
      v = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(CHAVE_SESSAO, v);
      return v;
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  }

  /* --- atribuição: capturada uma vez, nunca apagada --------------------- */

  try {
    var u = new URLSearchParams(location.search);
    var novo = corta({
      origem:   u.get('utm_source'),
      campanha: u.get('utm_campaign'),
      conjunto: u.get('utm_medium'),
      criativo: u.get('utm_content'),   // o id do anúncio
      termo:    u.get('utm_term'),
      fbclid:   u.get('fbclid'),
      gclid:    u.get('gclid'),
      ttclid:   u.get('ttclid')
    });
    if (Object.keys(novo).length) {
      novo.em = new Date().toISOString();
      localStorage.setItem(CHAVE_ATRIB, JSON.stringify(novo));
    }
  } catch (e) { /* storage bloqueado: segue sem atribuição */ }

  function atribuicao() {
    try {
      var base = JSON.parse(localStorage.getItem(CHAVE_ATRIB) || '{}');
      var completo = corta(Object.assign({}, base, {
        fbp: cookie('_fbp'),
        fbc: cookie('_fbc'),
        ttp: cookie('_ttp')
      }));
      return Object.keys(completo).length ? completo : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /* --- envio ------------------------------------------------------------ */

  function enviar(rota, corpo) {
    try {
      fetch(API + rota, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,          // sobrevive à troca de tela
        body: JSON.stringify(corpo)
      }).catch(function () {});
    } catch (e) { /* engolido de propósito */ }
  }

  var jaFoi = {};

  /* Uma batida por etapa, por sessão. */
  function marcar(etapa, extra) {
    try {
      if (navigator.webdriver) return;    // robô não conta
      if (jaFoi[etapa]) return;
      jaFoi[etapa] = true;

      var a = atribuicao() || {};
      var corpo = {
        sessao: sessao(),
        etapa: etapa,
        funil: FUNIL,
        ad: a.criativo,
        attrib: a,
        url: location.href,
        referrer: document.referrer || undefined
      };
      if (extra) for (var k in extra) corpo[k] = extra[k];

      enviar('/evento', corpo);
    } catch (e) { /* engolido */ }
  }

  /* Dados da pessoa. Pode ser chamado quantas vezes quiser: o backend mescla
     sem apagar o que já sabia. */
  function identificar(dados) {
    try {
      if (!dados) return;
      var a = atribuicao() || {};
      var corpo = Object.assign({}, dados, {
        sessao: sessao(),
        funil: FUNIL,
        origem: FUNIL,
        attrib: a,
        url: location.href
      });
      enviar('/lead', corpo);
    } catch (e) { /* engolido */ }
  }

  /* --- de qual tela estamos falando ------------------------------------- */

  function etapaDaUrl() {
    var p = location.pathname.toLowerCase().replace(/\/+$/, '');

    if (p === '' || p === '/') return 'chegou';
    if (p.indexOf('/login') === 0) return 'login';
    if (p.indexOf('/chat') === 0) return 'chat';
    if (p.indexOf('/verif') === 0) return 'verificacao';
    if (p.indexOf('/saiba-mais') === 0) return 'saiba_mais';
    if (p.indexOf('/cadastro-concluido') === 0) return 'cadastro';
    if (p.indexOf('/pix-payment') === 0) return 'pix';
    if (p.indexOf('/pagamento') === 0) return 'pagamento';
    if (p.indexOf('/success') === 0 || p.indexOf('/sucess') === 0) return 'pago';
    return null;
  }

  function olharTela() {
    var etapa = etapaDaUrl();
    if (etapa) marcar(etapa);
  }

  /* --- navegação do SPA: o React troca de tela sem recarregar ----------- */

  try {
    var push = history.pushState;
    history.pushState = function () {
      push.apply(this, arguments);
      setTimeout(olharTela, 0);
    };
    var replace = history.replaceState;
    history.replaceState = function () {
      replace.apply(this, arguments);
      setTimeout(olharTela, 0);
    };
    window.addEventListener('popstate', function () { setTimeout(olharTela, 0); });
  } catch (e) { /* sem SPA tracking, mas a 1ª tela ainda conta */ }

  /* --- captura os dados digitados, no caminho do PIX -------------------- */

  try {
    var fetchOriginal = window.fetch;
    window.fetch = function (entrada, opcoes) {
      try {
        var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';

        if (url.indexOf('/api/pix') !== -1 && opcoes && opcoes.body) {
          var b = JSON.parse(opcoes.body);
          identificar({
            nome: b.nome || b.name,
            cpf: b.cpf || b.document,
            email: b.email,
            telefone: b.phone || b.telefone,
            etapa: 'pix'
          });
        }

        if (url.indexOf('/api/consulta') !== -1 && opcoes && opcoes.body) {
          var c = JSON.parse(opcoes.body);
          if (c.cpf) identificar({ cpf: c.cpf, etapa: 'verificacao' });
        }
      } catch (e) { /* o parse falhou: segue a requisição normalmente */ }

      return fetchOriginal.apply(this, arguments);
    };
  } catch (e) { /* sem interceptação, o resto continua funcionando */ }

  /* --- exposto para o bundle, se um dia quiser chamar ------------------- */

  window.funilRastreio = { marcar: marcar, identificar: identificar, atribuicao: atribuicao };

  /* --- primeira tela ---------------------------------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', olharTela);
  } else {
    olharTela();
  }
})();

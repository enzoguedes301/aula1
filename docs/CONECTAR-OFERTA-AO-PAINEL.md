# Conectar uma oferta ao Painel (guia para IA)

> **Para quem lê isto:** você é uma IA/LLM encarregada de ligar o projeto de
> uma OFERTA (uma landing/funil de vendas) a um PAINEL de tráfego que já existe
> e já está hospedado. O painel é tipo uma UTMify: ele recebe os eventos da
> oferta (visita, lead, checkout, venda) + a atribuição do anúncio, cruza com o
> gasto do Meta/TikTok e mostra ROAS, lucro, CPA e vendas por criativo. Este
> arquivo é a especificação completa do que a oferta precisa mandar. Siga-o ao
> pé da letra; não invente campos nem rotas.

---

## 0. O modelo mental (leia antes de tudo)

O painel **não é um script que você cola e pronto**. Ele é um **backend** (uma
função HTTP, `api/index.ts`) com um banco Redis e uma tela em `/admin`. A oferta
se conecta **chamando as rotas HTTP desse backend** e mandando junto a
**atribuição** (de qual anúncio a pessoa veio).

Existem dois jeitos de ligar uma oferta. Escolha **um**:

- **Jeito A — o painel é o checkout (recomendado, zero mudança no backend).**
  A oferta usa as rotas `POST /orders`, `GET /orders/:id` e
  `GET /orders/:id/access` do painel como seu checkout de PIX. A venda nasce
  dentro do painel, então ele já sabe tudo. É assim que o projeto original
  funciona. **Use este se a oferta ainda não tem checkout/gateway próprio.**

- **Jeito B — a oferta tem checkout próprio e você só quer rastrear.**
  A oferta manda só os eventos de funil (`POST /eventos`) e os leads
  (`POST /leads`), e o painel recebe a venda pelo **webhook do gateway**. Isto
  exige que o gateway da oferta mande webhook para o painel **e** que exista no
  backend uma rota que transforme esse webhook numa venda. O backend atual só
  cria venda via `POST /orders`; se a oferta não passar por `/orders`, o painel
  **não terá a venda** a menos que o backend ganhe uma rota de "ingerir venda
  externa". **Se cair neste caso, pare e avise o dono: é trabalho no backend,
  não dá para resolver só no lado da oferta.**

> Resumo: se a oferta é nova e você controla o checkout, faça o **Jeito A**.
> Todo o resto deste guia assume o Jeito A, e marca o que é opcional.

---

## 1. O endereço do painel e o envelope das respostas

- **Base da API.** Tudo é relativo a uma base. No projeto original a base é
  `VITE_API_BASE_URL` (ex.: `https://painel.seudominio.com/api`). Guarde o
  endereço que o dono te passar como `PAINEL_BASE` e monte toda chamada como
  `PAINEL_BASE + '/orders'`, etc.
- **Toda resposta vem embrulhada.** Só é sucesso quando `success` é
  **exatamente** `true`:

  ```json
  { "success": true,  "data": { ... } }
  { "success": false, "error": "CODIGO", "message": "texto para o cliente", "field": "email" }
  ```

  O `message` é mostrado na tela **sem tradução** — escreva na língua de quem
  compra. O `field` (opcional) acende o campo do formulário.
- **CORS é lista fechada.** O backend só responde para origens cadastradas em
  `ALLOWED_ORIGINS`. **O domínio da oferta PRECISA estar nessa lista** (passo 6),
  senão toda chamada falha no navegador. Não existe `*`.

---

## 2. Atribuição — o coração "UTMify" (obrigatório)

Isto é o que faz o painel responder "qual anúncio vendeu". Sem isto, ele diz
quanto entrou e não diz de onde.

**Regras que não se quebram:**

1. `utm_*` e `fbclid`/`ttclid` só existem na **primeira** carga. Capture na
   primeira visita e **guarde** (localStorage). Recarga/voltar chega com URL
   limpa — **não apague** o que já guardou.
2. A atribuição viaja no **CORPO** do pedido, **nunca na URL**.
3. **Nada do que a pessoa respondeu no quiz/formulário entra na atribuição.**
   Só o carimbo do anúncio e os cookies do pixel.

Cole este script na oferta (vanilla, serve para qualquer stack). Ele reproduz o
`src/lib/atribuicao.ts` do projeto:

```html
<script>
(function () {
  var CHAVE = 'oferta.atribuicao';
  function corta(o){var s={};for(var k in o){var v=o[k];if(typeof v==='string'&&v.trim())s[k]=v.trim().slice(0,300);}return s;}
  function cookie(n){try{var a=document.cookie.split('; ').find(function(c){return c.indexOf(n+'=')===0;});return a?decodeURIComponent(a.slice(n.length+1)):undefined;}catch(e){return undefined;}}
  // Captura 1x, só se vier carimbo novo na URL.
  try {
    var u = new URLSearchParams(location.search);
    var novo = corta({
      origem:   u.get('utm_source'),
      campanha: u.get('utm_campaign'),
      conjunto: u.get('utm_medium'),
      criativo: u.get('utm_content'),   // <- o ID do anúncio. É ele que responde "qual anúncio vendeu".
      termo:    u.get('utm_term'),
      fbclid:   u.get('fbclid'),
      gclid:    u.get('gclid'),
      ttclid:   u.get('ttclid')
    });
    if (Object.keys(novo).length) { novo.em = new Date().toISOString(); localStorage.setItem(CHAVE, JSON.stringify(novo)); }
  } catch (e) {}
  // Expõe a função que devolve a atribuição ATUAL (com os cookies lidos na hora).
  window.atribuicaoAtual = function () {
    try {
      var base = JSON.parse(localStorage.getItem(CHAVE) || '{}');
      var completo = corta(Object.assign({}, base, { fbp: cookie('_fbp'), fbc: cookie('_fbc'), ttp: cookie('_ttp') }));
      return Object.keys(completo).length ? completo : undefined;
    } catch (e) { return undefined; }
  };
})();
</script>
```

Daqui em diante, `window.atribuicaoAtual()` devolve o objeto `attrib` que vai em
todo pedido.

---

## 3. Contagem de funil — `POST /eventos` (obrigatório para ter o funil)

Toda vez que a pessoa chega numa etapa, mande **uma** batida. É o que alimenta
as taxas de conversão do painel (quantos chegaram, quantos foram ao checkout,
quantos geraram PIX).

- **Rota:** `POST {PAINEL_BASE}/eventos`
- **Corpo:** `{ "sessao": <id aleatório da sessão>, "etapa": <etapa>, "funil": <nome do funil>, "ad": <id do criativo> }`
- **Resposta:** `204` (sem corpo). **Ignore erros.** Medição **nunca** pode
  derrubar a oferta.
- `sessao`: um id aleatório gerado uma vez por aba (guarde em `sessionStorage`).
  Serve para não contar a mesma pessoa duas vezes quando ela volta.
- `ad`: o `criativo` da atribuição (`utm_content`). É o que deixa o painel
  dividir o gasto por anúncio.
- `etapa`: use os nomes que o painel entende. Os padrão são:
  `chegou`, `quiz`, `depoimentos`, `vsl`, `checkout`, `pix`.
  (Há outros no projeto; nome novo precisa ser aceito no backend também.)
- **Mande cada etapa uma vez só por sessão.** E use `keepalive: true`, para a
  batida da última etapa sobreviver à troca de tela.

Snippet:

```html
<script>
(function () {
  var PAINEL_BASE = 'https://painel.seudominio.com/api'; // <- troque pelo endereço real
  var FUNIL = 'oferta';                                   // <- nome desta oferta no painel
  var jaFoi = {};
  function sessao(){try{var k='oferta.sessao',v=sessionStorage.getItem(k);if(v)return v;v=Date.now().toString(36)+Math.random().toString(36).slice(2,10);sessionStorage.setItem(k,v);return v;}catch(e){return Date.now().toString(36)+Math.random().toString(36).slice(2,10);}}
  window.marcarEtapa = function (etapa) {
    if (navigator.webdriver) return;      // robô/teste não conta
    if (jaFoi[etapa]) return; jaFoi[etapa] = true;
    try {
      var a = (window.atribuicaoAtual && window.atribuicaoAtual()) || {};
      fetch(PAINEL_BASE + '/eventos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ sessao: sessao(), etapa: etapa, funil: FUNIL, ad: a.criativo })
      }).catch(function(){});
    } catch (e) {}
  };
})();
</script>
```

Depois, chame `marcarEtapa('chegou')` ao abrir, `marcarEtapa('checkout')` quando
abrir o checkout, etc.

> **Opcional (espelho do Pixel / CAPI):** se o corpo do `/eventos` trouxer também
> `evento` + `eventId` (+ `params`, `attrib`, `url`, `email`, `telefone`), o
> backend reenvia esse mesmo evento pela API de Conversões do Meta/TikTok com o
> MESMO `eventId`, e a plataforma junta com o disparo do navegador (conta uma
> vez). Só use se você também dispara o pixel no navegador com o mesmo `eventId`.

---

## 4. Lead — `POST /leads` (opcional)

Se a oferta captura contato antes da compra:

- **Rota:** `POST {PAINEL_BASE}/leads`
- **Corpo:** `{ "nome": ..., "whatsapp": <só dígitos, com DDD>, "idade": <faixa>, "origem": <ex. 'oferta'> }`
- **Resposta:** `204`. Ignore erros.

---

## 5. Checkout de PIX — as rotas de pedido (Jeito A)

### 5.1 Criar pedido + PIX — `POST /orders`

- **Corpo:**

  ```json
  {
    "offer": "main",
    "bumps": ["id_do_bump"],
    "customer": { "name": "...", "email": "...", "phone": "<só dígitos, com DDD, sem o 55>", "document": "<CPF só dígitos, opcional>" },
    "funil": "oferta",
    "attrib": { ... }
  }
  ```

- **REGRA DE OURO: o preço é do servidor, não da tela.** O navegador manda
  **só IDs** (`offer`, `bumps`), nunca valor. Quem soma é o backend, pelo
  catálogo dele. Se você mandar valor, estará ignorado — e se a tela mostrar um
  número diferente do catálogo, a pessoa vê um total e recebe um QR de outro.
  **Os IDs de `offer` e `bumps` têm de existir no catálogo do backend** (peça a
  lista ao dono; ex.: `main`, `main_volta`, `upsell`, `downsell`).
- `attrib`: o retorno de `window.atribuicaoAtual()`. Opcional dos dois lados,
  mas é o que liga a venda ao anúncio — **sempre mande**.
- `customer` vai **só no pedido principal**. No upsell/downsell, mande
  `parentOrderId` no lugar; o backend copia o cliente do pedido pai.
- **CPF (`document`) é opcional** e, quando mandado, vai no **corpo**, nunca na
  URL.
- **Resposta (`data`)** é um `Order`:

  ```json
  {
    "id": "...", "offer": "main", "status": "pending",
    "amount": 4700, "amountFormatted": "R$ 47,00",
    "pix": { "code": "<copia-e-cola BR Code>", "imageUrl": null, "expiresAt": "<ISO>" },
    "paidAt": null, "parentOrderId": null,
    "customer": { "name": "...", "email": "...", "documentMasked": "***.444.777-**" },
    "items": [ ... ], "createdAt": "<ISO>"
  }
  ```

  Desenhe o QR a partir de `pix.code` (não dependa de `imageUrl`, que pode vir
  nulo). Guarde `id` para consultar o pagamento.

### 5.2 "Já pagou?" — `GET /orders/:id`

Repita enquanto o QR está na tela. Devolve o mesmo `Order`; quando
`status === "completed"`, o pagamento caiu. **Não martele**: intervalo de alguns
segundos, uma consulta por vez. **Nunca** pergunte o status direto ao gateway.

### 5.3 Renovar PIX vencido — `POST /orders/:id/renovar`

Refaz a cobrança com os mesmos itens/preço; devolve um `Order` novo, ou
`{ "jaPago": true }` se o código antigo já tinha sido pago.

### 5.4 O que entregar — `GET /orders/:id/access`

Depois de pago, devolve o `AccessBundle` com os links/conteúdos da entrega.

### 5.5 Quais ofertas existem — `GET /ofertas`

Devolve `{ addons: {upsell,downsell}, pedeCpf?, boleto? }`. Use para não mostrar
a tela de um upsell que o backend não entrega, e para saber se precisa pedir CPF.

---

## 6. Hospedagem e configuração do painel (lado do dono/VPS)

O painel (backend + tela) roda na VPS. Quem liga isto é o dono; você (IA da
oferta) só precisa **do endereço e do domínio liberado**. Para referência, o
backend precisa destas variáveis de ambiente:

| Variável | Para quê |
| --- | --- |
| `ALLOWED_ORIGINS` | **lista fechada** de domínios que podem chamar a API — **inclua o domínio da oferta aqui** |
| `ADMIN_TOKEN` | a senha do painel (`/admin`) |
| `BANCO_URL` / `BANCO_TOKEN` | o Redis (no projeto original, o Redis fica na VPS, em `/opt/banco-celestial`) |
| chave do gateway de PIX | criar a cobrança (fica no Redis, ligada pelo painel em Integrações) |
| `META_ADS_TOKEN` / `META_AD_ACCOUNT` | puxar o gasto do Meta para o ROAS |
| `TIKTOK_ADS_TOKEN` / `TIKTOK_ADVERTISER_ID` | puxar o gasto do TikTok |
| `META_PIXEL_ID` / `META_CAPI_TOKEN` | enviar `Purchase`/eventos pela CAPI |
| `TIKTOK_PIXEL_ID` / `TIKTOK_EVENTS_TOKEN` | idem TikTok |

A venda paga vira evento `Purchase` **a partir do servidor** (não do navegador),
porque quem paga PIX no app do banco quase nunca volta à tela.

---

## 7. Regras que a oferta não pode quebrar (copie para o seu checklist)

1. **Preço é do servidor.** O front manda ID, nunca valor.
2. **Nada pessoal na URL** (CPF, e-mail, telefone, atribuição) — tudo no corpo.
3. **Medição nunca derruba a venda.** `/eventos` e `/leads` sobem com erro
   engolido; a venda é o que importa.
4. **Atribuição capturada na 1ª carga e nunca apagada** por recarga/voltar.
5. **Só eventos padrão do Meta/TikTok** (PageView, ViewContent, InitiateCheckout,
   Lead, AddPaymentInfo, Purchase). Nome fora do padrão vira evento
   personalizado e estraga a otimização.
6. **O domínio da oferta tem de estar em `ALLOWED_ORIGINS`** do painel.
7. **Não revele crença/resposta de quiz** em nenhum evento — é o que já causou
   bloqueio de conta.

---

## 8. Checklist de conexão (Jeito A)

- [ ] Peguei com o dono: `PAINEL_BASE`, a lista de `offer`/`bumps` do catálogo,
      e confirmei que o domínio da oferta está em `ALLOWED_ORIGINS`.
- [ ] Colei o script de **atribuição** (seção 2) no `<head>` da oferta.
- [ ] Colei o script de **eventos** (seção 3) e chamo `marcarEtapa(...)` em cada
      etapa (`chegou` … `pix`).
- [ ] (Se houver captura de contato) mando `POST /leads`.
- [ ] O checkout chama `POST /orders` com IDs (sem valor) + `attrib`, desenha o
      QR a partir de `pix.code`, consulta `GET /orders/:id` até `completed` e
      entrega com `GET /orders/:id/access`.
- [ ] Testei do domínio real (CORS passa) e confirmei que a visita e a venda
      aparecem no `/admin`, com o anúncio certo.
```

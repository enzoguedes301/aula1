# Projeto CNH — funil + painel de rastreio

Site de funil com pagamento PIX e um painel de tracking em `/admin`.

---

## O que já está pronto e testado

| Peça | Estado |
|---|---|
| Gateway **GorillaPay** (PIX) | ✅ funcionando — cobrança criada e status consultado com sucesso |
| Camada de abstração de gateway | ✅ trocar de provedor = escrever uma classe |
| Painel `/admin` | ✅ compila e serve |
| Backend `/api/admin/*` | ✅ com autenticação por senha |
| Rastreio `/api/track/*` | ✅ grava etapas e dados do lead |
| Imagens | ✅ todas locais (nenhuma URL externa) |

## O que falta (2 passos)

1. **Criar as tabelas no Supabase** — ver "Passo 1" abaixo. *Sem isso nenhum lead é gravado.*
2. **Subir para Netlify ou Vercel** — ver "Passo 2".

---

## Passo 1 — Criar as tabelas (obrigatório)

O Supabase não deixa criar tabela pela API; tem de ser pelo painel deles.

1. Entre no Supabase → **SQL Editor** → **New query**
2. Cole o conteúdo de [`supabase-painel.sql`](supabase-painel.sql)
3. **Run**

É seguro: tudo é `IF NOT EXISTS`, não apaga nada, rodar duas vezes não quebra.

Para conferir: abra `/admin` → aba **Rastreio**. As três linhas de estado
devem ficar verdes conforme o movimento chega.

---

## Passo 2 — Subir

### Variáveis de ambiente (as mesmas nos dois provedores)

Veja [`.env.example`](.env.example) para a lista completa. As obrigatórias:

```
PAYMENT_GATEWAY=gorillapay
GATEWAY_API_KEY=sk_live_...          (GorillaPay → API Keys)
GATEWAY_WEBHOOK_SECRET=              (GorillaPay → Settings → Webhooks)
NEXT_PUBLIC_SUPABASE_URL=            (Supabase → Settings → API)
SUPABASE_SERVICE_ROLE_KEY=           (idem — é a service_role, não a anon)
ADMIN_TOKEN=                         (a senha do painel; vazia = painel some)
```

> `ADMIN_TOKEN` vazio faz as rotas `/api/admin/*` responderem 404 de propósito:
> melhor o painel não existir do que existir trancado e anunciando que existe.

### Netlify

Já está configurado em [`netlify.toml`](netlify.toml) — build, functions e
redirects. Basta:

1. Conectar o repositório
2. Cadastrar as variáveis em **Site settings → Environment variables**
3. Deploy

O build roda `npm run build:admin`, que compila o painel para `admin-dist/`.

### Vercel

Não há `vercel.json` ainda. O projeto usa **Netlify Functions**
(`functions/*.js` com `exports.handler`), que a Vercel não entende
nativamente — na Vercel seria preciso mover para `api/` e trocar a assinatura
para `(req, res)`. **O caminho mais curto é Netlify.**

### Webhook da GorillaPay

Depois do deploy, cadastre no Dashboard da GorillaPay:

```
https://SEUDOMINIO/webhook/gorillapay
```

e copie o *Webhook Secret* de lá para a variável `GATEWAY_WEBHOOK_SECRET`.

---

## O painel

Fica em `https://SEUDOMINIO/admin` — mesmo domínio do funil.
Entra com a senha de `ADMIN_TOKEN`.

A aba **Rastreio** traz a URL pronta para colar no Meta/TikTok/Google. Para o
Meta, em *Configurações do anúncio → Parâmetros de URL*:

```
utm_source=facebook&utm_campaign={{campaign.name}}&utm_medium={{adset.name}}&utm_content={{ad.id}}&utm_term={{placement}}
```

O `utm_content` é o que responde **qual anúncio vendeu**. Sem ele a venda
entra no total mas não cai em criativo nenhum.

---

## Rodar na máquina

```bash
npm install
npm run build:admin     # compila o painel
npm start               # sobe em http://localhost:3000
```

- Funil: `http://localhost:3000`
- Painel: `http://localhost:3000/admin`

---

## Estrutura

```
functions/
  pix.js                  cria a cobrança PIX
  check-payment.js        consulta o status
  admin.js                backend do painel (/api/admin/*)
  track.js                recebe o rastreio (/api/track/*)
  gateways/
    gorillapay.js         a implementação do gateway
  lib/
    gateway.js            a interface que todo gateway deve cumprir
    gateway-factory.js    escolhe o gateway pela variável PAYMENT_GATEWAY
    tracking-store.js     grava leads e etapas no Supabase
    supabase.js           cliente do banco

src/components/
  PainelAdmin.tsx         a tela do painel (React)

assets/
  index-*.js              o bundle do funil (pronto, não passa por build)
  tracking.js             captura a origem do anúncio e as etapas
  detran-logos/           as imagens, todas locais

admin.html                entrada do build do painel
supabase-painel.sql       as tabelas — RODE ISTO PRIMEIRO
```

---

## Trocar de gateway no futuro

1. Criar `functions/gateways/novogateway.js` estendendo `PaymentGateway`
   (ver `lib/gateway.js` para os 4 métodos obrigatórios)
2. Registrar em `lib/gateway-factory.js`
3. Mudar `PAYMENT_GATEWAY=novogateway` nas variáveis de ambiente

Nenhum outro arquivo precisa ser tocado.

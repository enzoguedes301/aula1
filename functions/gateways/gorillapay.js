/**
 * Gateway GorillaPay
 *
 * Integração com API GorillaPay para processamento de pagamentos PIX
 * Documentação: https://api.gorillapay.tech/v1/external
 *
 * Métodos suportados:
 * - Criar cobrança PIX (charge)
 * - Consultar status de cobrança
 * - Validar webhooks
 * - Processar webhooks de pagamento
 */

const crypto = require("crypto");
const PaymentGateway = require("../lib/gateway");

class GorillaPay extends PaymentGateway {
  constructor(config = {}) {
    super(config);
    this.name = "gorillapay";
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl || "https://api.gorillapay.tech/api/v1";
    this.timeout = 15000; // 15 segundos
  }

  /**
   * Cria uma transação PIX via GorillaPay
   *
   * Parâmetros da API GorillaPay:
   * - amount: valor em centavos
   * - payment_method: "pix"
   * - customer.name: nome do cliente
   * - customer.email: email do cliente
   * - customer.document: CPF/CNPJ (apenas números)
   * - description: descrição (opcional)
   */
  async createPixTransaction(params) {
    const {
      amount,
      amountCents,
      customerName,
      customerEmail,
      customerCpf,
      customerPhone,
      externalReference,
    } = params;

    console.log(`[${this.name}] Criando transação PIX...`);
    console.log(`[${this.name}] Valor: R$ ${amount} (${amountCents} centavos)`);
    console.log(`[${this.name}] Cliente: ${customerName} (${customerCpf})`);

    // Valida configuração
    if (!this.apiKey) {
      throw new Error("❌ GATEWAY_API_KEY não configurada para GorillaPay");
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // Payload para GorillaPay
      const payload = {
        amount: amountCents,
        payment_method: "pix",
        customer: {
          name: customerName,
          email: customerEmail,
          document: customerCpf, // Apenas números
          phone: customerPhone,
        },
        description: `Pagamento - ${externalReference}`,
      };

      console.log(`[${this.name}] Enviando requisição para GorillaPay...`);

      const response = await fetch(`${this.baseUrl}/charges`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          "Idempotency-Key": externalReference, // Evita duplicatas
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();

      if (!response.ok) {
        const errorData = this._tryParseJson(responseText);
        const errorMessage =
          errorData?.error?.message ||
          errorData?.message ||
          responseText ||
          `HTTP ${response.status}`;

        console.error(`[${this.name}] Erro HTTP ${response.status}:`, errorMessage);
        throw new Error(`GorillaPay Error: ${errorMessage}`);
      }

      const data = this._tryParseJson(responseText);

      // A API devolve o recurso em `data` (201 Created)
      const charge = data?.data || data;

      if (!charge?.id || !(charge.pix_copy_paste || charge.pix_qr_code)) {
        console.error(`[${this.name}] Resposta inválida:`, data);
        throw new Error(
          "GorillaPay retornou resposta incompleta (faltam id ou pix_copy_paste)"
        );
      }

      const chargeId = charge.id;
      // Ambos os campos trazem o BRCODE em texto (não é base64)
      const pixCode = charge.pix_copy_paste || charge.pix_qr_code;

      console.log(`[${this.name}] ✓ Cobrança criada com sucesso: ${chargeId}`);
      console.log(`[${this.name}] Status: ${charge.status}`);
      console.log(`[${this.name}] Expires at: ${charge.expires_at}`);

      // Retornar no formato padrão esperado
      return {
        success: true,
        transactionId: chargeId,
        pixCode: pixCode, // Código PIX (BRCODE)
        qrCodeBase64: null, // GorillaPay não devolve imagem; o front gera o QR do BRCODE
        status: this._mapStatus(charge.status),
        expiresAt: charge.expires_at,
        rawResponse: charge,
      };
    } catch (err) {
      console.error(`[${this.name}] Erro ao criar transação:`, err.message);
      throw err;
    }
  }

  /**
   * Consulta o status de uma transação
   *
   * Statuses do GorillaPay:
   * - pending: Aguardando pagamento
   * - approved: Pagamento confirmado
   * - failed: Pagamento falhou
   * - refunded: Reembolsado
   * - cancelled: Cancelado
   */
  async checkTransactionStatus(transactionId) {
    console.log(`[${this.name}] Consultando status: ${transactionId}`);

    if (!this.apiKey) {
      throw new Error("❌ GATEWAY_API_KEY não configurada para GorillaPay");
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(
        `${this.baseUrl}/charges/${transactionId}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      const responseText = await response.text();

      if (!response.ok) {
        const errorData = this._tryParseJson(responseText);
        const errorMessage = errorData?.error?.message || `HTTP ${response.status}`;
        console.error(`[${this.name}] Erro ao consultar status:`, errorMessage);
        throw new Error(`GorillaPay Error: ${errorMessage}`);
      }

      const data = this._tryParseJson(responseText);

      const charge = data?.data || data;

      if (!charge?.status) {
        throw new Error("GorillaPay retornou resposta inválida");
      }

      // Mapear status do GorillaPay para formato padrão
      const status = this._mapStatus(charge.status);
      const paid = status === "paid";

      console.log(
        `[${this.name}] Status obtido: ${charge.status} → ${status}`
      );
      console.log(`[${this.name}] Paid: ${paid}`);

      return {
        status, // paid, pending, rejected, refunded
        paid,
        rawResponse: charge,
      };
    } catch (err) {
      console.error(`[${this.name}] Erro ao consultar status:`, err.message);
      throw err;
    }
  }

  /**
   * Valida a autenticidade de um webhook do GorillaPay
   *
   * GorillaPay envia:
   * - Header X-Webhook-Signature: HMAC-SHA256 do corpo bruto com webhook secret
   */
  validateWebhook(event) {
    const signature =
      event.headers["x-webhook-signature"] ||
      event.headers["X-Webhook-Signature"];
    const body = event.body || ""; // Corpo bruto, não parseado

    if (!signature || !this.webhookSecret) {
      console.warn(
        `[${this.name}] Webhook inválido: falta assinatura ou secret`
      );
      return false;
    }

    try {
      // Validar HMAC-SHA256
      const expectedSignature = crypto
        .createHmac("sha256", this.webhookSecret)
        .update(body, "utf8")
        .digest("hex");

      const isValid = signature === expectedSignature;

      console.log(
        `[${this.name}] Validação de webhook: ${isValid ? "✓" : "✗"}`
      );

      if (!isValid) {
        console.warn(
          `[${this.name}] Assinatura inválida. Esperado: ${expectedSignature.substring(0, 16)}... Recebido: ${signature.substring(0, 16)}...`
        );
      }

      return isValid;
    } catch (err) {
      console.error(`[${this.name}] Erro ao validar webhook:`, err.message);
      return false;
    }
  }

  /**
   * Processa um webhook de pagamento do GorillaPay
   *
   * Eventos suportados:
   * - charge.created
   * - charge.approved
   * - charge.failed
   * - charge.refunded
   * - charge.expired
   * - charge.chargeback
   */
  async handleWebhook(event) {
    const body = this._tryParseJson(event.body || "{}");

    console.log(`[${this.name}] Processando webhook: ${body.event}`);

    const chargeId = body.data?.id || body.id;
    const chargeStatus = body.data?.status || "unknown";
    const status = this._mapStatus(chargeStatus);

    if (!chargeId) {
      throw new Error("Webhook não contém charge ID");
    }

    console.log(
      `[${this.name}] Webhook processado: ${chargeId} → ${status}`
    );
    console.log(`[${this.name}] Evento: ${body.event}`);

    return {
      success: true,
      transactionId: chargeId,
      status,
      event: body.event,
      rawData: body.data,
    };
  }

  // ========================
  // Métodos Auxiliares
  // ========================

  /**
   * Mapeia status do GorillaPay para formato padrão
   *
   * GorillaPay: pending, approved, failed, refunded, cancelled, expired, chargeback
   * Padrão: pending, paid, rejected, refunded
   */
  _mapStatus(rawStatus) {
    const status = (rawStatus || "").toLowerCase();

    if (status === "approved") return "paid";
    if (status === "pending") return "pending";
    if (status === "failed" || status === "chargeback") return "rejected";
    if (status === "refunded") return "refunded";
    if (status === "cancelled" || status === "expired") return "rejected";

    // Padrão seguro
    return "pending";
  }

  /**
   * Parse seguro de JSON
   */
  _tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

module.exports = GorillaPay;

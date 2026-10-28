/**
 * Abstração de Gateway de Pagamentos
 *
 * Interface padrão para integração com gateways de pagamento
 * Permite trocar entre diferentes provedores facilmente
 */

class PaymentGateway {
  constructor(config = {}) {
    this.config = config;
    this.name = "generic";
  }

  /**
   * Cria uma transação PIX
   * @param {Object} params - Parâmetros da transação
   * @returns {Promise<{success: boolean, transactionId: string, pixCode: string, ...}>}
   */
  async createPixTransaction(params) {
    throw new Error("Método createPixTransaction() não implementado");
  }

  /**
   * Consulta o status de uma transação
   * @param {string} transactionId - ID da transação
   * @returns {Promise<{status: string, paid: boolean, ...}>}
   */
  async checkTransactionStatus(transactionId) {
    throw new Error("Método checkTransactionStatus() não implementado");
  }

  /**
   * Valida webhook do gateway
   * @param {Object} event - Evento do webhook
   * @returns {boolean}
   */
  validateWebhook(event) {
    throw new Error("Método validateWebhook() não implementado");
  }

  /**
   * Processa webhook de pagamento
   * @param {Object} event - Evento do webhook
   * @returns {Promise<{success: boolean, transactionId: string, status: string}>}
   */
  async handleWebhook(event) {
    throw new Error("Método handleWebhook() não implementado");
  }
}

module.exports = PaymentGateway;

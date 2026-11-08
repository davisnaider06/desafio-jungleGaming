/**
 * Taxonomia de falhas de negócio. Todo `REJECTED` carrega um destes códigos.
 * A coluna "ação" diz ao provedor o que fazer: RETRY (reenviar mais tarde),
 * FIX (corrigir o payload) ou GIVE_UP (desistir, o resultado é definitivo).
 */
export enum FailureCode {
  /** BET sem saldo. Ação: GIVE_UP (ou reenviar com nova transação depois de depositar). */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK/REFUND de crédito que deixaria o saldo negativo. Ação: GIVE_UP; é auditável e diferente de INSUFFICIENT_FUNDS. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Moeda da operação difere da wallet (ou da referência). Ação: FIX. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** walletId não existe. Ação: FIX. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** playerId não é o dono da wallet. Ação: FIX. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referência nunca chegou dentro do prazo. Ação: GIVE_UP (ou reenviar a referência e a reversão). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas foi REJECTED/FAILED, então não há o que reverter. Ação: GIVE_UP. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência é de outro player, wallet ou rodada. Ação: FIX. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** A referência já foi revertida. Ação: GIVE_UP. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor da reversão difere do original (parcial não é suportado). Ação: FIX. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Tipo da referência não é aceito (ex.: REFUND de WIN). Ação: FIX. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Mesma Idempotency-Key com payload diferente. Ação: FIX (nova chave ou o mesmo payload). */
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  /** Payload malformado. Ação: FIX. */
  InvalidPayload = 'INVALID_PAYLOAD',
}

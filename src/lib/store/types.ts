export type ConnectionStatus = "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";

export interface OAuthStateRecord {
  id: string;
  stateHash: string;
  bindingHash: string;
  codeVerifierEnc: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface ConnectionRecord {
  id: string;
  meliUserId: string;
  nickname: string | null;
  siteId: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
  status: ConnectionStatus;
  tokenVersion: number;
  refreshLockId: string | null;
  refreshLockUntil: Date | null;
  lastConnectedAt: Date | null;
  lastRefreshedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOAuthState {
  stateHash: string;
  bindingHash: string;
  codeVerifierEnc: string | null;
  expiresAt: Date;
}

export interface AuthorizedConnectionInput {
  meliUserId: string;
  nickname: string | null;
  siteId: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: Date;
  scope: string | null;
  connectedAt: Date;
}

export interface RefreshedTokensInput {
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: Date;
  scope: string | null;
  refreshedAt: Date;
}

/**
 * Persistência do integrador. Todas as operações que exigem atomicidade
 * (consumo de state, lease de renovação, rotação do refresh token) são
 * resolvidas aqui com uma única instrução condicional no banco.
 */
export interface Store {
  createOAuthState(input: NewOAuthState): Promise<void>;
  /** Marca o state como consumido, somente se existir, não expirou, não foi usado e pertence ao binding. */
  consumeOAuthState(stateHash: string, bindingHash: string, now: Date): Promise<OAuthStateRecord | null>;
  deleteExpiredOAuthStates(now: Date): Promise<number>;

  getCurrentConnection(): Promise<ConnectionRecord | null>;
  getConnectionById(id: string): Promise<ConnectionRecord | null>;
  /** Grava a conta autorizada e desativa qualquer outra conta (MVP: uma conta vendedora). */
  saveAuthorizedConnection(input: AuthorizedConnectionInput): Promise<ConnectionRecord>;

  /** Adquire o lease de renovação se não houver outro válido. Retorna true se adquirido. */
  tryAcquireRefreshLock(id: string, lockId: string, lockUntil: Date, now: Date): Promise<boolean>;
  /** Persiste os novos tokens somente se o lease ainda for deste lockId (fencing). */
  completeRefresh(id: string, lockId: string, input: RefreshedTokensInput): Promise<boolean>;
  releaseRefreshLock(id: string, lockId: string, errorCode: string | null): Promise<void>;
  /** Token revogado/inválido: apaga tokens e exige nova autorização. */
  markReauthRequired(id: string, errorCode: string): Promise<void>;
  /** Desconexão: apaga tokens localmente e invalida qualquer lease em andamento. */
  clearTokens(id: string): Promise<void>;

  /** Retorna até quando o login está bloqueado para a chave (hash do IP), se estiver. */
  getLoginLockedUntil(keyHash: string, now: Date): Promise<Date | null>;
  /** Registra falha; após `maxFailures` bloqueia por `lockMs` e zera o contador. */
  recordLoginFailure(keyHash: string, now: Date, maxFailures: number, lockMs: number): Promise<void>;
  clearLoginFailures(keyHash: string): Promise<void>;
}

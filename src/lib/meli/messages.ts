/** Texto que o administrador precisa digitar para confirmar a desconexão. */
export const DISCONNECT_CONFIRMATION = "DESCONECTAR";

/** Mensagens exibidas no painel. Apenas códigos desta lista são aceitos via query string. */
export const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Conta do Mercado Livre conectada com sucesso.",
  disconnected: "Conta desconectada.",
  unauthorized: "Sua sessão de administrador expirou antes do retorno do Mercado Livre. Entre novamente e reconecte.",
  forbidden: "Requisição bloqueada: o fluxo deve ser iniciado a partir deste painel.",
  missing_state: "Retorno do Mercado Livre sem o parâmetro state. Inicie a conexão novamente.",
  invalid_state: "Solicitação de autorização inválida, expirada ou já utilizada. Inicie a conexão novamente.",
  access_denied: "A autorização foi negada no Mercado Livre.",
  invalid_operator_user_id: "O login foi feito com um usuário operador/colaborador. Use a conta administradora do vendedor.",
  authorization_error: "O Mercado Livre retornou um erro na autorização.",
  missing_code: "O Mercado Livre não retornou o código de autorização.",
  token_exchange_failed: "Não foi possível obter os tokens no Mercado Livre. Verifique Client ID, Secret, Redirect URI e PKCE.",
  account_verification_failed: "Tokens obtidos, mas a conta não pôde ser confirmada em /users/me. Nada foi salvo.",
  config_error: "Configuração do servidor incompleta. Verifique as variáveis de ambiente.",
  internal_error: "Erro interno ao processar a conexão.",
};

export function messageFor(code: string | undefined | null): string | null {
  return code && Object.hasOwn(CALLBACK_MESSAGES, code) ? CALLBACK_MESSAGES[code] : null;
}

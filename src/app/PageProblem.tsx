/** Aviso padrão quando a página não consegue carregar dados (configuração ou banco). */
export function PageProblem({ kind, detail }: { kind: "config" | "database"; detail?: string }) {
  return (
    <div className="alert error" role="alert">
      {kind === "config"
        ? "Configuração do servidor incompleta. Verifique as variáveis de ambiente (veja .env.example)."
        : "Não foi possível carregar os dados. Verifique a conexão com o banco de dados e se as migrations foram aplicadas."}
      {detail ? <div className="hint">{detail}</div> : null}
    </div>
  );
}

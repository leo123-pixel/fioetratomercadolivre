import type { Metadata } from "next";
import s from "@/components/institucional/site.module.css";
import { company, contact } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";

export const metadata: Metadata = {
  title: "Política de Privacidade",
  description: `Como o site institucional da ${company.name} trata informações de visitantes, conforme a LGPD.`,
  alternates: { canonical: "/politica-de-privacidade" },
};

// Data da versão deste texto. Atualize ao revisar a política.
const UPDATED_AT = "9 de novembro de 2026";

export default function PrivacyPolicyPage() {
  const controller = company.legalName ? `${company.legalName}${company.cnpj ? `, CNPJ ${company.cnpj}` : ""}` : company.name;
  return (
    <article className={s.legal}>
      <div className={s.legalInner}>
        <p className={s.eyebrow}>Institucional</p>
        <h1 className={s.legalTitle}>Política de Privacidade</h1>
        <p className={s.legalUpdated}>Última atualização: {UPDATED_AT}</p>

        <p>
          Esta política explica como o site institucional da {controller} trata informações de quem o visita, em
          conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 — LGPD).
        </p>

        <h2>1. Informações coletadas neste site</h2>
        <p>
          O site institucional tem caráter informativo. Ele não possui formulários de cadastro, não exige login de
          visitantes e não utiliza cookies de publicidade ou de rastreamento.
        </p>
        <p>
          Como em qualquer site, a infraestrutura de hospedagem registra automaticamente dados técnicos de acesso
          (como endereço IP, data e hora, navegador e página solicitada) para fins de segurança, prevenção de abusos
          e funcionamento do serviço.
        </p>

        <h2>2. Área administrativa</h2>
        <p>
          A área administrativa é de uso exclusivo da equipe autorizada. Ao entrar nela, é criado um cookie de sessão
          estritamente necessário para manter o acesso autenticado. Esse cookie não é usado para outras finalidades.
        </p>

        <h2>3. Links para outros serviços</h2>
        <p>Este site contém links para serviços operados separadamente, como:</p>
        <ul>
          <li>o portal de pedidos B2B da {company.name};</li>
          <li>redes sociais e aplicativos de mensagem (por exemplo, Instagram e WhatsApp).</li>
        </ul>
        <p>
          Ao acessá-los, o tratamento de dados passa a seguir as políticas e os termos de cada serviço. Recomendamos a
          leitura dessas políticas.
        </p>

        <h2>4. Compartilhamento</h2>
        <p>
          Não comercializamos dados pessoais. Os registros técnicos podem ser tratados por provedores de
          infraestrutura contratados, exclusivamente para a operação do site, ou disponibilizados a autoridades quando
          houver obrigação legal.
        </p>

        <h2>5. Direitos do titular</h2>
        <p>
          Você pode solicitar confirmação de tratamento, acesso, correção, anonimização, portabilidade ou eliminação de
          dados pessoais, bem como informações sobre compartilhamento, nos termos do art. 18 da LGPD.
        </p>

        <h2>6. Contato</h2>
        <p>
          Para dúvidas ou solicitações sobre esta política, utilize os canais oficiais informados na seção{" "}
          <a href={`/#${SECTION_IDS.contato}`}>Contato</a>
          {contact.email ? (
            <>
              {" "}ou escreva para <a href={`mailto:${contact.email}`}>{contact.email}</a>
            </>
          ) : null}
          .
        </p>

        <h2>7. Atualizações</h2>
        <p>Esta política pode ser atualizada periodicamente. A data da versão vigente aparece no início da página.</p>
      </div>
    </article>
  );
}

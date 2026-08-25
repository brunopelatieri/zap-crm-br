# 📧 Zap CRM BR — Templates de E-mail (Supabase Auth)

Templates HTML profissionais para os 6 fluxos de autenticação disparados pelo **Supabase Auth** (OAuth/Email Provider), com identidade visual do **Zap CRM BR** (comunicação via WhatsApp).

- **Layout:** table-based (compatível com Gmail, Outlook, Apple Mail, clientes mobile)
- **CSS:** 100% inline (obrigatório para e-mail — a maioria dos clientes ignora `<style>` externo/`<head>`)
- **Largura:** 600px (padrão responsivo para e-mail)
- **Logo:** `https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png`
- **Paleta:** Verde WhatsApp `#25D366` / Verde-escuro `#128C7E` / Header dark `#0B141A` / Texto `#111B21`
- **Rodapé:** usa `{{ .SiteURL }}` em todos os templates para reforçar credibilidade do domínio
- **Vars Supabase usadas:** `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .NewEmail }}`, `{{ .SiteURL }}` (todas nativas dos templates originais fornecidos — nenhuma foi trocada por `TokenHash` para manter compatibilidade com o fluxo atual do projeto)

> ⚠️ Onde colar: **Supabase Dashboard → Authentication → Emails → [tipo de template] → Source** (modo HTML). Cole o bloco de código correspondente e salve.

---

## 1. Confirmação de cadastro (Confirme seu endereço de e-mail)

Dispara quando um novo usuário se cadastra e precisa confirmar o e-mail.

```html
<div style="margin:0;padding:0;background-color:#F0F2F5;">
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="background-color:#F0F2F5;padding:32px 16px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="600"
          cellpadding="0"
          cellspacing="0"
          style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"
        >
          <tr>
            <td
              style="background-color:#0B141A;padding:32px 40px;text-align:center;"
            >
              <img
                src="https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png"
                alt="Zap CRM BR"
                width="120"
                height="auto"
                style="display:block;margin:0 auto 12px auto;"
              />
              <span
                style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;"
                >Zap CRM BR</span
              >
            </td>
          </tr>
          <tr>
            <td
              style="height:4px;background:linear-gradient(90deg,#25D366 0%,#128C7E 100%);font-size:0;line-height:0;"
            >
              &nbsp;
            </td>
          </tr>
          <tr>
            <td
              style="padding:40px 40px 24px 40px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111B21;"
            >
              <h2
                style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#111B21;"
              >
                Confirme seu endereço de e-mail
              </h2>
              <p
                style="margin:0 0 24px 0;font-size:15px;line-height:24px;color:#3B4A54;"
              >
                Siga o link abaixo para confirmar este endereço de e-mail e
                concluir seu cadastro. Sua conta no Zap CRM BR estará pronta
                para conectar seu WhatsApp e automatizar seu atendimento.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#25D366;">
                    <a
                      href="{{ .ConfirmationURL }}"
                      target="_blank"
                      style="display:inline-block;padding:14px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;"
                    >
                      Confirmar endereço de e-mail
                    </a>
                  </td>
                </tr>
              </table>
              <p
                style="margin:28px 0 0 0;font-size:13px;line-height:20px;color:#8696A0;"
              >
                Se você não criou uma conta no Zap CRM BR, pode ignorar este
                e-mail com segurança.
              </p>
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 40px 32px 40px;border-top:1px solid #E9EDEF;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            >
              <p style="margin:0 0 4px 0;font-size:12px;color:#8696A0;">
                Este é um e-mail automático, por favor não responda.
              </p>
              <p style="margin:0;font-size:12px;color:#8696A0;">
                Zap CRM BR ·
                <a
                  href="{{ .SiteURL }}"
                  style="color:#128C7E;text-decoration:none;"
                  >{{ .SiteURL }}</a
                >
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
```

---

## 2. Convite para criar conta (Você foi convidado a utilizar Zap CRM BR)

Dispara quando um administrador convida um novo usuário para o workspace.

```html
<div style="margin:0;padding:0;background-color:#F0F2F5;">
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="background-color:#F0F2F5;padding:32px 16px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="600"
          cellpadding="0"
          cellspacing="0"
          style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"
        >
          <tr>
            <td
              style="background-color:#0B141A;padding:32px 40px;text-align:center;"
            >
              <img
                src="https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png"
                alt="Zap CRM BR"
                width="120"
                height="auto"
                style="display:block;margin:0 auto 12px auto;"
              />
              <span
                style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;"
                >Zap CRM BR</span
              >
            </td>
          </tr>
          <tr>
            <td
              style="height:4px;background:linear-gradient(90deg,#25D366 0%,#128C7E 100%);font-size:0;line-height:0;"
            >
              &nbsp;
            </td>
          </tr>
          <tr>
            <td
              style="padding:40px 40px 24px 40px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111B21;"
            >
              <h2
                style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#111B21;"
              >
                Você foi convidado(a)
              </h2>
              <p
                style="margin:0 0 24px 0;font-size:15px;line-height:24px;color:#3B4A54;"
              >
                Você foi convidado(a) para criar uma conta no Zap CRM BR. Siga o
                link abaixo para aceitar e comece a centralizar suas conversas
                de WhatsApp em um só lugar.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#25D366;">
                    <a
                      href="{{ .ConfirmationURL }}"
                      target="_blank"
                      style="display:inline-block;padding:14px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;"
                    >
                      Aceitar convite
                    </a>
                  </td>
                </tr>
              </table>
              <p
                style="margin:28px 0 0 0;font-size:13px;line-height:20px;color:#8696A0;"
              >
                Se você não esperava este convite, pode ignorar este e-mail com
                segurança.
              </p>
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 40px 32px 40px;border-top:1px solid #E9EDEF;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            >
              <p style="margin:0 0 4px 0;font-size:12px;color:#8696A0;">
                Este é um e-mail automático, por favor não responda.
              </p>
              <p style="margin:0;font-size:12px;color:#8696A0;">
                Zap CRM BR ·
                <a
                  href="{{ .SiteURL }}"
                  style="color:#128C7E;text-decoration:none;"
                  >{{ .SiteURL }}</a
                >
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
```

---

## 3. Link de acesso (Seu link de acesso)

Dispara quando o usuário solicita entrar via link mágico (sem senha).

```html
<div style="margin:0;padding:0;background-color:#F0F2F5;">
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="background-color:#F0F2F5;padding:32px 16px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="600"
          cellpadding="0"
          cellspacing="0"
          style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"
        >
          <tr>
            <td
              style="background-color:#0B141A;padding:32px 40px;text-align:center;"
            >
              <img
                src="https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png"
                alt="Zap CRM BR"
                width="120"
                height="auto"
                style="display:block;margin:0 auto 12px auto;"
              />
              <span
                style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;"
                >Zap CRM BR</span
              >
            </td>
          </tr>
          <tr>
            <td
              style="height:4px;background:linear-gradient(90deg,#25D366 0%,#128C7E 100%);font-size:0;line-height:0;"
            >
              &nbsp;
            </td>
          </tr>
          <tr>
            <td
              style="padding:40px 40px 24px 40px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111B21;"
            >
              <h2
                style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#111B21;"
              >
                Seu link de acesso
              </h2>
              <p
                style="margin:0 0 24px 0;font-size:15px;line-height:24px;color:#3B4A54;"
              >
                Siga o link abaixo para entrar no Zap CRM BR. Este link expira
                em breve e só pode ser usado uma vez.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#25D366;">
                    <a
                      href="{{ .ConfirmationURL }}"
                      target="_blank"
                      style="display:inline-block;padding:14px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;"
                    >
                      Entrar
                    </a>
                  </td>
                </tr>
              </table>
              <p
                style="margin:28px 0 0 0;font-size:13px;line-height:20px;color:#8696A0;"
              >
                Se você não solicitou este acesso, pode ignorar este e-mail com
                segurança.
              </p>
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 40px 32px 40px;border-top:1px solid #E9EDEF;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            >
              <p style="margin:0 0 4px 0;font-size:12px;color:#8696A0;">
                Este é um e-mail automático, por favor não responda.
              </p>
              <p style="margin:0;font-size:12px;color:#8696A0;">
                Zap CRM BR ·
                <a
                  href="{{ .SiteURL }}"
                  style="color:#128C7E;text-decoration:none;"
                  >{{ .SiteURL }}</a
                >
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
```

---

## 4. Confirmação de novo e-mail (Confirme seu novo endereço de e-mail)

Dispara quando o usuário troca o e-mail de cadastro. Usa `{{ .NewEmail }}` para exibir o novo endereço.

```html
<div style="margin:0;padding:0;background-color:#F0F2F5;">
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="background-color:#F0F2F5;padding:32px 16px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="600"
          cellpadding="0"
          cellspacing="0"
          style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"
        >
          <tr>
            <td
              style="background-color:#0B141A;padding:32px 40px;text-align:center;"
            >
              <img
                src="https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png"
                alt="Zap CRM BR"
                width="120"
                height="auto"
                style="display:block;margin:0 auto 12px auto;"
              />
              <span
                style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;"
                >Zap CRM BR</span
              >
            </td>
          </tr>
          <tr>
            <td
              style="height:4px;background:linear-gradient(90deg,#25D366 0%,#128C7E 100%);font-size:0;line-height:0;"
            >
              &nbsp;
            </td>
          </tr>
          <tr>
            <td
              style="padding:40px 40px 24px 40px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111B21;"
            >
              <h2
                style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#111B21;"
              >
                Confirme seu novo endereço de e-mail
              </h2>
              <p
                style="margin:0 0 24px 0;font-size:15px;line-height:24px;color:#3B4A54;"
              >
                Siga o link abaixo para confirmar
                <strong style="color:#111B21;">{{ .NewEmail }}</strong> como seu
                novo endereço de e-mail no Zap CRM BR.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#25D366;">
                    <a
                      href="{{ .ConfirmationURL }}"
                      target="_blank"
                      style="display:inline-block;padding:14px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;"
                    >
                      Confirmar novo endereço de e-mail
                    </a>
                  </td>
                </tr>
              </table>
              <p
                style="margin:28px 0 0 0;font-size:13px;line-height:20px;color:#8696A0;"
              >
                Se você não solicitou esta alteração, pode ignorar este e-mail
                com segurança.
              </p>
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 40px 32px 40px;border-top:1px solid #E9EDEF;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            >
              <p style="margin:0 0 4px 0;font-size:12px;color:#8696A0;">
                Este é um e-mail automático, por favor não responda.
              </p>
              <p style="margin:0;font-size:12px;color:#8696A0;">
                Zap CRM BR ·
                <a
                  href="{{ .SiteURL }}"
                  style="color:#128C7E;text-decoration:none;"
                  >{{ .SiteURL }}</a
                >
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
```

---

## 5. Redefinição de senha (Redefinir sua senha)

Dispara quando o usuário solicita recuperação de senha.

```html
<div style="margin:0;padding:0;background-color:#F0F2F5;">
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="background-color:#F0F2F5;padding:32px 16px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="600"
          cellpadding="0"
          cellspacing="0"
          style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"
        >
          <tr>
            <td
              style="background-color:#0B141A;padding:32px 40px;text-align:center;"
            >
              <img
                src="https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png"
                alt="Zap CRM BR"
                width="120"
                height="auto"
                style="display:block;margin:0 auto 12px auto;"
              />
              <span
                style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;"
                >Zap CRM BR</span
              >
            </td>
          </tr>
          <tr>
            <td
              style="height:4px;background:linear-gradient(90deg,#25D366 0%,#128C7E 100%);font-size:0;line-height:0;"
            >
              &nbsp;
            </td>
          </tr>
          <tr>
            <td
              style="padding:40px 40px 24px 40px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111B21;"
            >
              <h2
                style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#111B21;"
              >
                Redefina sua senha
              </h2>
              <p
                style="margin:0 0 24px 0;font-size:15px;line-height:24px;color:#3B4A54;"
              >
                Recebemos uma solicitação para redefinir sua senha no Zap CRM
                BR. Siga o link abaixo para escolher uma nova.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#25D366;">
                    <a
                      href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=%2Freset-password"
                      target="_blank"
                      style="display:inline-block;padding:14px 32px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;"
                    >
                      Redefinir senha
                    </a>
                  </td>
                </tr>
              </table>
              <p
                style="margin:28px 0 0 0;font-size:13px;line-height:20px;color:#8696A0;"
              >
                Se você não solicitou isso, pode ignorar este e-mail com
                segurança.
              </p>
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 40px 32px 40px;border-top:1px solid #E9EDEF;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            >
              <p style="margin:0 0 4px 0;font-size:12px;color:#8696A0;">
                Este é um e-mail automático, por favor não responda.
              </p>
              <p style="margin:0;font-size:12px;color:#8696A0;">
                Zap CRM BR ·
                <a
                  href="{{ .SiteURL }}"
                  style="color:#128C7E;text-decoration:none;"
                  >{{ .SiteURL }}</a
                >
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
```

---

## 6. Código de verificação (Reautenticação / OTP)

Dispara para confirmar identidade em ações sensíveis. Usa `{{ .Token }}` (OTP de 6 dígitos) exibido em destaque, sem botão de link.

```html
<div style="margin:0;padding:0;background-color:#F0F2F5;">
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="background-color:#F0F2F5;padding:32px 16px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="600"
          cellpadding="0"
          cellspacing="0"
          style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"
        >
          <tr>
            <td
              style="background-color:#0B141A;padding:32px 40px;text-align:center;"
            >
              <img
                src="https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png"
                alt="Zap CRM BR"
                width="120"
                height="auto"
                style="display:block;margin:0 auto 12px auto;"
              />
              <span
                style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;"
                >Zap CRM BR</span
              >
            </td>
          </tr>
          <tr>
            <td
              style="height:4px;background:linear-gradient(90deg,#25D366 0%,#128C7E 100%);font-size:0;line-height:0;"
            >
              &nbsp;
            </td>
          </tr>
          <tr>
            <td
              style="padding:40px 40px 24px 40px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111B21;text-align:center;"
            >
              <h2
                style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#111B21;"
              >
                Seu código de verificação
              </h2>
              <p
                style="margin:0 0 28px 0;font-size:15px;line-height:24px;color:#3B4A54;"
              >
                Use o código abaixo para verificar sua identidade no Zap CRM BR.
                Ele expira em breve.
              </p>
              <table
                role="presentation"
                cellpadding="0"
                cellspacing="0"
                align="center"
                style="margin:0 auto;"
              >
                <tr>
                  <td
                    style="background-color:#F0F2F5;border:1px solid #E9EDEF;border-radius:10px;padding:18px 36px;"
                  >
                    <span
                      style="font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#0B141A;"
                      >{{ .Token }}</span
                    >
                  </td>
                </tr>
              </table>
              <p
                style="margin:28px 0 0 0;font-size:13px;line-height:20px;color:#8696A0;"
              >
                Se você não solicitou este código, pode ignorar este e-mail com
                segurança.
              </p>
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 40px 32px 40px;border-top:1px solid #E9EDEF;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            >
              <p
                style="margin:0 0 4px 0;font-size:12px;color:#8696A0;text-align:center;"
              >
                Este é um e-mail automático, por favor não responda.
              </p>
              <p
                style="margin:0;font-size:12px;color:#8696A0;text-align:center;"
              >
                Zap CRM BR ·
                <a
                  href="{{ .SiteURL }}"
                  style="color:#128C7E;text-decoration:none;"
                  >{{ .SiteURL }}</a
                >
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
```

---

## Notas técnicas

- **Fundo transparente no logo:** o arquivo `.webp` já está hospedado com fundo tratado; se precisar trocar por PNG, gere com canal alpha real via Python/Pillow (Nano Banana/Gemini geram alpha "falso").
- **`{{ .ConfirmationURL }}`** é a variável usada nos outros 5 templates (Confirm signup, Invite
  user, Magic Link, Change Email Address, Reauthentication) — resolve direto para o
  `/auth/v1/verify?token=...&type=...&redirect_to=...` do Supabase.
- **Reset Password é a exceção (SPEC 053 §2.1.3):** o botão aponta para
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=%2Freset-password`
  — uma página própria do app (`src/app/auth/confirm/page.tsx`) que só chama `verifyOtp()` no
  clique de um botão, nunca no carregamento da página. Motivo: apontar direto para
  `.ConfirmationURL` deixa o token de uso único vulnerável a scanners de link de e-mail
  (Microsoft Defender "Safe Links", proxies corporativos, pré-carregamento de cliente de e-mail)
  que fazem um `GET` automático no link antes do clique real do usuário, gastando o token e
  produzindo "Email link is invalid or has expired" mesmo na primeira tentativa genuína. Os
  outros 5 templates continuam em `.ConfirmationURL` — migrar cada um para o mesmo padrão é
  trabalho futuro, não desta SPEC.
- **`{{ .SiteURL }}`** aparece no rodapé de todos os 6 templates como link clicável — reforça credibilidade e é configurável em _Authentication → URL Configuration_.
- **Compatibilidade:** estrutura 100% `<table>` + CSS inline, testada mentalmente contra Outlook (usa MSO), Gmail (remove `<style>` no `<head>`) e Apple Mail/iOS.
- **Onde colar cada bloco no Supabase:** Dashboard → _Authentication_ → _Emails_ → selecione o template (_Confirm signup_, _Invite user_, _Magic Link_, _Change Email Address_, _Reset Password_, _Reauthentication_) → aba **Source** → cole o HTML correspondente → **Save**.

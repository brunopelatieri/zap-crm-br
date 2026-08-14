## 👽 11/08/2026

você é um frontend sênior com especialidade em HTML para templates de email. Use suas especialidades e crie um template de confirmações de email que é disparado do supabase pra validar o OAuth a partir do envio de email do supabase.

Email de confirmação template hoje:
"<h2>Confirm your email address</h2>
<p>Follow the link below to confirm this email address and finish signing up.</p>
<p><a href="{{ .ConfirmationURL }}">Confirm email address</a></p>"

Email de convite template hoje:
"<h2>You've been invited</h2>
<p>You've been invited to create an account. Follow the link below to accept.</p>
<p><a href="{{ .ConfirmationURL }}">Accept invitation</a></p>"

Email de magic link otp - sign-in link:
"<h2>Your sign-in link</h2>
<p>Follow the link below to sign in. This link expires shortly and can only be used once.</p>
<p><a href="{{ .ConfirmationURL }}">Sign in</a></p>"

Email template hoje de confirmação de email:
"<h2>Confirm your new email address</h2>
<p>Follow the link below to confirm {{ .NewEmail }} as your new email address.</p>
<p><a href="{{ .ConfirmationURL }}">Confirm new email address</a></p>
<p>If you didn't request this change, you can safely ignore this email.</p>"

Email template hoje de reset password:
"<h2>Reset your password</h2>
<p>We received a request to reset your password. Follow the link below to choose a new one.</p>
<p><a href="{{ .ConfirmationURL }}">Reset password</a></p>
<p>If you didn't request this, you can safely ignore this email.</p>"

Email reauthentication template hoje:
"<h2>Your verification code</h2>

<p>Use the code below to verify your identity. It expires shortly.</p>

<p>{{ .Token }}</p>"

Importante:
Se precisar elementos de imagem, utilize a url da logo: https://bio.brunogoulart.com.br/001_repo_external/zap-crm-br_bruno_pelatieri_goulart-bizu-hub.png
Reformate os email para um template profissional que remeta a tecnologia e comunicação através de whatsapp do CRM Zap CRM BR.
Utilize a var "{{ .SiteURL }}" para criar um rodapé com a url do sistema (para dar mais credibilidade).
Var do supabase que pode ser utilizada: {{ .Data }}, {{ .Email }}, {{ .Token }},...pesquise sobre as var antes de usa-las em: https://supabase.com/docs/guides/auth/auth-email-templates#terminology
Obrigatoriamente, utilize as do "template hoje" acima que será modificados.
Crie um arquivo .md com o código HTML de cada tipo de email que são enviados pelo OAuth do supabase. Coloque em um bloco de trecho de código para facilitar o copiar e colar "```".

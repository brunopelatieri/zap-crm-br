# Servidor MCP do ZAP CRM BR

Um servidor [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) para o **[ZAP CRM BR](../README.md)** — o CRM para WhatsApp
auto-hospedável e em português do Brasil. Ele permite que assistentes
de IA compatíveis com MCP (Claude Desktop, Cursor, VS Code com GitHub
Copilot e outros) operem o seu CRM em linguagem natural:

> "Quantas conversas ainda estão abertas?"
> "Encontre o contato do número +55 11 91234-5678 e mostre as últimas mensagens."
> "Rascunhe e envie um template de atualização de pedido para a Jane."

É uma camada fina sobre a API REST pública do CRM
([`/api/v1`](../docs/public-api.md)). Toda autenticação, escopo de
permissões e limite de requisições são aplicados pela sua instância —
este servidor apenas expõe essa API como ferramentas (*tools*) MCP.

> 📖 Veja também a visão geral em [docs/mcp.md](../docs/mcp.md) e o
> [README principal do repositório](../README.md) para instalar e
> hospedar o CRM em si.

---

## Por que isso é um diferencial

Poucos CRMs de WhatsApp open source — e praticamente nenhum
auto-hospedável e em português — oferecem suporte **nativo** a MCP.
O ZAP CRM BR vem com esse servidor pronto no repositório: sem plugin
pago, sem SaaS de integração no meio, sem esperar por uma API
"parceira". Você aponta o seu assistente de IA preferido para a sua
própria instância e, em minutos, está consultando conversas, contatos
e funil — ou até enviando mensagens — direto do chat da IA, com
controle total sobre o que ela pode fazer.

Essa combinação — **open source, self-hosted, em português e com MCP
nativo** — é o principal diferencial deste projeto frente a
concorrentes fechados ou pagos por assento. Se você já usa Claude,
Cursor ou Copilot no dia a dia, vale a pena experimentar: é a forma
mais rápida de "conversar" com os dados do seu CRM.

---

## Índice

- [Pré-requisitos](#pré-requisitos)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Resumo rápido (quem já conhece MCP)](#resumo-rápido-quem-já-conhece-mcp)
- [Tutorial detalhado de instalação](#tutorial-detalhado-de-instalação)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [VS Code (via extensão GitHub Copilot)](#vs-code-via-extensão-github-copilot)
- [Ativando escrita (enviar mensagens e editar contatos)](#ativando-escrita-enviar-mensagens-e-editar-contatos)
- [Ferramentas (tools) disponíveis](#ferramentas-tools-disponíveis)
- [Modelo de segurança](#modelo-de-segurança)
- [Exemplos de perguntas para testar](#exemplos-de-perguntas-para-testar)
- [Solução de problemas](#solução-de-problemas)
- [Desenvolvimento](#desenvolvimento)
- [Licença](#licença)

---

## Pré-requisitos

1. Uma instância do ZAP CRM BR rodando (o seu deploy — veja o
   [README principal](../README.md) para colocar uma no ar).
2. Uma chave de API: no painel, vá em **Configurações → API keys →
   Nova API key** e conceda apenas os escopos necessários. A chave é
   exibida **uma única vez** — copie e guarde em local seguro.
3. [Node.js](https://nodejs.org) 20 ou superior instalado na sua
   máquina (o servidor MCP roda via `npx`, que já vem com o Node).
   Confirme no terminal:

   ```bash
   node --version
   ```

## Variáveis de ambiente

O servidor lê duas variáveis obrigatórias e duas travas de escrita
opcionais:

| Variável                  | Obrigatória | Finalidade                                                              |
| -------------------------- | ----------- | ------------------------------------------------------------------------ |
| `WACRM_BASE_URL`          | sim         | URL da sua instância, ex.: `https://crm.exemplo.com.br`                 |
| `WACRM_API_KEY`           | sim         | Uma chave de API criada no painel                                       |
| `WACRM_ENABLE_WRITES`     | não         | `true` para expor criação/edição de contato e envio de mensagem          |
| `WACRM_ENABLE_BROADCASTS` | não         | `true` para expor disparos em massa (exige `WACRM_ENABLE_WRITES` também) |

Por padrão (sem as duas últimas variáveis), o servidor é **somente
leitura** — a opção mais segura para começar.

---

## Resumo rápido (quem já conhece MCP)

Se você já configura servidores MCP no seu dia a dia, aqui está tudo
que precisa:

| Cliente            | Arquivo de configuração                                                       | Chave raiz do JSON | Campo extra obrigatório |
| ------------------- | ------------------------------------------------------------------------------- | ------------------- | ------------------------- |
| **Claude Desktop**  | `claude_desktop_config.json`                                                    | `mcpServers`        | —                          |
| **Cursor**          | `.cursor/mcp.json` (projeto) ou `~/.cursor/mcp.json` (global)                   | `mcpServers`        | —                          |
| **VS Code + Copilot** | `.vscode/mcp.json` (workspace) ou config de usuário (`MCP: Open User Configuration`) | `servers`            | `"type": "stdio"` em cada servidor |

Bloco base (Claude Desktop / Cursor):

```jsonc
{
  "mcpServers": {
    "wacrm": {
      "command": "npx",
      "args": ["-y", "wacrm-mcp"],
      "env": {
        "WACRM_BASE_URL": "https://crm.exemplo.com.br",
        "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Bloco equivalente para VS Code (repare em `servers` no lugar de
`mcpServers`, e no campo `type`):

```jsonc
{
  "servers": {
    "wacrm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "wacrm-mcp"],
      "env": {
        "WACRM_BASE_URL": "https://crm.exemplo.com.br",
        "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

> O pacote npm continua publicado como `wacrm-mcp` (mesmo núcleo do
> projeto original) — o nome do servidor entre aspas (`"wacrm"`) é
> apenas um rótulo escolhido por você e pode ser qualquer coisa, ex.:
> `"zap-crm-br"`.

Se isso já é suficiente para você, pule direto para
[Ativando escrita](#ativando-escrita-enviar-mensagens-e-editar-contatos)
ou a [tabela de ferramentas](#ferramentas-tools-disponíveis). Se
prefere um passo a passo com capturas de menu, continue lendo.

---

## Tutorial detalhado de instalação

Cada seção abaixo assume que você já tem em mãos:

- A **URL da sua instância** do ZAP CRM BR (ex.: `https://crm.exemplo.com.br`).
- A **API key** criada em **Configurações → API keys** no painel.
- O **Node.js 20+** instalado (veja [Pré-requisitos](#pré-requisitos)).

### Claude Desktop

1. **Instale o Claude Desktop**, se ainda não tiver: baixe em
   [claude.ai/download](https://claude.ai/download) (Windows ou
   macOS) e conclua a instalação normalmente.
2. **Abra o Claude Desktop** e acesse as configurações do aplicativo
   (não as configurações da sua conta): clique no menu do app — no
   Windows, o menu de três linhas (☰) ou o menu **File**; no macOS, o
   menu **Claude** na barra superior — e selecione **Settings...**
   (Configurações).
3. No painel de Settings, clique na aba **Developer** (Desenvolvedor)
   na lateral esquerda e depois no botão **Edit Config** (Editar
   configuração). Isso cria (se não existir) e abre o arquivo de
   configuração no seu editor de texto padrão.
   - Caso prefira editar o arquivo diretamente, ele fica em:
     - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
     - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
4. **Cole o bloco abaixo** no arquivo (se já houver conteúdo com
   outros servidores MCP, apenas adicione a chave `"wacrm"` dentro do
   objeto `"mcpServers"` existente, sem apagar o resto):

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.exemplo.com.br",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

5. Substitua a URL e a API key pelos valores reais da sua instância e
   **salve o arquivo**.
6. **Feche o Claude Desktop completamente** (não apenas minimize) e
   **abra de novo**. O app precisa reiniciar para carregar o novo
   servidor.
7. **Confirme a conexão:** no canto inferior esquerdo do campo de
   mensagem, clique no ícone de **"Adicionar arquivos, conectores e
   mais" ( + )** (em versões mais antigas, um ícone de martelo 🔨) →
   passe o mouse em **Connectors** → **Manage connectors**. O servidor
   `wacrm` deve aparecer na lista com suas ferramentas disponíveis.
8. **Teste** digitando no chat, por exemplo:
   > "Quantas conversas estão abertas agora no CRM?"

**Não conectou?** Veja [Solução de problemas](#solução-de-problemas).

### Cursor

1. Confirme que o **Node.js 20+** está instalado (`node --version`).
2. Escolha o escopo da configuração:
   - **Só neste projeto:** crie o arquivo `.cursor/mcp.json` na raiz
     do seu projeto atual.
   - **Em todos os projetos (recomendado para o CRM):** crie o
     arquivo `~/.cursor/mcp.json` na sua pasta de usuário (home) —
     como o CRM não é ligado a um repositório de código específico,
     faz mais sentido ter o servidor disponível globalmente.
3. Cole o conteúdo abaixo no arquivo, ajustando URL e API key:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.exemplo.com.br",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

4. Salve o arquivo. O Cursor detecta a mudança automaticamente, mas
   se quiser conferir: abra **Cursor Settings** (atalho
   `Ctrl+Shift+J`, ou pelo menu do Cursor) → seção **MCP** (também
   pode aparecer como **Tools & Integrations**). O servidor `wacrm`
   deve aparecer na lista, com um botão/toggle para ativar ou
   desativar sem precisar remover a configuração.
5. Se o toggle estiver desligado, ative-o. As ferramentas do servidor
   (ex.: `list_contacts`, `send_message`) aparecem listadas ali
   dentro.
6. No chat do Cursor, use o **modo Agent** e teste:
   > "Liste os últimos contatos cadastrados no CRM."

**Problemas de conexão:** abra o painel **Output** (`Ctrl+Shift+U`) e
selecione **MCP Logs** no menu suspenso para ver erros de
inicialização.

### VS Code (via extensão GitHub Copilot)

O VS Code **não tem**, por padrão, um gerenciador de MCP nativo como
o Claude Desktop ou o Cursor — mas a extensão **GitHub Copilot Chat**
resolve exatamente isso: ao instalá-la, o VS Code ganha suporte
completo a servidores MCP (configuração, confiança, listagem de
ferramentas e uso no chat em modo Agent), tornando a experiência tão
simples quanto nos outros dois clientes.

1. **Instale a extensão:** abra o painel de extensões
   (`Ctrl+Shift+X`), busque por **GitHub Copilot Chat** e clique em
   **Install**. É necessária uma conta com acesso ao GitHub Copilot.
2. **Adicione o servidor pelo assistente guiado:** abra a Paleta de
   Comandos (`Ctrl+Shift+P`), digite **MCP: Add Server** e siga o
   fluxo:
   - Tipo de servidor: **Command (stdio)**
   - Comando: `npx`
   - Argumentos: `-y wacrm-mcp`
   - Nome do servidor: `wacrm`
   - Escopo: **Workspace** (salva em `.vscode/mcp.json`, dentro do
     projeto atual) ou **Global/User** (disponível em todos os
     projetos — recomendado, pelo mesmo motivo do Cursor).
3. **Ou edite o arquivo manualmente.** Para o escopo de workspace,
   crie/edite `.vscode/mcp.json` na raiz do projeto; para o escopo de
   usuário, rode **MCP: Open User Configuration** pela Paleta de
   Comandos. Em ambos os casos, use este formato — repare que a
   chave raiz é `servers` (não `mcpServers`) e cada entrada precisa
   do campo `"type": "stdio"`:

   ```jsonc
   {
     "servers": {
       "wacrm": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.exemplo.com.br",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

4. **Salve o arquivo.** Na primeira vez que o VS Code iniciar esse
   servidor, ele mostra um diálogo pedindo para **confiar** na
   configuração — revise o comando exibido e aprove.
5. **Abra o Copilot Chat** (ícone de chat na barra lateral, ou
   `Ctrl+Alt+I`) e mude o seletor de modo, no topo do painel, para
   **Agent**.
6. Clique no ícone de ferramentas (🔧) dentro do chat para conferir
   que as tools do `wacrm` aparecem listadas e habilitadas.
7. **Teste** no chat, em modo Agent:
   > "Quantas conversas estão abertas no CRM?"

> ⚠️ **Segurança em repositórios versionados:** se usar o escopo
> *Workspace* (`.vscode/mcp.json`), evite commitar a API key em texto
> puro — prefira o escopo *User/Global* para dados sensíveis, ou use o
> mecanismo de variáveis de entrada (`${input:...}`) do VS Code. Veja
> a [documentação oficial de MCP no VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
> para esse nível avançado.

---

## Ativando escrita (enviar mensagens e editar contatos)

A configuração dos exemplos acima é **somente leitura** — o padrão
mais seguro. Para permitir que o assistente também crie/edite
contatos e envie mensagens, adicione as travas de escrita ao bloco
`env` (em qualquer um dos três clientes):

```jsonc
"env": {
  "WACRM_BASE_URL": "https://crm.exemplo.com.br",
  "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
  "WACRM_ENABLE_WRITES": "true",
  "WACRM_ENABLE_BROADCASTS": "true"
}
```

- `WACRM_ENABLE_WRITES` habilita `send_message`, `create_contact` e
  `update_contact`.
- `WACRM_ENABLE_BROADCASTS` habilita `send_broadcast` (disparo em
  massa) — só funciona se `WACRM_ENABLE_WRITES` também estiver `true`.

Depois de editar, reinicie o cliente (Claude Desktop) ou reative o
servidor (Cursor: toggle desligar/ligar; VS Code: Paleta de Comandos
→ **MCP: Restart Server**).

---

## Ferramentas (tools) disponíveis

As ferramentas de leitura ficam sempre disponíveis. As de escrita e
disparo só aparecem quando a respectiva trava está ligada.

| Ferramenta            | Grupo     | Escopo necessário     | O que faz                                                |
| ----------------------- | --------- | ----------------------- | ----------------------------------------------------------- |
| `whoami`               | leitura   | _(qualquer chave válida)_ | Mostra a conta e os escopos que a chave carrega            |
| `list_contacts`        | leitura   | `contacts:read`         | Lista/busca contatos (paginado)                             |
| `get_contact`          | leitura   | `contacts:read`         | Lê um contato específico                                    |
| `list_conversations`   | leitura   | `conversations:read`    | Lista conversas, com filtro por status/contato               |
| `get_conversation`     | leitura   | `conversations:read`    | Lê uma conversa específica                                   |
| `list_messages`        | leitura   | `messages:read`         | Lista as mensagens de uma conversa                            |
| `get_broadcast`        | leitura   | `broadcasts:send`       | Consulta o status de entrega de um disparo                    |
| `send_message`         | escrita   | `messages:send`         | Envia uma mensagem no WhatsApp (texto/template/mídia)        |
| `create_contact`       | escrita   | `contacts:write`        | Cria (ou reaproveita) um contato                              |
| `update_contact`       | escrita   | `contacts:write`        | Atualiza um contato / substitui suas etiquetas                |
| `send_broadcast`       | disparo   | `broadcasts:send`       | Dispara um broadcast de template (exige `confirm`)            |

## Modelo de segurança

Enviar mensagens de WhatsApp através de uma IA é um efeito real no
mundo — por isso o servidor tem três camadas de proteção:

1. **Somente leitura por padrão.** As ferramentas de escrita e
   disparo nem sequer são registradas — o modelo não as "vê" — a
   menos que você habilite explicitamente via `WACRM_ENABLE_WRITES` /
   `WACRM_ENABLE_BROADCASTS`.
2. **Escopos da API key.** Mesmo com as travas liberadas, a sua
   instância do ZAP CRM BR continua aplicando os escopos da chave. Uma
   chamada sem o escopo certo retorna um erro `forbidden` limpo — use
   uma chave só de leitura para um assistente só de leitura.
3. **Confirmação explícita em disparos.** `send_broadcast` recusa
   rodar sem `confirm: true` e é marcada como `destructive`, para que
   clientes compatíveis (Claude Desktop, Cursor, VS Code) peçam
   confirmação ao usuário antes de executar.

## Exemplos de perguntas para testar

Depois de conectado, experimente perguntas assim no chat do seu
assistente (em modo Agent/Tools):

- "Quantas conversas estão abertas hoje?"
- "Busque o contato do telefone +55 11 91234-5678."
- "Mostre as últimas 5 mensagens da conversa com a Ana."
- "Crie um contato chamado João Silva, telefone +55 21 99876-5432, com a etiqueta 'lead-site'."
- "Envie o template `atualizacao_pedido` para esse contato." _(requer escrita habilitada)_

## Solução de problemas

- **O servidor não aparece / ícone de ferramentas sumiu:**
  reinicie o cliente por completo (feche e abra de novo) e confira se
  o JSON está sintaticamente válido (vírgulas, chaves).
- **Teste manual pelo terminal** — roda o servidor fora do cliente
  para ver o erro diretamente:

  ```bash
  WACRM_BASE_URL=https://crm.exemplo.com.br WACRM_API_KEY=sua_chave npx -y wacrm-mcp
  ```

  No PowerShell (Windows):

  ```powershell
  $env:WACRM_BASE_URL="https://crm.exemplo.com.br"; $env:WACRM_API_KEY="sua_chave"; npx -y wacrm-mcp
  ```

- **Logs por cliente:**
  - **Claude Desktop:** Windows `%APPDATA%\Claude\logs`, macOS
    `~/Library/Logs/Claude` — arquivos `mcp.log` e
    `mcp-server-wacrm.log`.
  - **Cursor:** painel **Output** (`Ctrl+Shift+U`) → dropdown **MCP
    Logs**.
  - **VS Code:** painel **Output** (`Ctrl+Shift+U`) → dropdown com o
    nome do servidor MCP.
- **Erro de permissão (`forbidden`):** a API key não tem o escopo
  necessário para aquela ferramenta — gere uma nova chave com o
  escopo certo em **Configurações → API keys**.
- **`npx` falha ou trava:** confirme `node --version` ≥ 20 e que o
  `npm` está instalado globalmente (`npm install -g npm`).

## Desenvolvimento

```bash
npm install
npm run build      # compila para dist/
npm run typecheck
npm start           # roda o servidor compilado (precisa das env vars)
```

Os logs vão para **stderr** — o stdout é reservado para o protocolo
MCP.

## Licença

MIT — mesma licença do [ZAP CRM BR](../README.md).

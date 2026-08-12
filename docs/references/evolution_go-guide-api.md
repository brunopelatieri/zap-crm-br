# Evolution Go (v3) – Referência Completa de API e Integração

## 1. Arquitetura e Visão Geral
A **Evolution Go** é uma API restrita para comunicação com o WhatsApp, reescrita do zero em Golang e utilizando a biblioteca nativa `whatsmeow`. Ela foi desenhada especificamente para arquiteturas de alta concorrência e SaaS multi-tenant.

**Limitações Arquiteturais Importantes (whatsmeow):**
- **Sem Botões Nativos via QR Code:** Devido a restrições do protocolo Multi-Device do WhatsApp Web, a Evolution Go **não suporta** mensagens interativas clássicas (Botões e Carrosséis) em conexões via QR Code. 
- **Estratégia de Interatividade:** O padrão arquitetural para capturar inputs de usuários (ex: menus de autoatendimento, aprovação de pedidos) deve ser exclusivamente baseado no endpoint de **Enquetes (Polls)**.

**Repositório e Docs:**
- Docs: https://docs.evolutionfoundation.com.br/evolution-go
- Git: `https://git.evoai.app/Evolution/evolution-go.git`

---

## 2. Autenticação e Configuração de Headers

Todas as requisições HTTP exigem autenticação. A porta padrão do serviço é `8080`.

**Headers Globais:**
```http
Content-Type: application/json
apikey: SUA_GLOBAL_API_KEY_OU_INSTANCE_TOKEN

```

---

## 3. Gestão de Instâncias (Multi-tenant)

Estes endpoints são utilizados pelo backend para provisionar e gerenciar a conexão dos clientes.

### 3.1 Criar Instância (Com Chatwoot e Webhook)

Cria uma nova sessão no banco de dados (PostgreSQL) e prepara o ambiente para o QR Code.

* **POST** `/instance/create`

```json
{
  "instanceName": "restaurante_matriz_01",
  "qrcode": true,
  "webhook": "[https://seu-n8n.com/webhook/evolution-inbound](https://seu-n8n.com/webhook/evolution-inbound)",
  "events": [
    "MESSAGES_UPSERT",
    "CONNECTION_UPDATE",
    "PRESENCE_UPDATE"
  ],
  "chatwoot": {
    "enabled": true,
    "url": "[https://chatwoot.suaempresa.com](https://chatwoot.suaempresa.com)",
    "account_id": "1",
    "token": "seu_access_token_do_chatwoot",
    "sign_msg": true,
    "reopen_conversation": true,
    "conversation_pending": false
  }
}

```

### 3.2 Buscar QR Code de Conexão

Gera a string base64 do QR Code. O payload retorna a imagem pronta para ser renderizada no frontend.

* **GET** `/instance/{instanceName}/qrcode`

### 3.3 Verificar Status da Instância

Retorna se o aparelho do cliente está conectado e roteando mensagens.

* **GET** `/instance/{instanceName}/status`

### 3.4 Desconectar e Excluir Instância (Logout)

Remove o token do PostgreSQL e desvincula o aparelho do cliente.

* **DELETE** `/instance/{instanceName}`

---

## 4. API de Mensageria (Outbound)

*Nota: O número de destino (`number`) deve estar no formato DDI + DDD + Número (ex: 5511999999999).*

### 4.1 Enviar Mensagem de Texto

* **POST** `/message/sendText/{instanceName}`

```json
{
  "number": "5511999999999",
  "text": "Olá! O pedido #4092 para a Mesa 04 foi registrado no sistema. O tempo estimado de preparo é de 25 minutos.",
  "delay": 1500
}

```

*(O parâmetro `delay` em milissegundos simula o status de "Digitando..." no celular do cliente).*

### 4.2 Enviar Mídia (Documentos, Imagens, Vídeos)

Suporta links públicos ou envio via string Base64.

* **POST** `/message/sendMedia/{instanceName}`

```json
{
  "number": "5511999999999",
  "mediatype": "document",
  "mimetype": "application/pdf",
  "caption": "Segue o fechamento da conta.",
  "media": "[https://link-do-supabase-storage.com/conta_mesa04.pdf](https://link-do-supabase-storage.com/conta_mesa04.pdf)",
  "fileName": "fechamento_conta.pdf"
}

```

*(Valores aceitos em `mediatype`: `image`, `video`, `audio`, `document`).*

### 4.3 Enviar Áudio Gravado (PTT)

Envia o áudio simulando que foi gravado na hora pelo microfone.

* **POST** `/message/sendWhatsAppAudio/{instanceName}`

```json
{
  "number": "5511999999999",
  "audio": "[https://link-do-storage.com/audio_atendimento.ogg](https://link-do-storage.com/audio_atendimento.ogg)",
  "delay": 2000
}

```

### 4.4 Enviar Enquete (Poll) - *Interatividade Nativa*

A principal ferramenta para menus e captação de escolhas na versão Go.

* **POST** `/message/sendPoll/{instanceName}`

```json
{
  "number": "5511999999999",
  "name": "Como você avalia o atendimento do nosso garçom hoje?",
  "options": [
    "⭐⭐⭐⭐⭐ Excelente",
    "⭐⭐⭐ Regular",
    "⭐ Ruim",
    "Falar com o Gerente"
  ],
  "selectableCount": 1
}

```

### 4.5 Enviar Localização

* **POST** `/message/sendLocation/{instanceName}`

```json
{
  "number": "5511999999999",
  "name": "Nossa Matriz",
  "address": "Av. Principal, 1000 - Centro",
  "latitude": -23.550520,
  "longitude": -46.633308
}

```

---

## 5. Estrutura de Webhooks (Inbound)

A Evolution Go envia eventos `POST` para a URL configurada na instância. O evento principal para processamento de IA é o `messages.upsert`.

### 5.1 Payload: Nova Mensagem de Texto

```json
{
  "event": "messages.upsert",
  "instance": "restaurante_matriz_01",
  "data": {
    "message": {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "BAE5XXXXXXXXXXXXXXXX"
      },
      "pushName": "Carlos Cliente",
      "message": {
        "conversation": "Vocês aceitam vale refeição?"
      }
    }
  }
}

```

### 5.2 Payload: Resposta de Enquete (Poll Update)

Quando o usuário vota em uma enquete, o payload chega diferente. A automação deve monitorar o objeto `pollUpdateMessage` (na biblioteca whatsmeow) ou ler o nome da opção escolhida decriptada pela API.

```json
{
  "event": "messages.upsert",
  "instance": "restaurante_matriz_01",
  "data": {
    "message": {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "BAE5YYYYYYYYYYYYYYYY"
      },
      "message": {
        "pollUpdateMessage": {
          "pollCreationMessageKey": {
             "id": "ID_DA_MENSAGEM_ORIGINAL"
          },
          "vote": {
             "selectedOptions": ["⭐⭐⭐⭐⭐ Excelente"]
          }
        }
      }
    }
  }
}

```

---

## 6. Diretrizes para Integração com LLMs / Agentes de IA

Ao construir lógicas de orquestração para esta API, obedeça às seguintes regras de sistema:

1. **Roteamento de Respostas:** Ao receber o payload do webhook `messages.upsert`, extraia sempre o `remoteJid` (removendo `@s.whatsapp.net` se necessário) para usá-radicional no campo `number` nas requisições de resposta (Outbound).
2. **Formatação Múltipla:** Se a intenção da IA for gerar opções para o usuário escolher, converta a saída da IA em um array JSON e dispare para o endpoint `/message/sendPoll`, definindo `selectableCount` como 1.
3. **Bloqueio de Templates:** O agente de IA não deve tentar gerar payloads contendo as chaves `buttons`, `templateMessage` ou `listMessage`, pois o motor Go (`whatsmeow`) ignorará a renderização.

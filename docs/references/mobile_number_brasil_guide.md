# 📱 Validação de Telefones Brasileiros — Guia Técnico Completo

> **Referência definitiva para validação, normalização e integração de números de telefone brasileiros em sistemas reais** — padrões Anatel, DDD válidos, regex prontas, exemplos em código e atenção aos casos de borda que derrubam sistemas em produção.

[![Anatel](https://img.shields.io/badge/Fonte-Anatel%20Resolução%20553%2F2010-blue?style=flat-square)](https://www.gov.br/anatel/pt-br/regulado/numeracao/nono-digito)
[![Formato](https://img.shields.io/badge/Formato-E.164%20%7C%20Nacional-green?style=flat-square)](.)
[![DDDs](https://img.shields.io/badge/DDDs%20v%C3%A1lidos-67%20c%C3%B3digos-orange?style=flat-square)](.)
[![Idioma](https://img.shields.io/badge/Idioma-PT--BR-informational?style=flat-square)](.)

---

## 📋 Índice

- [📱 Validação de Telefones Brasileiros — Guia Técnico Completo](#-validação-de-telefones-brasileiros--guia-técnico-completo)
  - [📋 Índice](#-índice)
  - [🏗️ Estrutura Geral de Numeração no Brasil](#️-estrutura-geral-de-numeração-no-brasil)
    - [Contagem total de dígitos (sem DDI)](#contagem-total-de-dígitos-sem-ddi)
  - [📲 Celular — Regras e o Nono Dígito](#-celular--regras-e-o-nono-dígito)
    - [O padrão atual](#o-padrão-atual)
    - [Por que não aceitar 8 dígitos em celular?](#por-que-não-aceitar-8-dígitos-em-celular)
    - [Dígitos iniciais válidos para celular](#dígitos-iniciais-válidos-para-celular)
  - [☎️ Telefone Fixo](#️-telefone-fixo)
  - [⚠️ Casos de Borda que Derrubam Sistemas](#️-casos-de-borda-que-derrubam-sistemas)
    - [Fluxo de normalização recomendado](#fluxo-de-normalização-recomendado)
  - [🗺️ Tabela de DDDs Válidos](#️-tabela-de-ddds-válidos)
    - [Sudeste](#sudeste)
    - [Sul](#sul)
    - [Centro-Oeste](#centro-oeste)
    - [Nordeste](#nordeste)
    - [Norte](#norte)
  - [🌐 Normalização para E.164](#-normalização-para-e164)
  - [🔍 Regex de Validação](#-regex-de-validação)
    - [Celular (11 dígitos após limpeza)](#celular-11-dígitos-após-limpeza)
    - [Fixo (10 dígitos após limpeza)](#fixo-10-dígitos-após-limpeza)
    - [Aceita formatação na entrada (com máscara)](#aceita-formatação-na-entrada-com-máscara)
  - [💻 Implementações em Código](#-implementações-em-código)
    - [JavaScript / TypeScript](#javascript--typescript)
    - [Python](#python)
    - [Expression n8n (normalização para E.164)](#expression-n8n-normalização-para-e164)
  - [📦 JSON e CSV dos DDDs](#-json-e-csv-dos-ddds)
    - [JSON — pronto para validação em código](#json--pronto-para-validação-em-código)
    - [JSON com metadados por DDD](#json-com-metadados-por-ddd)
    - [CSV](#csv)
  - [📲 Integração com WhatsApp (Evolution API / n8n)](#-integração-com-whatsapp-evolution-api--n8n)
    - [Validação antes de enviar mensagem pelo n8n](#validação-antes-de-enviar-mensagem-pelo-n8n)
  - [📚 Referências](#-referências)

---

## 🏗️ Estrutura Geral de Numeração no Brasil

O padrão de numeração telefônica brasileiro é regulamentado pela **Anatel (Agência Nacional de Telecomunicações)**, principalmente através da **Resolução nº 553/2010**, que definiu a migração para o nono dígito em celulares.

```
Número completo = DDI (opcional) + DDD (2 dígitos) + Número local
```

| Componente | Tamanho | Exemplo | Obrigatório |
|---|---|---|---|
| **DDI** (código do país) | 2 dígitos | `55` (Brasil) | Só em formato internacional |
| **DDD** (código de área) | 2 dígitos | `11`, `21`, `85` | Sempre |
| **Número local — Celular** | 9 dígitos | `9XXXX-XXXX` | — |
| **Número local — Fixo** | 8 dígitos | `XXXX-XXXX` | — |

### Contagem total de dígitos (sem DDI)

| Tipo | DDD | Número local | Total |
|---|---|---|---|
| **Celular** | 2 | 9 | **11 dígitos** |
| **Fixo** | 2 | 8 | **10 dígitos** |

---

## 📲 Celular — Regras e o Nono Dígito

### O padrão atual

Celular no Brasil tem **9 dígitos após o DDD**, e o primeiro dígito do número local **sempre começa com 9**:

```
DDD + 9 + XXXX + XXXX
 11    9   8765   4321   →  11 98765-4321
```

### Por que não aceitar 8 dígitos em celular?

<cite index="21-1">A Anatel implementou o nono dígito para celulares através da Resolução nº 553/2010, com início no DDD 11 em 29 de julho de 2012.</cite> O cronograma foi gradual:

| Período | DDDs afetados |
|---|---|
| Julho 2012 | 11 |
| Agosto 2013 | 12, 13, 14, 15, 16, 17, 18, 19 |
| Outubro 2013 | 21, 22, 24, 27, 28 |
| Novembro 2014 | 91, 92, 93, 94, 95, 96, 97, 98, 99 |
| Maio 2015 | 81, 82, 83, 84, 85, 86, 87, 88, 89 |
| Outubro 2015 | 31, 32, 33, 34, 35, 37, 38, 71, 73, 74, 75, 77, 79 |
| Até Dez 2016 | Todos os demais (41–69, 51–55, 61–69) |

Desde o encerramento desse cronograma, **todos os DDDs do Brasil utilizam 9 dígitos para celular**. Números de 8 dígitos após o DDD são hoje exclusivos de telefones fixos.

> ⚠️ **Armadilha comum:** o WhatsApp ainda mantém em alguns contatos antigos números com 8 dígitos (pré-migração) especialmente em DDDs fora da faixa 1x e 2x — isso não representa o formato válido atual para novos cadastros, mas pode aparecer em bases de dados legadas.

### Dígitos iniciais válidos para celular

O dígito inicial do número de celular é sempre `9`. Os dígitos `6`, `7` e `8` após o DDD eram usados para celular no passado — hoje estão reservados ou em fase de extinção. Para validação de novos cadastros, aceite **somente `9`**.

---

## ☎️ Telefone Fixo

Telefones fixos têm **8 dígitos após o DDD** e o primeiro dígito é geralmente `2`, `3`, `4`, `5` ou `8`:

```
DDD + XXXX + XXXX
 11   3456   7890   →  11 3456-7890
```

> 💡 O dígito inicial `2` é o mais comum em capitais. Em cidades do interior, `3` e `4` são frequentes. O dígito `8` para fixos é menos comum mas válido em algumas regiões.

---

## ⚠️ Casos de Borda que Derrubam Sistemas

Estes são os cenários que causam erros silenciosos em sistemas de validação de telefone em produção:

| Situação | Exemplo recebido | O que fazer |
|---|---|---|
| Número com DDI `+55` | `+55 11 98765-4321` | Remover `+55` antes de validar |
| DDI sem `+` | `55 11 98765-4321` | Verificar se tem 13 dígitos; se sim, remover os 2 primeiros |
| Celular com 8 dígitos (legado) | `11 9876-5432` | Rejeitar ou sinalizar para revisão manual |
| Número formatado com máscara | `(11) 98765-4321` | Remover `(`, `)`, `-`, espaços antes de validar |
| DDD inválido | `10 98765-4321` | Validar contra lista de DDDs permitidos |
| Número de serviço especial | `0800 123 4567` | Tratar separadamente — não é DDD + número local |
| Número incompleto | `9876-5432` (sem DDD) | Rejeitar ou solicitar DDD |
| Zeros à esquerda extras | `011 98765-4321` | Remover o `0` de discagem nacional antes de validar |

### Fluxo de normalização recomendado

```
Input bruto
    │
    ▼
Remover todos os caracteres não numéricos: espaços, (, ), -, +
    │
    ▼
Verificar se começa com 55 e tem 12 ou 13 dígitos → remover os 2 primeiros
    │
    ▼
Verificar se começa com 0 → remover (0 de discagem nacional)
    │
    ▼
Deve restar 10 ou 11 dígitos
    │
    ├── 11 dígitos → valida como celular (9 inicial obrigatório)
    └── 10 dígitos → valida como fixo
    │
    ▼
Validar os 2 primeiros dígitos contra lista de DDDs válidos
    │
    ▼
✅ Número válido
```

---

## 🗺️ Tabela de DDDs Válidos

**67 códigos DDD** ativos no Brasil, organizados por região:

### Sudeste

| DDD | Estado / Região |
|---|---|
| 11 | São Paulo — Capital e Região Metropolitana |
| 12 | São Paulo — Vale do Paraíba e Litoral Norte |
| 13 | São Paulo — Baixada Santista e Vale do Ribeira |
| 14 | São Paulo — Bauru e região |
| 15 | São Paulo — Sorocaba e região |
| 16 | São Paulo — Ribeirão Preto e região |
| 17 | São Paulo — São José do Rio Preto e região |
| 18 | São Paulo — Presidente Prudente e região |
| 19 | São Paulo — Campinas e região |
| 21 | Rio de Janeiro — Capital e Região Metropolitana |
| 22 | Rio de Janeiro — Norte Fluminense e Serrana |
| 24 | Rio de Janeiro — Sul Fluminense e Costa Verde |
| 27 | Espírito Santo — Vitória e região |
| 28 | Espírito Santo — Sul do Estado |
| 31 | Minas Gerais — Belo Horizonte e Região Metropolitana |
| 32 | Minas Gerais — Zona da Mata |
| 33 | Minas Gerais — Vale do Rio Doce |
| 34 | Minas Gerais — Triângulo Mineiro |
| 35 | Minas Gerais — Sul de Minas |
| 37 | Minas Gerais — Centro-Oeste Mineiro |
| 38 | Minas Gerais — Norte de Minas |

### Sul

| DDD | Estado / Região |
|---|---|
| 41 | Paraná — Curitiba e Região Metropolitana |
| 42 | Paraná — Ponta Grossa e região |
| 43 | Paraná — Londrina e região |
| 44 | Paraná — Maringá e região |
| 45 | Paraná — Cascavel e região |
| 46 | Paraná — Sudoeste do Paraná |
| 47 | Santa Catarina — Litoral Norte e Vale do Itajaí |
| 48 | Santa Catarina — Florianópolis e Sul do Estado |
| 49 | Santa Catarina — Oeste e Serrana |
| 51 | Rio Grande do Sul — Porto Alegre e Região Metropolitana |
| 53 | Rio Grande do Sul — Pelotas e região |
| 54 | Rio Grande do Sul — Caxias do Sul e Serra Gaúcha |
| 55 | Rio Grande do Sul — Santa Maria e região |

### Centro-Oeste

| DDD | Estado / Região |
|---|---|
| 61 | Distrito Federal e entorno / Goiás |
| 62 | Goiás — Goiânia e região |
| 63 | Tocantins |
| 64 | Goiás — Sul do Estado |
| 65 | Mato Grosso — Cuiabá e região |
| 66 | Mato Grosso — Rondonópolis e região |
| 67 | Mato Grosso do Sul |
| 68 | Acre |
| 69 | Rondônia |

### Nordeste

| DDD | Estado / Região |
|---|---|
| 71 | Bahia — Salvador e Região Metropolitana |
| 73 | Bahia — Ilhéus e Sul da Bahia |
| 74 | Bahia — Juazeiro e Região do São Francisco |
| 75 | Bahia — Feira de Santana e região |
| 77 | Bahia — Vitória da Conquista e Sudoeste Baiano |
| 79 | Sergipe |
| 81 | Pernambuco — Recife e Região Metropolitana |
| 82 | Alagoas |
| 83 | Paraíba |
| 84 | Rio Grande do Norte |
| 85 | Ceará — Fortaleza e região |
| 86 | Piauí — Teresina e Norte do Estado |
| 87 | Pernambuco — Sertão |
| 88 | Ceará — Sul do Estado |
| 89 | Piauí — Sul do Estado |

### Norte

| DDD | Estado / Região |
|---|---|
| 91 | Pará — Belém e região |
| 92 | Amazonas — Manaus e região |
| 93 | Pará — Santarém e Oeste do Pará |
| 94 | Pará — Marabá e Sul do Pará |
| 95 | Roraima |
| 96 | Amapá |
| 97 | Amazonas — Interior do Estado |
| 98 | Maranhão — São Luís e região |
| 99 | Maranhão — Interior do Estado |

---

## 🌐 Normalização para E.164

O formato **E.164** é o padrão internacional de números de telefone (usado por APIs como WhatsApp Business, Twilio, AWS SNS, Evolution API). No Brasil:

```
E.164 = +55 + DDD (2 dígitos) + Número local (8 ou 9 dígitos)

Celular:  +55 11 98765-4321  →  +5511987654321  (13 dígitos com +)
Fixo:     +55 11 3456-7890  →  +551134567890   (12 dígitos com +)
```

---

## 🔍 Regex de Validação

### Celular (11 dígitos após limpeza)

```regex
^([1-9][0-9])9[0-9]{8}$
```

- `([1-9][0-9])` → DDD: primeiro dígito entre 1-9, segundo entre 0-9
- `9` → nono dígito obrigatório
- `[0-9]{8}` → 8 dígitos restantes

### Fixo (10 dígitos após limpeza)

```regex
^([1-9][0-9])[2-8][0-9]{7}$
```

- `([1-9][0-9])` → DDD
- `[2-8]` → primeiro dígito do número local (fixo)
- `[0-9]{7}` → 7 dígitos restantes

### Aceita formatação na entrada (com máscara)

```regex
^(\+?55\s?)?(\(?\d{2}\)?[\s-]?)?(9\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4})$
```

> ⚠️ Regex com máscara aceita entrada humana, mas **não valida DDD contra a lista oficial**. Use a regex limpa após normalizar o input para validação mais robusta.

---

## 💻 Implementações em Código

### JavaScript / TypeScript

```typescript
const DDD_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

function limparTelefone(tel: string): string {
  // Remove tudo que não é dígito
  let limpo = tel.replace(/\D/g, "");
  // Remove DDI 55 se presente (13 dígitos = DDI+DDD+celular ou 12 = DDI+DDD+fixo)
  if (limpo.startsWith("55") && (limpo.length === 13 || limpo.length === 12)) {
    limpo = limpo.slice(2);
  }
  // Remove 0 de discagem nacional
  if (limpo.startsWith("0") && limpo.length === 12) {
    limpo = limpo.slice(1);
  }
  return limpo;
}

type TipoTelefone = "celular" | "fixo" | "invalido";

interface ResultadoValidacao {
  valido: boolean;
  tipo: TipoTelefone;
  ddd: number | null;
  numero: string | null;
  e164: string | null;
  erro?: string;
}

function validarTelefoneBR(input: string): ResultadoValidacao {
  const limpo = limparTelefone(input);

  if (limpo.length !== 10 && limpo.length !== 11) {
    return {
      valido: false,
      tipo: "invalido",
      ddd: null,
      numero: null,
      e164: null,
      erro: `Comprimento inválido: ${limpo.length} dígitos (esperado 10 ou 11)`,
    };
  }

  const ddd = parseInt(limpo.slice(0, 2), 10);
  const numeroLocal = limpo.slice(2);

  if (!DDD_VALIDOS.has(ddd)) {
    return {
      valido: false,
      tipo: "invalido",
      ddd,
      numero: null,
      e164: null,
      erro: `DDD inválido: ${ddd}`,
    };
  }

  if (limpo.length === 11) {
    if (numeroLocal[0] !== "9") {
      return {
        valido: false,
        tipo: "invalido",
        ddd,
        numero: null,
        e164: null,
        erro: "Celular com 11 dígitos deve começar com 9 após o DDD",
      };
    }
    return {
      valido: true,
      tipo: "celular",
      ddd,
      numero: numeroLocal,
      e164: `+55${limpo}`,
    };
  }

  // 10 dígitos = fixo
  if (!/^[2-8]/.test(numeroLocal)) {
    return {
      valido: false,
      tipo: "invalido",
      ddd,
      numero: null,
      e164: null,
      erro: "Fixo deve começar com dígito entre 2 e 8",
    };
  }

  return {
    valido: true,
    tipo: "fixo",
    ddd,
    numero: numeroLocal,
    e164: `+55${limpo}`,
  };
}

// Uso
console.log(validarTelefoneBR("+55 (11) 98765-4321"));
// { valido: true, tipo: 'celular', ddd: 11, numero: '987654321', e164: '+5511987654321' }

console.log(validarTelefoneBR("(21) 3456-7890"));
// { valido: true, tipo: 'fixo', ddd: 21, numero: '34567890', e164: '+552134567890' }

console.log(validarTelefoneBR("10 98765-4321"));
// { valido: false, tipo: 'invalido', erro: 'DDD inválido: 10' }
```

---

### Python

```python
import re
from typing import Optional

DDD_VALIDOS = {
    11, 12, 13, 14, 15, 16, 17, 18, 19,
    21, 22, 24, 27, 28,
    31, 32, 33, 34, 35, 37, 38,
    41, 42, 43, 44, 45, 46, 47, 48, 49,
    51, 53, 54, 55,
    61, 62, 63, 64, 65, 66, 67, 68, 69,
    71, 73, 74, 75, 77, 79,
    81, 82, 83, 84, 85, 86, 87, 88, 89,
    91, 92, 93, 94, 95, 96, 97, 98, 99,
}

def limpar_telefone(tel: str) -> str:
    limpo = re.sub(r"\D", "", tel)
    if limpo.startswith("55") and len(limpo) in (12, 13):
        limpo = limpo[2:]
    if limpo.startswith("0") and len(limpo) == 12:
        limpo = limpo[1:]
    return limpo

def validar_telefone_br(input_tel: str) -> dict:
    limpo = limpar_telefone(input_tel)

    if len(limpo) not in (10, 11):
        return {"valido": False, "erro": f"Comprimento inválido: {len(limpo)} dígitos"}

    ddd = int(limpo[:2])
    numero_local = limpo[2:]

    if ddd not in DDD_VALIDOS:
        return {"valido": False, "erro": f"DDD inválido: {ddd}"}

    if len(limpo) == 11:
        if numero_local[0] != "9":
            return {"valido": False, "erro": "Celular deve iniciar com 9 após o DDD"}
        return {"valido": True, "tipo": "celular", "ddd": ddd, "numero": numero_local, "e164": f"+55{limpo}"}

    if not re.match(r"^[2-8]", numero_local):
        return {"valido": False, "erro": "Fixo deve iniciar com dígito entre 2 e 8"}

    return {"valido": True, "tipo": "fixo", "ddd": ddd, "numero": numero_local, "e164": f"+55{limpo}"}

# Uso
print(validar_telefone_br("+55 (11) 98765-4321"))
# {'valido': True, 'tipo': 'celular', 'ddd': 11, 'numero': '987654321', 'e164': '+5511987654321'}
```

---

### Expression n8n (normalização para E.164)

Use essa expression em nós de Set ou Code no n8n para normalizar o telefone do lead antes de enviar para Evolution API ou WhatsApp:

```javascript
// Em nó Code — normaliza para E.164 sem o +
const raw = $json.telefone ?? "";
let tel = raw.replace(/\D/g, "");

// Remove DDI 55 se já presente
if (tel.startsWith("55") && (tel.length === 13 || tel.length === 12)) {
  tel = tel.slice(2);
}

// Remove 0 de discagem
if (tel.startsWith("0") && tel.length === 12) {
  tel = tel.slice(1);
}

const dddsValidos = new Set([
  11,12,13,14,15,16,17,18,19,
  21,22,24,27,28,31,32,33,34,35,37,38,
  41,42,43,44,45,46,47,48,49,51,53,54,55,
  61,62,63,64,65,66,67,68,69,
  71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,
  91,92,93,94,95,96,97,98,99
]);

const ddd = parseInt(tel.slice(0, 2));
const valido = (tel.length === 11 || tel.length === 10) && dddsValidos.has(ddd);

return {
  telefone_original: raw,
  telefone_e164: valido ? `55${tel}` : null,  // sem o + para Evolution API
  ddd: valido ? ddd : null,
  tipo: valido ? (tel.length === 11 ? "celular" : "fixo") : null,
  valido,
};
```

---

## 📦 JSON e CSV dos DDDs

### JSON — pronto para validação em código

```json
{
  "ddds_validos": [
    11, 12, 13, 14, 15, 16, 17, 18, 19,
    21, 22, 24, 27, 28,
    31, 32, 33, 34, 35, 37, 38,
    41, 42, 43, 44, 45, 46, 47, 48, 49,
    51, 53, 54, 55,
    61, 62, 63, 64, 65, 66, 67, 68, 69,
    71, 73, 74, 75, 77, 79,
    81, 82, 83, 84, 85, 86, 87, 88, 89,
    91, 92, 93, 94, 95, 96, 97, 98, 99
  ],
  "total": 67,
  "fonte": "Anatel — Resolução nº 553/2010",
  "observacao": "DDD 23, 25, 26, 29, 36, 39, 52, 56–60, 70, 72, 76, 78, 80, 90 não existem"
}
```

### JSON com metadados por DDD

```json
{
  "ddds": [
    { "ddd": 11, "estado": "São Paulo", "regiao": "Capital e RM" },
    { "ddd": 12, "estado": "São Paulo", "regiao": "Vale do Paraíba" },
    { "ddd": 21, "estado": "Rio de Janeiro", "regiao": "Capital e RM" },
    { "ddd": 31, "estado": "Minas Gerais", "regiao": "Belo Horizonte e RM" },
    { "ddd": 41, "estado": "Paraná", "regiao": "Curitiba e RM" },
    { "ddd": 51, "estado": "Rio Grande do Sul", "regiao": "Porto Alegre e RM" },
    { "ddd": 61, "estado": "Distrito Federal", "regiao": "Brasília e entorno" },
    { "ddd": 71, "estado": "Bahia", "regiao": "Salvador e RM" },
    { "ddd": 81, "estado": "Pernambuco", "regiao": "Recife e RM" },
    { "ddd": 91, "estado": "Pará", "regiao": "Belém e região" }
  ]
}
```

### CSV

```csv
ddd,estado,regiao
11,São Paulo,Capital e RM
12,São Paulo,Vale do Paraíba
13,São Paulo,Baixada Santista
14,São Paulo,Bauru
15,São Paulo,Sorocaba
16,São Paulo,Ribeirão Preto
17,São Paulo,São José do Rio Preto
18,São Paulo,Presidente Prudente
19,São Paulo,Campinas
21,Rio de Janeiro,Capital e RM
22,Rio de Janeiro,Norte Fluminense
24,Rio de Janeiro,Sul Fluminense
27,Espírito Santo,Vitória
28,Espírito Santo,Sul do Estado
31,Minas Gerais,Belo Horizonte e RM
32,Minas Gerais,Zona da Mata
33,Minas Gerais,Vale do Rio Doce
34,Minas Gerais,Triângulo Mineiro
35,Minas Gerais,Sul de Minas
37,Minas Gerais,Centro-Oeste Mineiro
38,Minas Gerais,Norte de Minas
41,Paraná,Curitiba e RM
42,Paraná,Ponta Grossa
43,Paraná,Londrina
44,Paraná,Maringá
45,Paraná,Cascavel
46,Paraná,Sudoeste do Paraná
47,Santa Catarina,Litoral Norte e Vale do Itajaí
48,Santa Catarina,Florianópolis e Sul
49,Santa Catarina,Oeste e Serrana
51,Rio Grande do Sul,Porto Alegre e RM
53,Rio Grande do Sul,Pelotas
54,Rio Grande do Sul,Caxias do Sul
55,Rio Grande do Sul,Santa Maria
61,Distrito Federal,Brasília e entorno
62,Goiás,Goiânia
63,Tocantins,Palmas e Estado
64,Goiás,Sul do Estado
65,Mato Grosso,Cuiabá
66,Mato Grosso,Rondonópolis
67,Mato Grosso do Sul,Campo Grande
68,Acre,Rio Branco
69,Rondônia,Porto Velho
71,Bahia,Salvador e RM
73,Bahia,Ilhéus e Sul
74,Bahia,Juazeiro
75,Bahia,Feira de Santana
77,Bahia,Vitória da Conquista
79,Sergipe,Aracaju e Estado
81,Pernambuco,Recife e RM
82,Alagoas,Maceió e Estado
83,Paraíba,João Pessoa e Estado
84,Rio Grande do Norte,Natal e Estado
85,Ceará,Fortaleza e região
86,Piauí,Teresina e Norte
87,Pernambuco,Sertão
88,Ceará,Sul do Estado
89,Piauí,Sul do Estado
91,Pará,Belém e região
92,Amazonas,Manaus e região
93,Pará,Santarém e Oeste
94,Pará,Marabá e Sul
95,Roraima,Boa Vista e Estado
96,Amapá,Macapá e Estado
97,Amazonas,Interior
98,Maranhão,São Luís e região
99,Maranhão,Interior
```

---

## 📲 Integração com WhatsApp (Evolution API / n8n)

A Evolution API usa o formato E.164 **sem o `+`** — apenas os dígitos:

```
Celular São Paulo:   5511987654321   (13 dígitos)
Fixo Rio de Janeiro: 552134567890    (12 dígitos)
```

### Validação antes de enviar mensagem pelo n8n

```javascript
// Use o nó Code antes do nó HTTP Request para a Evolution API
const tel = $json.telefone_e164; // gerado pelo code anterior

if (!tel || (tel.length !== 13 && tel.length !== 12)) {
  throw new Error(`Número inválido para WhatsApp: ${tel}`);
}

// Apenas celulares para WhatsApp (13 dígitos)
if (tel.length !== 13) {
  throw new Error(`WhatsApp requer celular (13 dígitos). Recebido: ${tel.length}`);
}

return { numero_whatsapp: tel };
```

---

## 📚 Referências

- [Anatel — Nono Dígito (gov.br)](https://www.gov.br/anatel/pt-br/regulado/numeracao/nono-digito)
- [Anatel — Resolução nº 553/2010](https://www.anatel.gov.br/Portal/verificaDocumentos/documento.asp?numeroPublicacao=325314)
- [Portal do Consumidor — Perguntas Frequentes sobre o Nono Dígito](http://www.anatel.gov.br/consumidor/index.php/perguntas-frequentes)
- [Tecnoblog — Anatel propõe mudar regras de numeração (2023)](https://tecnoblog.net/noticias/anatel-propoe-mudar-regras-de-numeracao-de-telefones/)
- [CEP e DDD](https://www.cepddd.com.br/ddd/)
- [Formato E.164 — ITU-T](https://www.itu.int/rec/T-REC-E.164/)

---

<div align="center">

*Documentação mantida com foco em uso real em sistemas de automação e validação de leads.*

</div>
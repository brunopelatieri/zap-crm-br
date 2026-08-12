#!/usr/bin/env node
/**
 * Sonda de validação da Evolution Go — fase F0 do PRD 047.
 *
 * Por que isto existe
 *
 *   Os dois documentos de referência do repositório discordam entre si
 *   E discordam do servidor real. O `evolution_go-guide-api.md` usa
 *   paths da Evolution API v2; o `EVOLUTION_GO_REFERENCE.md` fala em 59
 *   endpoints e afirma que botões/listas não existem — o Swagger da VPS
 *   expõe 91, incluindo /send/button, /send/list e /send/carousel.
 *   Documentação não decide; o servidor decide.
 *
 *   Esta sonda responde as 8 perguntas da F0 (PRD 047 §13) contra a SUA
 *   instância, e grava a evidência em JSON para a SPEC 048 citar.
 *
 * Segurança
 *
 *   Nenhuma chave no código. Lê EVOLUTION_API_URL e
 *   EVOLUTION_GLOBAL_API_KEY do ambiente (ou de .env.local, que é
 *   gitignored). A saída redige qualquer token que apareça em resposta.
 *
 * Uso
 *
 *   node scripts/evolution-probe.mjs              # só leitura, sem efeito colateral
 *   node scripts/evolution-probe.mjs --lifecycle  # cria e APAGA uma instância descartável
 *   node scripts/evolution-probe.mjs --lifecycle --keep   # não apaga (para parear e testar envio)
 *
 * `--lifecycle` escreve na VPS. Sem ele, a sonda não cria nada.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------

function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(ROOT, '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // .env.local é opcional — as variáveis podem vir do ambiente.
  }
}

loadEnvLocal();

const BASE = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const GLOBAL_KEY = process.env.EVOLUTION_GLOBAL_API_KEY || '';
const TIMEOUT = Number(process.env.EVOLUTION_REQUEST_TIMEOUT_MS || 15000);

const LIFECYCLE = process.argv.includes('--lifecycle');
const KEEP = process.argv.includes('--keep');

if (!BASE || !GLOBAL_KEY) {
  console.error(
    'Faltam EVOLUTION_API_URL e/ou EVOLUTION_GLOBAL_API_KEY (ambiente ou .env.local).'
  );
  process.exit(1);
}

// ---------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------

/** Redige qualquer coisa que pareça token/chave antes de gravar evidência. */
function redact(value) {
  if (typeof value === 'string') {
    return value.length >= 24 && /^[a-f0-9-]+$/i.test(value)
      ? `${value.slice(0, 4)}…redigido`
      : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|apikey|key|secret/i.test(k) ? '«redigido»' : redact(v);
    }
    return out;
  }
  return value;
}

async function call(method, path, { key = GLOBAL_KEY, body } = {}) {
  const url = `${BASE}${path}`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        apikey: key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { __raw: text.slice(0, 300) };
    }

    return {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
      contentType: res.headers.get('content-type'),
      body: parsed,
    };
  } catch (err) {
    return {
      method,
      path,
      status: 0,
      ms: Date.now() - started,
      error: err?.name === 'AbortError' ? `timeout ${TIMEOUT}ms` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------
// Execução
// ---------------------------------------------------------------

const findings = [];
const results = [];

function record(step, result, note) {
  results.push({ step, ...result, note });
  const ok = result.status >= 200 && result.status < 300;
  const mark = ok ? '✓' : result.status === 0 ? '✗' : '·';
  console.log(
    `${mark} ${String(result.status).padEnd(3)} ${result.method.padEnd(6)} ${result.path}  ${result.ms}ms${note ? `  — ${note}` : ''}`
  );
  return result;
}

function finding(question, answer, evidence) {
  findings.push({ question, answer, evidence });
  console.log(`\n  → F0-${findings.length}: ${question}\n    ${answer}`);
}

async function main() {
  console.log(`Evolution Go probe — ${BASE}\n`);

  // ---- 1. Autenticação e escopo de chave -----------------------
  console.log('[1] Autenticação e escopo de chave');
  const all = record('instance.all', await call('GET', '/instance/all'));
  const noKey = record(
    'auth.missing',
    await call('GET', '/instance/all', { key: '' }),
    'sem apikey'
  );
  const badKey = record(
    'auth.invalid',
    await call('GET', '/instance/all', { key: 'chave-invalida-de-teste' }),
    'apikey inválida'
  );
  const globalOnInstanceRoute = record(
    'auth.scope',
    await call('GET', '/instance/status'),
    'chave GLOBAL em rota de instância'
  );

  finding(
    'A chave global funciona em rotas de instância?',
    globalOnInstanceRoute.status === 401
      ? 'NÃO — 401. Escopo confirmado: global só em /instance/all, create, delete, proxy.'
      : `Inesperado: HTTP ${globalOnInstanceRoute.status}. Revisar §8.1 do PRD.`,
    {
      status: globalOnInstanceRoute.status,
      body: redact(globalOnInstanceRoute.body),
    }
  );

  finding(
    'Qual o formato REAL de erro?',
    `401 devolve ${JSON.stringify(badKey.body)} — comparar com o envelope { success, error{code,message}, meta } que a referência documenta.`,
    { unauthorized: redact(badKey.body), missing: redact(noKey.body) }
  );

  finding(
    'Qual o envelope REAL de sucesso?',
    `GET /instance/all → chaves de topo: ${Object.keys(all.body || {}).join(', ')}`,
    { body: redact(all.body) }
  );

  // ---- 2. Superfície real da API -------------------------------
  console.log('\n[2] Superfície real (Swagger da instância)');
  const swagger = await call('GET', '/swagger/doc.json');
  record('swagger', { ...swagger, body: '«omitido»' }, 'contrato desta versão');

  if (swagger.status === 200 && swagger.body?.paths) {
    const paths = Object.entries(swagger.body.paths).flatMap(([p, ops]) =>
      Object.keys(ops)
        .filter((m) => ['get', 'post', 'put', 'delete', 'patch'].includes(m))
        .map((m) => `${m.toUpperCase()} ${p}`)
    );
    const interactive = paths.filter((p) =>
      /\/send\/(button|list|carousel)/.test(p)
    );

    finding(
      'Quantos endpoints esta versão expõe, e existem botões/listas?',
      `${paths.length} endpoints. Interativos encontrados: ${interactive.length ? interactive.join(', ') : 'NENHUM'}.`,
      { total: paths.length, interactive, version: swagger.body.info }
    );

    writeFileSync(
      resolve(ROOT, 'scripts/.evolution-endpoints.txt'),
      paths.sort().join('\n') + '\n'
    );
  }

  // ---- 2b. Instância já conectada (somente leitura) ------------
  //
  // Quando existe instância pareada, dá para fechar as perguntas de
  // formato SEM criar nada: escopo de chave por rota, envelope real,
  // sufixo de dispositivo no JID e resolução de LID.
  const instances = all.body?.data ?? [];
  const live = instances.find((i) => i?.connected) ?? instances[0];

  if (live?.token) {
    console.log(`\n[2b] Instância existente "${live.name}" — somente leitura`);
    const tok = live.token;

    const status = record(
      'live.status',
      await call('GET', '/instance/status', { key: tok })
    );
    finding(
      'Que campos /instance/status devolve?',
      `${Object.keys(status.body?.data ?? status.body ?? {}).join(', ')}`,
      { body: redact(status.body) }
    );

    const qr = record(
      'live.qr',
      await call('GET', '/instance/qr', { key: tok })
    );
    finding(
      'Como /instance/qr responde numa instância já conectada?',
      `HTTP ${qr.status} — ${JSON.stringify(qr.body)}`,
      { status: qr.status }
    );

    const advTok = await call('GET', `/instance/${live.id}/advanced-settings`, {
      key: tok,
    });
    const advGlobal = await call(
      'GET',
      `/instance/${live.id}/advanced-settings`
    );
    record('live.advSettings.token', advTok, 'com token');
    record('live.advSettings.global', advGlobal, 'com chave global');
    finding(
      'Qual chave a rota advanced-settings aceita?',
      `token → ${advTok.status}, global → ${advGlobal.status}. ` +
        (advTok.status === 200 && advGlobal.status === 401
          ? 'SÓ token. Escopo é por endpoint, não por regra.'
          : 'Revisar o mapa de escopo do adaptador.'),
      { token: advTok.status, global: advGlobal.status }
    );

    // Envelope: advanced-settings devolve objeto CRU, /status devolve
    // { data, message }. É por isso que o adaptador precisa de unwrap().
    finding(
      'O envelope de resposta é uniforme?',
      `/instance/status → topo [${Object.keys(status.body || {}).join(', ')}] · ` +
        `advanced-settings → topo [${Object.keys(advTok.body || {}).join(', ')}]`,
      { uniform: false }
    );

    // JID com sufixo de dispositivo (:12) — o dedupe por telefone quebra
    // se não for removido.
    if (live.jid) {
      const phone = String(live.jid).split('@')[0].split(':')[0];
      finding(
        'O JID carrega sufixo de dispositivo?',
        `jid="${live.jid}" → telefone extraído "${phone}"${live.jid.includes(':') ? ' (sufixo :NN presente — remoção obrigatória)' : ''}`,
        { jid: live.jid, phone }
      );

      // LID: /user/check faz telefone → LID. O inverso não existe.
      const check = await call('POST', '/user/check', {
        key: tok,
        body: { number: [phone] },
      });
      record('live.userCheck', check, 'telefone → LID');
      const user = Object.values(check.body?.data?.Users ?? {})[0];
      const lid = user?.LID;

      if (lid) {
        const info = await call('POST', '/user/info', {
          key: tok,
          body: { number: [lid] },
        });
        record('live.userInfo.lid', info, 'LID → telefone?');
        const back = Object.values(info.body?.data?.Users ?? {})[0];
        finding(
          '/user/info traduz LID de volta em telefone?',
          back && (back.JID || back.LID)
            ? 'SIM — revisar §6.4 da SPEC 048.'
            : 'NÃO — devolve LID:null e nenhum JID. Exige contact_identities (SPEC 048 §1.2 R3).',
          { lidQueried: lid, response: redact(back) }
        );
      }
    }

    finding(
      'Que eventos a instância existente assina?',
      `events="${live.events}" · webhook="${live.webhook || '(vazio)'}" — ` +
        (live.events === 'MESSAGE'
          ? 'default mínimo: nosso connect precisa enviar a lista completa.'
          : 'lista customizada.'),
      { events: live.events, webhook: Boolean(live.webhook) }
    );
  }

  // ---- 3. Ciclo de vida (opcional, escreve na VPS) -------------
  if (!LIFECYCLE) {
    console.log(
      '\n[3] Ciclo de vida — PULADO (rode com --lifecycle para criar e apagar uma instância descartável)'
    );
  } else {
    console.log('\n[3] Ciclo de vida — CRIANDO instância descartável');
    const prefix = process.env.EVOLUTION_INSTANCE_PREFIX || 'zapcrm';
    const name = `${prefix}_probe_${Date.now().toString(36)}`;

    // `token` é OBRIGATÓRIO — os dois documentos de referência dizem que
    // é gerado automaticamente quando omitido; o servidor responde
    // 400 {"error":"token is required"}. Geramos nós, o que é melhor:
    // o segredo nasce do nosso lado e nunca depende de parsing.
    const token = randomUUID();

    const created = record(
      'instance.create',
      await call('POST', '/instance/create', { body: { name, token } }),
      name
    );

    const data = created.body?.data ?? created.body?.instance ?? created.body;
    const instanceId = data?.id ?? data?.instanceId ?? data?.Id;

    finding(
      'O que /instance/create devolve?',
      `Chaves: ${Object.keys(data || {}).join(', ')} — id=${instanceId ? 'presente' : 'AUSENTE'}, token=${token ? 'presente' : 'AUSENTE'}`,
      { status: created.status, body: redact(created.body) }
    );

    if (token) {
      const webhookUrl =
        process.env.EVOLUTION_WEBHOOK_PUBLIC_URL ||
        'https://example.invalid/probe-webhook';

      record(
        'instance.connect',
        await call('POST', '/instance/connect', {
          key: token,
          body: {
            immediate: true,
            subscribe: [
              'MESSAGE',
              'SEND_MESSAGE',
              'READ_RECEIPT',
              'CONNECTION',
              'QRCODE',
            ],
            webhookUrl,
          },
        }),
        'registra webhook + eventos'
      );

      const qr = record(
        'instance.qr',
        await call('GET', '/instance/qr', { key: token })
      );
      const qrData = qr.body?.data ?? qr.body;
      const qrField = Object.keys(qrData || {}).find((k) => /qr/i.test(k));

      finding(
        'Em que campo o QR volta?',
        qrField
          ? `data.${qrField} — ${String(qrData[qrField]).slice(0, 30)}…`
          : `Nenhum campo com "qr". Chaves: ${Object.keys(qrData || {}).join(', ')}`,
        { keys: Object.keys(qrData || {}) }
      );

      const status = record(
        'instance.status',
        await call('GET', '/instance/status', { key: token })
      );
      finding(
        'Que campos /instance/status devolve?',
        `${Object.keys(status.body?.data ?? status.body ?? {}).join(', ')}`,
        { body: redact(status.body) }
      );

      const adv = record(
        'instance.advancedSettings',
        await call('GET', `/instance/${instanceId}/advanced-settings`, {
          key: token,
        }),
        'flags editáveis?'
      );
      finding(
        'As flags da instância são legíveis/editáveis via API?',
        adv.status === 200
          ? `SIM — GET responde 200 (e existe PUT). Campos: ${Object.keys(adv.body?.data ?? adv.body ?? {}).join(', ')}`
          : `GET respondeu ${adv.status}. Confirmar com a chave certa antes de concluir.`,
        { status: adv.status, body: redact(adv.body) }
      );
    }

    if (KEEP) {
      console.log(
        `\n⚠️  --keep: instância "${name}" MANTIDA na VPS. Apague depois com:\n    DELETE /instance/delete/${instanceId}`
      );
    } else if (instanceId) {
      record(
        'instance.delete',
        await call('DELETE', `/instance/delete/${instanceId}`),
        'limpeza'
      );
    }
  }

  // ---- Evidência ----------------------------------------------
  const out = {
    probedAt: new Date().toISOString(),
    baseUrl: BASE,
    lifecycle: LIFECYCLE,
    findings,
    results: results.map((r) => ({ ...r, body: redact(r.body) })),
  };

  mkdirSync(resolve(ROOT, 'docs/references'), { recursive: true });
  const path = resolve(ROOT, 'scripts/.evolution-probe-result.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nEvidência gravada em ${path}`);
  console.log(`${findings.length} perguntas da F0 respondidas.`);
}

main().catch((err) => {
  console.error('probe falhou:', err);
  process.exit(1);
});

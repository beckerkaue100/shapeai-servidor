const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ RATE LIMITING SIMPLES ============
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 10 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const agora = Date.now();
  const registro = rateMap.get(ip) || { count: 0, inicio: agora };

  if (agora - registro.inicio > RATE_WINDOW) {
    registro.count = 0;
    registro.inicio = agora;
  }

  registro.count++;
  rateMap.set(ip, registro);

  if (rateMap.size > 500) {
    for (const [key, val] of rateMap.entries()) {
      if (agora - val.inicio > RATE_WINDOW) rateMap.delete(key);
    }
  }

  if (registro.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde alguns minutos e tente novamente.' });
  }

  next();
}

// CORS: só o app oficial pode chamar a API pelo navegador.
// Para trocar de domínio no futuro, defina ALLOWED_ORIGINS no Railway (separado por vírgula).
const ORIGENS_PERMITIDAS = (process.env.ALLOWED_ORIGINS || 'https://app-two-sigma-57.vercel.app').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Sem origin = requisição servidor-a-servidor (ex.: webhook do Mercado Pago) → permite
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(express.json({ limit: '10mb' }));
// ============ AUTENTICAÇÃO (valida token do Supabase) ============
// Garante que só usuários logados de verdade usem a IA (protege os créditos da Anthropic).
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Acesso negado: faça login para usar a IA.' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Validação de login não configurada no servidor.' });
  }
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    if (!r.ok) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
    }
    const user = await r.json();
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Sessão inválida.' });
    }
    req.user = user; // disponível para uso futuro (ex: cobrança por uso)
    next();
  } catch (e) {
    console.error('Erro ao validar sessão:', e);
    return res.status(401).json({ error: 'Falha ao validar sua sessão.' });
  }
}

app.use('/api/claude', rateLimit, requireAuth);

// ============ ROTA CLAUDE ============
app.post('/api/claude', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API Key não configurada no servidor.' });
  }

  const modelosPermitidos = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'];
  if (req.body.model && !modelosPermitidos.includes(req.body.model)) {
    return res.status(400).json({ error: 'Modelo não autorizado.' });
  }

  if (req.body.max_tokens && req.body.max_tokens > 2000) {
    req.body.max_tokens = 2000;
  }

  try {
    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const dados = await resposta.json();

    // Se a Anthropic devolveu erro, repassa o status e a mensagem real (não mascarar como 200)
    if (!resposta.ok || dados.type === 'error') {
      console.error('Erro da Anthropic:', resposta.status, JSON.stringify(dados));
      return res.status(resposta.status || 502).json({
        error: dados.error?.message || 'Erro ao processar com a IA.',
        anthropic: dados.error || dados
      });
    }

    res.json(dados);

  } catch (erro) {
    console.error('Erro ao chamar Claude:', erro);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ============ PLANOS ============
// O preço NUNCA vem do navegador — é definido aqui no servidor.
const PLANOS = {
  mensal: {
    id: 'mensal',
    reason: 'ShapeAI — Mensal',
    valor: 29.90,
    frequency: 1,
    frequency_type: 'months',
    fundador: false
  },
  anual_fundador: {
    id: 'anual_fundador',
    reason: 'ShapeAI — Anual (Preço de Fundador)',
    valor: 149.00,
    frequency: 12,
    frequency_type: 'months',
    fundador: true
  }
};
const VAGAS_FUNDADOR = 100;

// Quantas vagas de fundador já foram ocupadas (conta assinaturas fundador confirmadas)
async function contarFundadores() {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/assinaturas?fundador=eq.true&ativa=eq.true&select=user_id`,
    { headers: { ...SB_HEADERS(), 'Prefer': 'count=exact' } }
  );
  const lista = await r.json();
  return Array.isArray(lista) ? lista.length : 0;
}

// O app consulta isso para mostrar "restam X de 100 vagas" (contador REAL — exigência do CDC)
app.get('/api/fundador/vagas', async (req, res) => {
  try {
    const ocupadas = await contarFundadores();
    const restantes = Math.max(0, VAGAS_FUNDADOR - ocupadas);
    res.json({ total: VAGAS_FUNDADOR, ocupadas, restantes, aberto: restantes > 0 });
  } catch (e) {
    console.error('Erro ao contar vagas de fundador:', e);
    res.json({ total: VAGAS_FUNDADOR, ocupadas: 0, restantes: VAGAS_FUNDADOR, aberto: true });
  }
});

// ============ MERCADO PAGO — CRIAR ASSINATURA ============
app.post('/api/assinatura/criar', rateLimit, requireAuth, async (req, res) => {
  // Identidade vem da sessão validada (não confiamos no corpo da requisição)
  const user_id = req.user.id;
  const email = req.user.email;

  if (!user_id || !email) {
    return res.status(400).json({ error: 'Sessão sem e-mail válido.' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Mercado Pago não configurado.' });
  }

  const plano = PLANOS[req.body.plano] || PLANOS.mensal;

  try {
    // Vaga de fundador: se acabou, cai no mensal (nunca vende mais de 100 — a escassez é real)
    if (plano.fundador) {
      const ocupadas = await contarFundadores();
      if (ocupadas >= VAGAS_FUNDADOR) {
        return res.status(409).json({
          error: 'As 100 vagas de fundador acabaram. Escolha o plano mensal.',
          vagas_esgotadas: true
        });
      }
    }

    // Cria a assinatura (preapproval) com status pending → retorna init_point
    // para o usuário inserir o cartão no checkout hospedado do Mercado Pago.
    const resAssinatura = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        reason: plano.reason,
        external_reference: `${user_id}|${plano.id}`,
        payer_email: email,
        auto_recurring: {
          frequency: plano.frequency,
          frequency_type: plano.frequency_type,
          transaction_amount: plano.valor,
          currency_id: 'BRL'
        },
        back_url: 'https://app-two-sigma-57.vercel.app',
        status: 'pending'
      })
    });

    const dadosAssinatura = await resAssinatura.json();

    if (dadosAssinatura.init_point) {
      res.json({
        checkout_url: dadosAssinatura.init_point,
        assinatura_id: dadosAssinatura.id,
        plano: plano.id
      });
    } else {
      console.error('Erro MP criar assinatura:', dadosAssinatura);
      res.status(500).json({ error: 'Erro ao gerar link de pagamento.' });
    }

  } catch (erro) {
    console.error('Erro criar assinatura:', erro);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ============ MERCADO PAGO — WEBHOOK (notificação de pagamento) ============
// Valida a assinatura HMAC que o Mercado Pago envia (header x-signature).
// Só bloqueia se MP_WEBHOOK_SECRET estiver configurado no Railway.
function webhookAssinaturaValida(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sem secret configurado, não bloqueia (mas loga aviso)
  try {
    const sig = req.headers['x-signature'] || '';
    const partes = Object.fromEntries(sig.split(',').map(p => p.trim().split('=')));
    const ts = partes.ts, v1 = partes.v1;
    if (!ts || !v1) return false;
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
    const requestId = req.headers['x-request-id'] || '';
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const esperado = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(v1));
  } catch (e) {
    return false;
  }
}

app.post('/api/webhook/mp', async (req, res) => {
  if (!process.env.MP_WEBHOOK_SECRET) console.warn('MP_WEBHOOK_SECRET não configurado — webhook sem validação de assinatura.');
  if (!webhookAssinaturaValida(req)) {
    console.warn('Webhook MP com assinatura inválida — ignorado.');
    return res.sendStatus(401);
  }

  // Responde 200 imediatamente para o MP não retentar
  res.sendStatus(200);

  const { type, data } = req.body;
  console.log('Webhook MP recebido:', type, data?.id);

  if (type !== 'preapproval' || !data?.id) return;

  try {
    // Busca detalhes da assinatura no MP
    const resMP = await fetch(`https://api.mercadopago.com/preapproval/${data.id}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const assinatura = await resMP.json();

    // external_reference agora é "user_id|plano" (formato antigo, só user_id, ainda funciona)
    const ref = String(assinatura.external_reference || '');
    const [user_id, planoRef] = ref.split('|');
    const status = assinatura.status; // authorized, paused, cancelled

    if (!user_id) return;

    const plano = PLANOS[planoRef] || PLANOS.mensal;
    const ativa = status === 'authorized';

    // Validade acompanha o plano: mensal = +35 dias · anual = +1 ano e 5 dias (folga pra renovação)
    const diasValidade = plano.frequency_type === 'months' && plano.frequency >= 12 ? 370 : 35;
    const validade = ativa
      ? new Date(Date.now() + diasValidade * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : null;

    // Vaga de fundador só é marcada se AINDA houver vaga no momento da confirmação
    let ehFundador = false;
    if (ativa && plano.fundador) {
      const ocupadas = await contarFundadores();
      ehFundador = ocupadas < VAGAS_FUNDADOR;
      if (!ehFundador) console.warn(`Vagas de fundador esgotadas — user=${user_id} pagou anual mas entra sem selo.`);
    }

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id,
        ativa,
        validade,
        plano: plano.id,
        fundador: ehFundador,
        preco_pago: ativa ? plano.valor : null,
        mp_assinatura_id: data.id,
        status_mp: status,
        updated_at: new Date().toISOString()
      })
    });

    console.log(`Assinatura atualizada: user=${user_id} plano=${plano.id} status=${status} ativa=${ativa} fundador=${ehFundador}`);

    // ===== RECOMPENSA DE INDICAÇÃO =====
    // Se este usuário foi INDICADO por alguém e acabou de assinar, dá +30 dias grátis a quem indicou.
    if (ativa) {
      await recompensarIndicacao(user_id);
    } else {
      // Cancelou/pausou: se foi indicado e o bônus é recente, estorna (antifraude do arrependimento)
      await estornarIndicacaoSeRecente(user_id);
    }

  } catch (erro) {
    console.error('Erro no webhook:', erro);
  }
});

const SB_HEADERS = () => ({
  'Content-Type': 'application/json',
  'apikey': process.env.SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
});

// ============ INDICAÇÃO — RECOMPENSA COM ANTIFRAUDE ============
const MAX_RECOMPENSAS_INDICACAO = 10; // teto por indicador (300 dias) — trava fraude em escala

async function recompensarIndicacao(referred_id) {
  try {
    // Busca indicação ainda não recompensada para este indicado
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?referred_id=eq.${referred_id}&recompensado=eq.false&select=id,referrer_id`, {
      headers: SB_HEADERS()
    });
    const lista = await r.json();
    if (!Array.isArray(lista) || !lista.length) return;

    const indic = lista[0];
    const referrer_id = indic.referrer_id;

    // ANTIFRAUDE 1 — auto-indicação: ninguém indica a si mesmo
    if (!referrer_id || referrer_id === referred_id) {
      console.warn(`Antifraude: auto-indicação bloqueada (user=${referred_id}).`);
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?id=eq.${indic.id}`, {
        method: 'PATCH', headers: SB_HEADERS(),
        body: JSON.stringify({ assinou: true, recompensado: true, estornado: true })
      });
      return;
    }

    // ANTIFRAUDE 2 — teto de recompensas por indicador (impede fábrica de contas falsas)
    const rc = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/indicacoes?referrer_id=eq.${referrer_id}&recompensado=eq.true&estornado=eq.false&select=id`,
      { headers: SB_HEADERS() }
    );
    const jaGanhou = await rc.json();
    if (Array.isArray(jaGanhou) && jaGanhou.length >= MAX_RECOMPENSAS_INDICACAO) {
      console.warn(`Antifraude: teto de ${MAX_RECOMPENSAS_INDICACAO} recompensas atingido (referrer=${referrer_id}).`);
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?id=eq.${indic.id}`, {
        method: 'PATCH', headers: SB_HEADERS(),
        body: JSON.stringify({ assinou: true, recompensado: true, estornado: true })
      });
      return;
    }

    // Lê a assinatura atual do indicador para estender a validade
    const ra = await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas?user_id=eq.${referrer_id}&select=validade`, {
      headers: SB_HEADERS()
    });
    const asg = await ra.json();
    const base = (Array.isArray(asg) && asg[0] && asg[0].validade && new Date(asg[0].validade) > new Date())
      ? new Date(asg[0].validade)
      : new Date();
    const novaValidade = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Concede +30 dias ao indicador (mantém ativo)
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas`, {
      method: 'POST',
      headers: { ...SB_HEADERS(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: referrer_id, ativa: true, validade: novaValidade, status_mp: 'recompensa_indicacao', updated_at: new Date().toISOString() })
    });

    // Marca a indicação como recompensada e que o indicado assinou
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?id=eq.${indic.id}`, {
      method: 'PATCH',
      headers: SB_HEADERS(),
      body: JSON.stringify({ assinou: true, recompensado: true, recompensado_em: new Date().toISOString() })
    });

    console.log(`Recompensa de indicação: referrer=${referrer_id} ganhou +30 dias (até ${novaValidade})`);
  } catch (e) {
    console.error('Erro ao recompensar indicação:', e);
  }
}

// ANTIFRAUDE 3 — se o INDICADO cancelar/pedir reembolso logo (≤35 dias), estorna os 30 dias do indicador.
// Fecha o golpe: assinar, gerar o bônus e cancelar dentro do prazo de arrependimento (7 dias, CDC).
async function estornarIndicacaoSeRecente(referred_id) {
  try {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/indicacoes?referred_id=eq.${referred_id}&recompensado=eq.true&estornado=eq.false&select=id,referrer_id,recompensado_em`,
      { headers: SB_HEADERS() }
    );
    const lista = await r.json();
    if (!Array.isArray(lista) || !lista.length) return;

    const indic = lista[0];
    const quando = indic.recompensado_em ? new Date(indic.recompensado_em) : null;
    if (!quando) return;
    const dias = (Date.now() - quando.getTime()) / (24 * 60 * 60 * 1000);
    if (dias > 35) return; // já consolidou — o indicado pagou de verdade, o bônus é legítimo

    // Tira os 30 dias que haviam sido concedidos ao indicador
    const ra = await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas?user_id=eq.${indic.referrer_id}&select=validade`, {
      headers: SB_HEADERS()
    });
    const asg = await ra.json();
    if (Array.isArray(asg) && asg[0] && asg[0].validade) {
      const nova = new Date(new Date(asg[0].validade).getTime() - 30 * 24 * 60 * 60 * 1000);
      const aindaVale = nova > new Date();
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas?user_id=eq.${indic.referrer_id}`, {
        method: 'PATCH', headers: SB_HEADERS(),
        body: JSON.stringify({
          validade: nova.toISOString().split('T')[0],
          ativa: aindaVale,
          updated_at: new Date().toISOString()
        })
      });
    }

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?id=eq.${indic.id}`, {
      method: 'PATCH', headers: SB_HEADERS(),
      body: JSON.stringify({ estornado: true })
    });

    console.warn(`Antifraude: bônus estornado — indicado ${referred_id} cancelou em ${Math.round(dias)} dias (referrer=${indic.referrer_id}).`);
  } catch (e) {
    console.error('Erro ao estornar indicação:', e);
  }
}

// ============ EXCLUIR CONTA (LGPD) ============
// Apaga todos os dados do usuário e o próprio login. Exige token válido.
app.post('/api/conta/excluir', rateLimit, requireAuth, async (req, res) => {
  const uid = req.user && req.user.id;
  if (!uid) return res.status(400).json({ error: 'Usuário inválido.' });
  const tabelas = ['meta_macros','meta_agua','alimentos_dia','agua_log','peso_log','historico','treino_atual','cargas_log','dias_ativos','perfil','cardapio_atual','assinaturas','medidas'];
  try {
    // apaga linhas de cada tabela (best-effort, ignora tabela inexistente)
    for (const t of tabelas) {
      try { await fetch(`${process.env.SUPABASE_URL}/rest/v1/${t}?user_id=eq.${uid}`, { method: 'DELETE', headers: SB_HEADERS() }); } catch (_) {}
    }
    // indicações: apaga as que o usuário fez e as que recebeu
    try { await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?referrer_id=eq.${uid}`, { method: 'DELETE', headers: SB_HEADERS() }); } catch (_) {}
    try { await fetch(`${process.env.SUPABASE_URL}/rest/v1/indicacoes?referred_id=eq.${uid}`, { method: 'DELETE', headers: SB_HEADERS() }); } catch (_) {}
    // fotos de progresso no Storage (LGPD: apagar tudo que é do usuário)
    try {
      const rl = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/list/progresso`, {
        method: 'POST', headers: SB_HEADERS(),
        body: JSON.stringify({ prefix: uid, limit: 1000 })
      });
      const arquivos = await rl.json();
      if (Array.isArray(arquivos) && arquivos.length) {
        await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/progresso`, {
          method: 'DELETE', headers: SB_HEADERS(),
          body: JSON.stringify({ prefixes: arquivos.map(f => `${uid}/${f.name}`) })
        });
      }
    } catch (_) {}
    // por fim, apaga o usuário do Auth (login)
    const del = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: SB_HEADERS() });
    if (!del.ok) { const e = await del.text(); console.error('Erro ao apagar auth user:', e); }
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao excluir conta:', e);
    res.status(500).json({ error: 'Erro ao excluir a conta.' });
  }
});

// ============ ROTA DE TESTE ============
app.get('/', (req, res) => {
  res.json({ status: 'ShapeAI servidor rodando!', versao: '1.6' });
});

app.listen(PORT, () => {
  console.log(`Servidor ShapeAI rodando na porta ${PORT}`);
});

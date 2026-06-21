const express = require('express');
const cors = require('cors');

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

app.use(cors());
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

// ============ MERCADO PAGO — CRIAR ASSINATURA ============
app.post('/api/assinatura/criar', async (req, res) => {
  const { user_id, email, nome } = req.body;

  if (!user_id || !email) {
    return res.status(400).json({ error: 'user_id e email são obrigatórios.' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Mercado Pago não configurado.' });
  }

  try {
    // Cria a assinatura (preapproval) com status pending → retorna init_point
    // para o usuário inserir o cartão no checkout hospedado do Mercado Pago.
    const resAssinatura = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        reason: 'ShapeAI — Treino & Nutrição com IA',
        external_reference: user_id,
        payer_email: email,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: 29.90,
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
        assinatura_id: dadosAssinatura.id
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
app.post('/api/webhook/mp', async (req, res) => {
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

    const user_id = assinatura.external_reference;
    const status = assinatura.status; // authorized, paused, cancelled

    if (!user_id) return;

    // Atualiza status no Supabase via REST API
    const ativa = status === 'authorized';
    const validade = ativa
      ? new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // +35 dias
      : null;

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
        mp_assinatura_id: data.id,
        status_mp: status,
        updated_at: new Date().toISOString()
      })
    });

    console.log(`Assinatura atualizada: user=${user_id} status=${status} ativa=${ativa}`);

  } catch (erro) {
    console.error('Erro no webhook:', erro);
  }
});

// ============ ROTA DE TESTE ============
app.get('/', (req, res) => {
  res.json({ status: 'ShapeAI servidor rodando!', versao: '1.2' });
});

app.listen(PORT, () => {
  console.log(`Servidor ShapeAI rodando na porta ${PORT}`);
});

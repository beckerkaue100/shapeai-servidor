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
// No escopo do módulo pra também aparecer no endpoint de status (serve pra conferir de fora
// se o deploy do Railway já subiu). Só o servidor decide quais modelos podem ser chamados.
const modelosPermitidos = ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'];

app.post('/api/claude', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API Key não configurada no servidor.' });
  }

  if (req.body.model && !modelosPermitidos.includes(req.body.model)) {
    return res.status(400).json({ error: 'Modelo não autorizado.' });
  }

  // 4000: a análise de foto raciocina antes de montar o JSON e, em prato com muitos itens,
  // 2000 cortava a resposta no meio (JSON inválido). max_tokens é TETO, não custo fixo —
  // só é cobrado o que o modelo realmente gerar.
  if (req.body.max_tokens && req.body.max_tokens > 4000) {
    req.body.max_tokens = 4000;
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
  anual_promo: {
    id: 'anual_promo',
    reason: 'ShapeAI — Anual (Oferta de Lançamento)',
    valor: 149.00,
    frequency: 12,
    frequency_type: 'months',
    promo: true
  }
};
// Checkouts criados antes da troca de nome ainda chegam como 'anual_fundador'.
PLANOS.anual_fundador = PLANOS.anual_promo;

// ============ OFERTA POR TEMPO LIMITADO ============
// Data (YYYY-MM-DD, horário de Brasília) em que a oferta anual promocional fecha.
// Depois dela o servidor RECUSA o plano — a escassez precisa ser real, senão é
// só um cartaz que nunca cai. Para estender ou encerrar antes, basta mudar a
// variável OFERTA_ATE no Railway: não precisa de deploy.
const OFERTA_ATE = (process.env.OFERTA_ATE || '2026-09-30').trim();

const APP_URL      = process.env.APP_URL      || 'https://app-two-sigma-57.vercel.app';
const SERVIDOR_URL = process.env.SERVIDOR_URL || 'https://shapeai-servidor-production.up.railway.app';

// Quantos dias um pagamento AVULSO libera. Recorrência quem controla é o MP;
// aqui somos nós, então o período é exatamente o do plano.
// Dias de teste grátis que a pessoa ainda não usou. Quem assina no dia 2 de um
// teste de 14 não pode perder os 12 que sobraram: a tela de planos aparece
// DURANTE o teste, então pagar cedo não pode sair pior do que esperar.
function diasDeTrialSobrando(trial_fim, hoje) {
  if (!trial_fim || trial_fim <= hoje) return 0;
  const ms = new Date(trial_fim + 'T12:00:00-03:00') - new Date(hoje + 'T12:00:00-03:00');
  return Math.max(0, Math.round(ms / 86400000));
}

function diasDoPlano(plano) {
  return (plano.frequency_type === 'months' && plano.frequency >= 12) ? 365 : 30;
}

function hojeBR() {
  // -03:00 — senão, entre 21h e meia-noite, o servidor já acha que é amanhã
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().split('T')[0];
}
function diasAteFim() {
  const ms = new Date(OFERTA_ATE + 'T23:59:59-03:00').getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}
function ofertaAberta() { return hojeBR() <= OFERTA_ATE; }

// O app consulta isso para mostrar o prazo real da oferta (nunca um número inventado)
app.get('/api/oferta', (req, res) => {
  res.json({ aberta: ofertaAberta(), ate: OFERTA_ATE, dias_restantes: diasAteFim() });
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
    // Oferta vencida: recusa de verdade. Anunciar prazo e continuar vendendo depois
    // é preço promocional falso — o mesmo problema do "de/por" que nunca existiu.
    if (plano.promo && !ofertaAberta()) {
      return res.status(409).json({
        error: 'A oferta de lançamento encerrou. Escolha o plano mensal.',
        oferta_encerrada: true
      });
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
        back_url: APP_URL,
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
// Grava/atualiza a linha de assinatura do usuário.
// on_conflict=user_id é OBRIGATÓRIO: o `resolution=merge-duplicates` do PostgREST
// resolve pela CHAVE PRIMÁRIA (aqui `id`), não pela única de `user_id`. Sem ele o
// upsert vira INSERT, bate em assinaturas_user_id_key e volta 409 — e antes esse
// 409 era engolido, então o webhook logava "atualizada" sem ter gravado nada.
async function salvarAssinatura(dados) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas?on_conflict=user_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS(), 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(dados)
  });
  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    // Dinheiro entrou e o acesso não foi liberado: isso NÃO pode passar batido.
    console.error(`FALHA AO GRAVAR ASSINATURA user=${dados.user_id} http=${r.status} ${detalhe}`);
    return false;
  }
  return true;
}

// ============ PAGAMENTO AVULSO (Pix, débito, saldo) ============
// Assinatura recorrente do MP só aceita cartão de crédito — quem não tem cartão
// não conseguia pagar de jeito nenhum. Aqui a pessoa paga UMA vez e ganha o
// período do plano; a renovação é manual, avisada dentro do app.
app.post('/api/pagamento/pix', rateLimit, requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const email = req.user.email;
  if (!user_id || !email) return res.status(400).json({ error: 'Sessão sem e-mail válido.' });
  if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Mercado Pago não configurado.' });

  const plano = PLANOS[req.body.plano] || PLANOS.mensal;

  try {
    if (plano.promo && !ofertaAberta()) {
      return res.status(409).json({ error: 'A oferta de lançamento encerrou. Escolha o plano mensal.', oferta_encerrada: true });
    }

    const dias = diasDoPlano(plano);
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify({
        items: [{
          title: `${plano.reason} — ${dias} dias`,
          quantity: 1,
          unit_price: plano.valor,
          currency_id: 'BRL'
        }],
        payer: { email },
        // o sufixo |avulso separa do fluxo de assinatura no webhook
        external_reference: `${user_id}|${plano.id}|avulso`,
        payment_methods: {
          // crédito tem o botão de assinatura, que renova sozinho — não duplicar aqui.
          // boleto fora: 3 dias pra compensar num acesso de 30 é experiência ruim.
          excluded_payment_types: [{ id: 'credit_card' }, { id: 'ticket' }],
          installments: 1
        },
        back_urls: { success: APP_URL, pending: APP_URL, failure: APP_URL },
        auto_return: 'approved',
        notification_url: `${SERVIDOR_URL}/api/webhook/mp`,
        statement_descriptor: 'SHAPEAI'
      })
    });
    const pref = await r.json();
    if (!pref.init_point) {
      console.error('Erro MP criar preferência:', pref);
      return res.status(500).json({ error: pref.message || 'Erro ao gerar pagamento' });
    }
    res.json({ checkout_url: pref.init_point, plano: plano.id, dias });
  } catch (erro) {
    console.error('Erro pagamento avulso:', erro);
    res.status(500).json({ error: 'Erro ao gerar pagamento.' });
  }
});

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

  // O MP avisa duas coisas diferentes, com nomes que variam conforme a integração:
  //   assinatura mudou de status  -> preapproval / subscription_preapproval
  //   cobrança recorrente rodou   -> authorized_payment / subscription_authorized_payment
  // Antes só a primeira era tratada, então RENOVAÇÃO NÃO ESTENDIA A VALIDADE.
  const ehAssinatura = type === 'preapproval' || type === 'subscription_preapproval';
  const ehCobranca   = type === 'authorized_payment' || type === 'subscription_authorized_payment';
  const ehAvulso     = type === 'payment';
  if ((!ehAssinatura && !ehCobranca && !ehAvulso) || !data?.id) return;

  // ---- pagamento avulso (Pix, débito, saldo): libera o período e encerra aqui ----
  if (ehAvulso) {
    try {
      const rp = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const pag = await rp.json();
      if (pag.status !== 'approved') {
        console.log(`Pagamento avulso ${data.id} status=${pag.status} — ainda não libera.`);
        return;
      }
      const [uid, planoRef, marca] = String(pag.external_reference || '').split('|');
      if (!uid || marca !== 'avulso') return;   // não é nosso fluxo avulso

      const plano = PLANOS[planoRef] || PLANOS.mensal;
      const dias = diasDoPlano(plano);

      // Nada de queimar dias já garantidos. A contagem começa do que for MAIOR:
      // hoje, a validade que já existe (renovou adiantado) ou o fim do teste
      // grátis (assinou no meio do teste).
      const ra = await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas?user_id=eq.${uid}&select=validade,trial_fim`, { headers: SB_HEADERS() });
      const atual = await ra.json();
      const linha = Array.isArray(atual) && atual[0] ? atual[0] : {};
      const validadeAtual = linha.validade || null;
      const trialFim = linha.trial_fim || null;
      const hoje = hojeBR();
      let base = hoje;
      if (validadeAtual && validadeAtual > base) base = validadeAtual;
      if (trialFim && trialFim > base) base = trialFim;
      const validade = new Date(new Date(base + 'T12:00:00-03:00').getTime() + dias * 86400000).toISOString().split('T')[0];

      const gravou = await salvarAssinatura({
        user_id: uid, ativa: true, validade, plano: plano.id,
        fundador: !!plano.promo, preco_pago: plano.valor,
        mp_assinatura_id: String(data.id), status_mp: 'pago_avulso',
        updated_at: new Date().toISOString()
      });
      if (!gravou) return;

      console.log(`Pagamento avulso OK: user=${uid} plano=${plano.id} meio=${pag.payment_method_id} +${dias}d validade=${validade}`);
      await recompensarIndicacao(uid);   // idempotente: só premia a 1ª vez
    } catch (e) {
      console.error('Erro no pagamento avulso:', e);
    }
    return;
  }

  try {
    // Na cobrança, o id é do pagamento — o da assinatura vem dentro dele.
    let preapprovalId = data.id;
    if (ehCobranca) {
      const rPag = await fetch(`https://api.mercadopago.com/authorized_payments/${data.id}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const pagamento = await rPag.json();
      preapprovalId = pagamento.preapproval_id;
      if (!preapprovalId) { console.warn('Cobrança sem preapproval_id:', data.id); return; }
    }

    // Busca detalhes da assinatura no MP (fonte da verdade nos dois casos)
    const resMP = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
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

    // Validade: quem sabe quando a próxima cobrança cai é o Mercado Pago, não eu.
    // Usar next_payment_date (com folga) faz a renovação estender sozinha e evita
    // contar dias na mão. Se o MP não mandar a data, cai no cálculo por plano.
    const FOLGA_DIAS = 5;   // margem pra falha de cobrança e retentativa do MP
    const diasValidade = plano.frequency_type === 'months' && plano.frequency >= 12 ? 370 : 35;
    let validade = null;
    if (ativa) {
      // Assinou no meio do teste? Os dias que sobraram entram como acesso a mais.
      // Nas renovações isso vale 0 sozinho: lá o trial_fim já ficou pra trás.
      const rt = await fetch(`${process.env.SUPABASE_URL}/rest/v1/assinaturas?user_id=eq.${user_id}&select=trial_fim`, { headers: SB_HEADERS() });
      const at = await rt.json().catch(() => []);
      const trialFim = Array.isArray(at) && at[0] ? at[0].trial_fim : null;
      const sobrando = diasDeTrialSobrando(trialFim, hojeBR());

      const prox = assinatura.next_payment_date ? new Date(assinatura.next_payment_date) : null;
      const base = (prox && !isNaN(prox)) ? prox.getTime() : Date.now() + diasValidade * 86400000;
      validade = new Date(base + (FOLGA_DIAS + sobrando) * 86400000).toISOString().split('T')[0];
      if (sobrando) console.log(`Assinou no meio do teste: +${sobrando}d de teste somados (user=${user_id})`);
    }

    // A coluna 'fundador' agora quer dizer: entrou pela oferta de lançamento e tem
    // o preço travado na renovação. Não há mais contagem de vagas.
    const ehPromo = !!(ativa && plano.promo);

    const gravou = await salvarAssinatura({
      user_id,
      ativa,
      validade,
      plano: plano.id,
      fundador: ehPromo,
      preco_pago: ativa ? plano.valor : null,
      mp_assinatura_id: preapprovalId,
      status_mp: status,
      updated_at: new Date().toISOString()
    });
    if (!gravou) return;   // não segue pro bônus de indicação se o acesso não foi gravado

    console.log(`Assinatura atualizada: user=${user_id} plano=${plano.id} status=${status} ativa=${ativa} promo=${ehPromo} validade=${validade} (aviso: ${type})`);

    // ===== RECOMPENSA DE INDICAÇÃO =====
    // Só na mudança de status da assinatura. Numa cobrança mensal bem-sucedida nada
    // acontece aqui: premiar de novo daria +30 dias todo mês pela mesma indicação,
    // e estornar cancelaria o bônus de quem está pagando em dia.
    if (ehAssinatura) {
      if (ativa) {
        await recompensarIndicacao(user_id);
      } else {
        // Cancelou/pausou: se foi indicado e o bônus é recente, estorna (antifraude do arrependimento)
        await estornarIndicacaoSeRecente(user_id);
      }
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
    await salvarAssinatura({ user_id: referrer_id, ativa: true, validade: novaValidade, status_mp: 'recompensa_indicacao', updated_at: new Date().toISOString() });

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
  // modelos vai na resposta de propósito: é como dá pra conferir, de fora, se o deploy
  // do Railway já pegou a versão nova (a lista muda quando liberamos um modelo novo)
  res.json({ status: 'ShapeAI servidor rodando!', versao: '1.8', modelos: modelosPermitidos });
});

app.listen(PORT, () => {
  console.log(`Servidor ShapeAI rodando na porta ${PORT}`);
});

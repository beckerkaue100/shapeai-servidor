const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ RATE LIMITING SIMPLES ============
// Máximo de 30 requisições por IP a cada 10 minutos
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 10 * 60 * 1000; // 10 minutos em ms

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const agora = Date.now();
  const registro = rateMap.get(ip) || { count: 0, inicio: agora };

  // Reinicia janela se passou o tempo
  if (agora - registro.inicio > RATE_WINDOW) {
    registro.count = 0;
    registro.inicio = agora;
  }

  registro.count++;
  rateMap.set(ip, registro);

  // Limpa entradas antigas a cada 100 requisições para não vazar memória
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

// Permite que o app (Vercel) fale com este servidor
app.use(cors());
app.use(express.json({ limit: '10mb' })); // limite maior para suportar fotos
app.use('/api/claude', rateLimit);

// Rota principal — recebe pedido do app e manda pro Claude
app.post('/api/claude', async (req, res) => {

  // Verifica se a API Key está configurada no Railway
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API Key não configurada no servidor.' });
  }

  // Bloqueia modelos não autorizados (segurança extra)
  const modelosPermitidos = ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514', 'claude-opus-4-20250514'];
  if (req.body.model && !modelosPermitidos.includes(req.body.model)) {
    return res.status(400).json({ error: 'Modelo não autorizado.' });
  }

  // Limita max_tokens para evitar custos excessivos
  if (req.body.max_tokens && req.body.max_tokens > 2000) {
    req.body.max_tokens = 2000;
  }

  try {
    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY, // chave secreta — nunca aparece no app
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body) // repassa o pedido do app para o Claude
    });

    const dados = await resposta.json();
    res.json(dados);

  } catch (erro) {
    console.error('Erro ao chamar Claude:', erro);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// Rota de teste — para confirmar que o servidor está funcionando
app.get('/', (req, res) => {
  res.json({ status: 'ShapeAI servidor rodando!', versao: '1.1' });
});

app.listen(PORT, () => {
  console.log(`Servidor ShapeAI rodando na porta ${PORT}`);
});

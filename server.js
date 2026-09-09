// ==========================================
// ProfCheck-IA — Backend Complet v2 (server.js)
// Vraie détection IA (Groq) + sécurité renforcée
// ==========================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration (variables d'environnement Render)
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!JWT_SECRET || !ADMIN_PASSWORD || !GROQ_API_KEY) {
  console.error('ERREUR : JWT_SECRET, ADMIN_PASSWORD et GROQ_API_KEY sont requis.');
  process.exit(1);
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// En-têtes de sécurité
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ==========================================
// BASE DE DONNÉES SQLITE
// ==========================================
let db;

async function initDatabase() {
  db = await open({
    filename: path.join(__dirname, 'profcheck.db'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'teacher',
      is_premium INTEGER DEFAULT 0,
      free_uses INTEGER DEFAULT 3,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT,
      text_content TEXT,
      ai_probability REAL,
      human_probability REAL,
      result TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

// ==========================================
// PROTECTION ANTI-PIRATAGE (rate limiting)
// ==========================================
const attemptsMap = new Map();

function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const record = attemptsMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count += 1;
  attemptsMap.set(key, record);
  return record.count <= maxAttempts;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'ip';
}

// Nettoyage mémoire toutes les 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attemptsMap) {
    if (now > record.resetAt) attemptsMap.delete(key);
  }
}, 10 * 60 * 1000);

// ==========================================
// MIDDLEWARE AUTH
// ==========================================
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Session expiree. Veuillez vous reconnecter.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Session expiree. Veuillez vous reconnecter.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Acces admin refuse' });
  }
  next();
}

// ==========================================
// ROUTES AUTH
// ==========================================

// Inscription
app.post('/api/register', async (req, res) => {
  try {
    if (!rateLimit('register:' + getClientIp(req), 5, 10 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'Trop de tentatives. Reessayez dans 10 minutes.' });
    }

    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const name = (req.body.name || '').trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Adresse e-mail invalide.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 6 caracteres.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.run(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
      email, hashedPassword, name || null
    );

    res.json({ success: true, message: 'Compte cree avec succes', userId: result.lastID });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, error: 'Cet email est deja utilise. Essayez de vous connecter.' });
    }
    res.status(500).json({ success: false, error: 'Erreur lors de l\'inscription. Reessayez.' });
  }
});

// Connexion
app.post('/api/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!rateLimit('login:' + email + ':' + getClientIp(req), 5, 5 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'Trop de tentatives. Reessayez dans 5 minutes.' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', email);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Email inconnu. Verifiez votre adresse ou creez un compte.' });
    }
    if (!await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ success: false, error: 'Mot de passe incorrect.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, is_premium: user.is_premium },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_premium: !!user.is_premium,
        free_uses: user.free_uses
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur lors de la connexion. Reessayez.' });
  }
});

// Profil utilisateur
app.get('/api/me', authenticate, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, role, is_premium, free_uses, created_at FROM users WHERE id = ?',
      req.user.id
    );
    if (!user) return res.status(404).json({ success: false, error: 'Utilisateur non trouve' });
    res.json({ success: true, user: { ...user, is_premium: !!user.is_premium } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ==========================================
// VRAIE DÉTECTION IA (GROQ)
// ==========================================

const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];

const DETECTION_PROMPT = `Tu es un expert en linguistique forensique appliquee a l'education. Analyse le devoir ci-dessous et evalue la probabilite qu'il ait ete genere ou reecrit par une IA (ChatGPT, Claude, Gemini...).

Criteres a examiner : vocabulaire trop soutenu pour le niveau, phrases parfaitement uniformes, tournures typiques des IA ("il est important de noter", "en conclusion", "dans un monde ou"), absence de fautes naturelles, manque d'exemples personnels, structure trop lisse.

Reponds UNIQUEMENT avec un objet JSON valide (aucun texte avant ou apres) :
{"aiProbability": <nombre 0-100>, "indicators": "<3 indices precis reperes dans le texte, separes par des points-virgules>", "conclusion": "<phrase courte et prudente pour l'enseignant>"}`;

async function detectWithAI(text, niveau) {
  for (const model of GROQ_MODELS) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: DETECTION_PROMPT },
            { role: 'user', content: `NIVEAU SCOLAIRE : ${niveau || 'non precise'}\n\n--- DEVOIR ---\n${text.substring(0, 8000)}\n--- FIN ---` }
          ],
          max_tokens: 700,
          temperature: 0.2
        })
      });

      const data = await response.json();
      if (data.error) {
        console.error('Groq model error:', model, data.error.message);
        continue;
      }

      const content = data.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const aiProb = Math.max(1, Math.min(99, Math.round(parsed.aiProbability)));
        if (!isNaN(aiProb)) {
          return {
            aiProbability: aiProb,
            humanProbability: 100 - aiProb,
            indicators: parsed.indicators || '',
            conclusion: parsed.conclusion || '',
            modelUsed: model
          };
        }
      }
    } catch (err) {
      console.error('Groq detection error:', model, err.message);
      continue;
    }
  }
  return null;
}

// Secours : heuristique locale si Groq est indisponible
function detectHeuristicFallback(text) {
  const words = text.split(/\s+/).length;
  const sentences = text.split(/[.!?]+/).length;
  const avgWordLength = text.replace(/\s/g, '').length / words;
  const punctuationRatio = (text.match(/[.,;:!?]/g) || []).length / words;

  let aiScore = 30;
  if (avgWordLength > 5.5) aiScore += 15;
  if (punctuationRatio < 0.05) aiScore += 10;
  if (words / sentences > 25) aiScore += 15;
  if (/\b(furthermore|moreover|consequently|en conclusion|il est important de noter|dans un monde)\b/i.test(text)) aiScore += 15;

  aiScore = Math.max(5, Math.min(95, Math.round(aiScore)));
  return {
    aiProbability: aiScore,
    humanProbability: 100 - aiScore,
    indicators: 'Analyse locale (service IA temporairement indisponible)',
    conclusion: 'Score indicatif a confirmer par une analyse complete.',
    modelUsed: 'fallback-local'
  };
}

// ==========================================
// ROUTES ANALYSE
// ==========================================

// Analyser un texte
app.post('/api/analyze', authenticate, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);

    if (!user.is_premium && user.free_uses <= 0) {
      return res.status(403).json({
        success: false,
        error: 'Limite d\'essais gratuits atteinte',
        needPremium: true,
        message: 'Vos 3 analyses gratuites sont terminees. Passez a l\'abonnement Enseignant via WhatsApp pour des analyses illimitees.'
      });
    }

    const text = (req.body.text || req.body.content || '').trim();
    const title = (req.body.title || 'Analyse sans titre').trim();
    const niveau = (req.body.niveau || '').trim();

    if (text.length < 50) {
      return res.status(400).json({ success: false, error: 'Texte trop court (minimum 50 caracteres).' });
    }

    // Vraie detection IA (Groq) avec secours local
    let detection = await detectWithAI(text, niveau);
    let usedFallback = false;
    if (!detection) {
      detection = detectHeuristicFallback(text);
      usedFallback = true;
    }

    const result = detection.aiProbability >= 60 ? 'Probablement genere par IA'
      : detection.aiProbability >= 35 ? 'Mixte (partiellement IA)'
      : 'Probablement ecrit par un humain';

    await db.run(
      `INSERT INTO analyses (user_id, title, text_content, ai_probability, human_probability, result, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      user.id, title, text.substring(0, 5000),
      detection.aiProbability, detection.humanProbability, result,
      JSON.stringify({ indicators: detection.indicators, conclusion: detection.conclusion, modelUsed: detection.modelUsed })
    );

    if (!user.is_premium) {
      await db.run('UPDATE users SET free_uses = free_uses - 1 WHERE id = ?', user.id);
    }

    const updatedUser = await db.get('SELECT free_uses, is_premium FROM users WHERE id = ?', user.id);

    res.json({
      success: true,
      aiProbability: detection.aiProbability,
      humanProbability: detection.humanProbability,
      result,
      indicators: detection.indicators,
      conclusion: detection.conclusion,
      usedFallback,
      remaining: updatedUser.is_premium ? 'illimite' : updatedUser.free_uses,
      isPremium: !!updatedUser.is_premium,
      resultDetails: {
        score: detection.aiProbability,
        iaDetected: detection.aiProbability >= 60
      }
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ success: false, error: 'Erreur lors de l\'analyse. Reessayez.' });
  }
});

// Historique des analyses
app.get('/api/analyses', authenticate, async (req, res) => {
  try {
    const analyses = await db.all(
      'SELECT id, title, ai_probability, human_probability, result, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC',
      req.user.id
    );
    res.json({ success: true, analyses });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur lors du chargement de l\'historique' });
  }
});

// Details d'une analyse
app.get('/api/analyses/:id', authenticate, async (req, res) => {
  try {
    const analysis = await db.get('SELECT * FROM analyses WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!analysis) return res.status(404).json({ success: false, error: 'Analyse non trouvee' });
    res.json({ success: true, analysis });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur' });
  }
});

// ==========================================
// ROUTES ADMIN
// ==========================================

app.post('/api/admin/login', (req, res) => {
  if (!rateLimit('admin:' + getClientIp(req), 5, 5 * 60 * 1000)) {
    return res.status(429).json({ success: false, error: 'Trop de tentatives. Reessayez dans 5 minutes.' });
  }
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe administrateur incorrect' });
  }
  const token = jwt.sign({ id: 0, email: 'admin@profcheck.local', role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ success: true, token, user: { role: 'admin', email: 'admin@profcheck.local' } });
});

app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const users = await db.all(
      'SELECT id, email, name, role, is_premium, free_uses, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, users: users.map(u => ({ ...u, is_premium: !!u.is_premium })) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

app.post('/api/admin/activate', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    await db.run('UPDATE users SET is_premium = 1, free_uses = 999 WHERE id = ?', userId);
    res.json({ success: true, message: 'Abonnement active avec succes' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur lors de l\'activation' });
  }
});

app.post('/api/admin/deactivate', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    await db.run('UPDATE users SET is_premium = 0 WHERE id = ?', userId);
    res.json({ success: true, message: 'Abonnement desactive' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur' });
  }
});

// ==========================================
// ASSISTANT CHAT (Groq)
// ==========================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message requis' });

    for (const model of GROQ_MODELS) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: `Tu es ProfCheck Assistant, un expert en education et detection de contenu genere par IA.
Tu aides les enseignants et professeurs a utiliser la plateforme ProfCheck-IA.
Tu reponds en francais, de maniere professionnelle, concise et utile.
Tu peux expliquer comment interpreter les resultats d'analyse, donner des conseils pedagogiques sur la triche par IA, et guider les utilisateurs sur l'abonnement Enseignant.`
              },
              { role: 'user', content: message }
            ],
            max_tokens: 800,
            temperature: 0.7
          })
        });

        const data = await response.json();
        if (data.error) {
          console.error('Groq chat error:', model, data.error.message);
          continue;
        }

        const reply = data.choices?.[0]?.message?.content || 'Desole, je n\'ai pas pu generer de reponse.';
        return res.json({ success: true, reply, modelUsed: model });
      } catch (err) {
        console.error('Chat error:', model, err.message);
        continue;
      }
    }

    res.status(500).json({ success: false, error: 'Service IA temporairement indisponible. Reessayez.' });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ success: false, error: 'Erreur du service chat' });
  }
});

// ==========================================
// ROUTES DIVERSES
// ==========================================

app.post('/api/logout', (req, res) => {
  res.json({ success: true, message: 'Deconnexion reussie' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'ProfCheck-IA', version: '2.0', timestamp: new Date().toISOString() });
});

// ==========================================
// DEMARRAGE
// ==========================================
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`ProfCheck-IA v2 demarre sur le port ${PORT}`);
  });
}).catch(err => {
  console.error('Echec initialisation base de donnees:', err);
  process.exit(1);
});


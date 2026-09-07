const express = require('express');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ============ BASE DE DONNÉES ============
const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password TEXT,
    fullName TEXT,
    professionLevel TEXT,
    subject TEXT,
    schoolName TEXT,
    plan TEXT DEFAULT 'free',
    isActive INTEGER DEFAULT 0,
    createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS programmes (
    id TEXT PRIMARY KEY,
    userId TEXT,
    title TEXT,
    level TEXT,
    subject TEXT,
    startDate TEXT,
    endDate TEXT,
    status TEXT DEFAULT 'actif',
    createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    programmeId TEXT,
    title TEXT,
    description TEXT,
    orderIndex INTEGER,
    durationWeeks INTEGER,
    status TEXT DEFAULT 'en attente'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    userId TEXT,
    content TEXT,
    result TEXT,
    createdAt TEXT
  )`);
});

// ============ CONFIGURATION PLANS ============
const PLANS = {
  free: { maxAnalyses: 3, maxProgrammes: 0, name: 'Gratuit' },
  essential: { maxAnalyses: 9999, maxProgrammes: 0, name: 'Essential ($17)' },
  pro: { maxAnalyses: 9999, maxProgrammes: 3, name: 'Pro ($36)' },
  institution: { maxAnalyses: 9999, maxProgrammes: 99, name: 'Institution ($79)' }
};
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ============ MIDDLEWARES ============
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  
  db.get('SELECT * FROM users WHERE id = ?', [token], (err, user) => {
    if (!user) return res.status(401).json({ error: 'Session invalide' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Admin requis' });
  }
  next();
}

// ============ AUTHENTIFICATION ============
app.post('/api/register', async (req, res) => {
  const { email, password, fullName, professionLevel, subject, schoolName } = req.body;
  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  
  db.run(`INSERT INTO users (id, email, password, fullName, professionLevel, subject, schoolName, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, hash, fullName, professionLevel, subject, schoolName, new Date().toISOString()],
    function(err) {
      if (err) return res.status(400).json({ error: 'Email déjà utilisé' });
      res.cookie('token', id, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
      res.json({ success: true, user: { id, email, fullName, plan: 'free' } });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (!user) return res.status(400).json({ error: 'Email inconnu' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Mot de passe incorrect' });
    res.cookie('token', user.id, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
    res.json({ success: true, user: { id: user.id, email: user.email, fullName: user.fullName, plan: user.plan } });
  });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/me', auth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.free;
  db.all('SELECT * FROM analyses WHERE userId = ?', [req.user.id], (err, analyses) => {
    db.all('SELECT * FROM programmes WHERE userId = ?', [req.user.id], (err2, programmes) => {
      res.json({
        user: { id: req.user.id, email: req.user.email, fullName: req.user.fullName, plan: req.user.plan, professionLevel: req.user.professionLevel, subject: req.user.subject },
        analysesCount: analyses.length,
        programmesCount: programmes.length,
        remainingAnalyses: Math.max(0, plan.maxAnalyses - analyses.length),
        maxProgrammes: plan.maxProgrammes,
        canCreateProgramme: programmes.length < plan.maxProgrammes
      });
    });
  });
});

// ============ ANALYSES IA ============
app.post('/api/analyze', auth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.free;
  
  db.all('SELECT * FROM analyses WHERE userId = ?', [req.user.id], (err, analyses) => {
    if (analyses.length >= plan.maxAnalyses) {
      return res.status(403).json({
        error: 'Limite atteinte',
        message: 'Vos 3 analyses gratuites sont épuisées. Souscrivez un abonnement pour continuer.',
        whatsapp: 'https://wa.me/25377098637?text=Bonjour%20SADIK-FOUAD%2C%20je%20souhaite%20souscrire%20%C3%A0%20un%20abonnement%20ProfCheck-IA.'
      });
    }
    
    const id = crypto.randomUUID();
    const { content } = req.body;
    const mockResult = { score: Math.floor(Math.random() * 100), iaDetected: Math.random() > 0.5 };
    
    db.run('INSERT INTO analyses (id, userId, content, result, createdAt) VALUES (?, ?, ?, ?, ?)',
      [id, req.user.id, content, JSON.stringify(mockResult), new Date().toISOString()],
      () => res.json({ success: true, result: mockResult, remaining: plan.maxAnalyses - analyses.length - 1 })
    );
  });
});

// ============ PROGRAMMES ============
app.post('/api/programmes', auth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.free;
  db.all('SELECT * FROM programmes WHERE userId = ?', [req.user.id], (err, programmes) => {
    if (programmes.length >= plan.maxProgrammes) {
      return res.status(403).json({ error: 'Limite de programmes atteinte pour votre plan.' });
    }
    
    const { title, level, subject, startDate } = req.body;
    const id = crypto.randomUUID();
    const start = new Date(startDate);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 9);
    
    db.run(`INSERT INTO programmes (id, userId, title, level, subject, startDate, endDate, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, title, level, subject, start.toISOString(), end.toISOString(), new Date().toISOString()],
      () => res.json({ success: true, programme: { id, title, endDate: end.toISOString() } })
    );
  });
});

app.get('/api/programmes', auth, (req, res) => {
  db.all('SELECT * FROM programmes WHERE userId = ? ORDER BY createdAt DESC', [req.user.id], (err, rows) => {
    res.json(rows);
  });
});

app.get('/api/programmes/:id/chapters', auth, (req, res) => {
  db.all('SELECT * FROM chapters WHERE programmeId = ? ORDER BY orderIndex', [req.params.id], (err, rows) => {
    res.json(rows);
  });
});

app.post('/api/programmes/:id/chapters', auth, (req, res) => {
  const { title, description, orderIndex, durationWeeks } = req.body;
  const id = crypto.randomUUID();
  db.run(`INSERT INTO chapters (id, programmeId, title, description, orderIndex, durationWeeks)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [id, req.params.id, title, description, orderIndex, durationWeeks],
    () => res.json({ success: true, chapter: { id, title } })
  );
});

// ============ TRAVAIL DU LENDEMAIN ============
app.get('/api/daily-plan', auth, (req, res) => {
  db.all(`SELECT p.*, c.* FROM programmes p 
    LEFT JOIN chapters c ON c.programmeId = p.id 
    WHERE p.userId = ? AND p.status = 'actif'`, [req.user.id], (err, rows) => {
    
    if (!rows.length) return res.json({ message: 'Aucun programme actif. Créez-en un !' });
    
    const programme = rows[0];
    const chapters = rows.filter(r => r.title !== null);
    const today = new Date();
    const start = new Date(programme.startDate);
    const weeksElapsed = Math.floor((today - start) / (7 * 24 * 60 * 60 * 1000));
    
    let currentChapter = chapters[0];
    let weeksCount = 0;
    for (let ch of chapters) {
      weeksCount += ch.durationWeeks || 1;
      if (weeksCount > weeksElapsed) { currentChapter = ch; break; }
    }
    
    res.json({
      programme: { title: programme.title, level: programme.level },
      chapter: currentChapter,
      weekNumber: weeksElapsed + 1,
      suggestion: `Cette semaine : ${currentChapter?.title || 'Révision générale'}`
    });
  });
});

// ============ ADMIN ============
app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all('SELECT id, email, fullName, professionLevel, subject, plan, isActive, createdAt FROM users', [], (err, rows) => {
    res.json(rows);
  });
});

app.post('/api/admin/set-plan', requireAdmin, (req, res) => {
  const { userId, plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Plan invalide' });
  db.run('UPDATE users SET plan = ?, isActive = 1 WHERE id = ?', [plan, userId], () => {
    res.json({ success: true, message: `Plan ${plan} activé` });
  });
});

// ========== ASSISTANT IA PROFCheck-IA ==========
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message requis' });
    }

    const systemPrompt = `Tu es ProfCheck-IA Assistant, un assistant pédagogique intelligent pour enseignants et professeurs du primaire au secondaire. 
Tu aides à :
- Rédiger des e-mails professionnels aux parents, élèves ou collègues
- Résumer des textes, articles ou rapports
- Traduire des documents (français, anglais, arabe, etc.)
- Répondre à des questions pédagogiques et administratives
- Proposer des idées de devoirs, contrôles ou séquences

Règles : Sois concis, professionnel, chaleureux. Réponds dans la langue de l'utilisateur. Si tu rédiges un e-mail, propose un objet clair et un texte prêt à l'envoi.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('Groq error:', data);
      return res.status(500).json({ error: 'Erreur du modèle IA' });
    }

    const reply = data.choices[0].message.content;
    res.json({ reply });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ========== FIN ASSISTANT IA ==========

// ============ LANCEMENT ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProfCheck-IA running on port ${PORT}`));

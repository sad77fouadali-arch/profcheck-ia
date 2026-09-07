// ==========================================
// PROFCheck-IA - Backend Complet (server.js)
// ==========================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration (tout vient des variables d'environnement)
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Vérification des variables obligatoires
if (!JWT_SECRET || !ADMIN_PASSWORD || !GROQ_API_KEY) {
  console.error('❌ ERREUR : Variables d\'environnement manquantes !');
  console.error('   JWT_SECRET, ADMIN_PASSWORD, GROQ_API_KEY sont requises.');
  process.exit(1);
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Base de données SQLite
const db = new Database(path.join(__dirname, 'profcheck.db'));

// Initialisation des tables
db.exec(`
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

// ==========================================
// MIDDLEWARE AUTH
// ==========================================
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès admin refusé' });
  }
  next();
}

// ==========================================
// ROUTES AUTH
// ==========================================

// Inscription
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)'
    ).run(email, hashedPassword, name || null);
    
    res.json({ success: true, message: 'Compte créé avec succès', userId: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    }
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

// Connexion
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, is_premium: user.is_premium },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
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
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// Profil utilisateur
app.get('/api/me', authenticate, (req, res) => {
  const user = db.prepare(
    'SELECT id, email, name, role, is_premium, free_uses, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  res.json({ ...user, is_premium: !!user.is_premium });
});

// ==========================================
// ROUTES ANALYSE IA
// ==========================================

// Analyser un texte
app.post('/api/analyze', authenticate, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    
    // Vérifier les limites
    if (!user.is_premium && user.free_uses <= 0) {
      return res.status(403).json({ 
        error: 'Limite d\'essais gratuits atteinte', 
        needPremium: true,
        message: 'Passez à l\'abonnement Enseignant pour des analyses illimitées. Contactez-nous sur WhatsApp.' 
      });
    }
    
    const { text, title } = req.body;
    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Texte trop court (minimum 50 caractères)' });
    }
    
    // Simulation d'analyse IA (algorithme de détection)
    const words = text.split(/\s+/).length;
    const sentences = text.split(/[.!?]+/).length;
    const avgWordLength = text.replace(/\s/g, '').length / words;
    const punctuationRatio = (text.match(/[.,;:!?]/g) || []).length / words;
    
    // Heuristique : texte trop uniforme = probablement IA
    let aiScore = 0;
    if (avgWordLength > 5.5) aiScore += 20;
    if (punctuationRatio < 0.05) aiScore += 15;
    if (words / sentences > 25) aiScore += 25;
    if (text.includes('furthermore') || text.includes('moreover') || text.includes('consequently')) aiScore += 10;
    
    // Ajout d'une variation aléatoire réaliste
    aiScore += (Math.random() * 30) - 15;
    aiScore = Math.max(5, Math.min(95, aiScore));
    
    const humanScore = 100 - aiScore;
    const result = aiScore > 60 ? 'Probablement généré par IA' : 
                   aiScore > 35 ? 'Mixte (partiellement IA)' : 'Probablement écrit par un humain';
    
    // Sauvegarder l'analyse
    db.prepare(
      `INSERT INTO analyses (user_id, title, text_content, ai_probability, human_probability, result, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      title || 'Analyse sans titre',
      text.substring(0, 5000),
      Math.round(aiScore),
      Math.round(humanScore),
      result,
      JSON.stringify({ words, sentences, avgWordLength: avgWordLength.toFixed(2) })
    );
    
    // Décrémenter les essais gratuits
    if (!user.is_premium) {
      db.prepare('UPDATE users SET free_uses = free_uses - 1 WHERE id = ?').run(user.id);
    }
    
    const updatedUser = db.prepare('SELECT free_uses, is_premium FROM users WHERE id = ?').get(user.id);
    
    res.json({
      aiProbability: Math.round(aiScore),
      humanProbability: Math.round(humanScore),
      result,
      details: {
        words,
        sentences,
        avgWordLength: avgWordLength.toFixed(2),
        punctuationRatio: punctuationRatio.toFixed(3)
      },
      remaining: updatedUser.is_premium ? 'illimité' : updatedUser.free_uses,
      isPremium: !!updatedUser.is_premium
    });
    
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de l\'analyse' });
  }
});

// Historique des analyses
app.get('/api/analyses', authenticate, (req, res) => {
  try {
    const analyses = db.prepare(
      'SELECT id, title, ai_probability, human_probability, result, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
    res.json(analyses);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement de l\'historique' });
  }
});

// Détails d'une analyse
app.get('/api/analyses/:id', authenticate, (req, res) => {
  try {
    const analysis = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!analysis) return res.status(404).json({ error: 'Analyse non trouvée' });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// ROUTES ADMIN
// ==========================================

// Login admin
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe administrateur incorrect' });
  }
  const token = jwt.sign({ id: 0, email: 'admin@profcheck.local', role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ token, user: { role: 'admin', email: 'admin@profcheck.local' } });
});

// Liste des utilisateurs (admin)
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
  try {
    const users = db.prepare(
      'SELECT id, email, name, role, is_premium, free_uses, created_at FROM users ORDER BY created_at DESC'
    ).all();
    res.json(users.map(u => ({ ...u, is_premium: !!u.is_premium })));
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Activer un abonnement premium (admin)
app.post('/api/admin/activate', authenticate, requireAdmin, (req, res) => {
  try {
    const { userId } = req.body;
    db.prepare('UPDATE users SET is_premium = 1, free_uses = 999 WHERE id = ?').run(userId);
    res.json({ success: true, message: 'Abonnement activé avec succès' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de l\'activation' });
  }
});

// Désactiver un abonnement (admin)
app.post('/api/admin/deactivate', authenticate, requireAdmin, (req, res) => {
  try {
    const { userId } = req.body;
    db.prepare('UPDATE users SET is_premium = 0 WHERE id = ?').run(userId);
    res.json({ success: true, message: 'Abonnement désactivé' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// WIDGET CHAT - ProfCheck Assistant (Groq)
// ==========================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [
          {
            role: 'system',
            content: `Tu es ProfCheck Assistant, un expert en éducation et détection de contenu généré par IA. 
Tu aides les enseignants et professeurs à utiliser la plateforme ProfCheck-IA.
Tu réponds en français, de manière professionnelle, concise et utile.
Tu peux expliquer comment interpréter les résultats d'analyse, donner des conseils pédagogiques sur la triche par IA, et guider les utilisateurs sur l'abonnement Enseignant.`
          },
          { role: 'user', content: message }
        ],
        max_tokens: 800,
        temperature: 0.7
      })
    });

    const data = await response.json();
    
    if (data.error) {
      console.error('Groq API error:', data.error);
      return res.status(500).json({ error: 'Erreur du service IA' });
    }

    const reply = data.choices?.[0]?.message?.content || 'Désolé, je n\'ai pas pu générer de réponse.';
    res.json({ reply });
    
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Erreur du service chat' });
  }
});

// ==========================================
// ROUTES DIVERS
// ==========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'ProfCheck-IA', timestamp: new Date().toISOString() });
});

// Redirection racine vers l'app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// DÉMARRAGE DU SERVEUR
// ==========================================
app.listen(PORT, () => {
  console.log(`✅ ProfCheck-IA server running on port ${PORT}`);
  console.log(`📁 Database: ${path.join(__dirname, 'profcheck.db')}`);
});


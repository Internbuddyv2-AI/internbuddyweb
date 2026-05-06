const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');

dotenv.config();
const app = express();

/* -------------------- Config -------------------- */
const PORT = process.env.PORT || 3000;

// Public folder resolution (supports /public or ../public)
const publicDirA = path.resolve(__dirname, 'public');
const publicDirB = path.resolve(__dirname, '../public');
const PUBLIC_DIR = fs.existsSync(publicDirA) ? publicDirA : publicDirB;

// Use Node 18+ fetch if available, fallback to node-fetch
const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* -------------------- Middleware -------------------- */
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve static files
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

/* -------------------- OpenAI Client -------------------- */
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY is missing. Set it in .env or your host env vars.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------- Health Check -------------------- */
app.get('/api/health', (req, res) => {
  res.json({ status: 'InternBuddy backend running 🚀' });
});

/* -------------------- Generate Search Query -------------------- */
app.post('/api/generate-query', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 80
    });

    res.json({ query: completion.choices?.[0]?.message?.content?.trim() || '' });
  } catch (err) {
    console.error('Generate query error:', err);
    res.status(500).json({ error: 'query_generation_failed' });
  }
});

/* -------------------- Job Search (RapidAPI) -------------------- */
app.post('/api/search-jobs', async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Query required' });

  if (!process.env.RAPIDAPI_KEY) {
    return res.status(500).json({ error: 'RAPIDAPI_KEY_missing' });
  }

  try {
    const response = await fetchFn(
      `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=1`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        }
      }
    );

    const data = await response.json();
    res.json(data.data || []);
  } catch (err) {
    console.error('Job search error:', err);
    res.status(500).json({ error: 'job_search_failed' });
  }
});

/* -------------------- Sponsor Jobs -------------------- */
app.get('/api/sponsor-jobs', (req, res) => {
  try {
    const jobsPath = path.join(__dirname, 'sponsor-jobs.json');
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    res.json(jobs);
  } catch (err) {
    console.error('Sponsor jobs error:', err);
    res.status(500).json({ error: 'sponsor_jobs_unavailable' });
  }
});

/* -------------------- Interview Analysis (batch) -------------------- */
app.post('/api/analyze-interview', async (req, res) => {
  const { qa } = req.body || {};
  if (!Array.isArray(qa)) return res.status(400).json({ error: 'qa array required' });

  const formatted = qa
    .map(
      (item, i) =>
        `${i + 1}. Q: ${item.question}\nA: ${item.answer || '(no answer)'}\nConfidence: ${item.confidence ?? 'N/A'}`
    )
    .join('\n\n');

  const systemPrompt = `
You are an expert interview coach.
Return a JSON array where each item has:
- score (0-100)
- mistakes (array of short strings)
- improvedAnswer (1-3 paragraphs)
- tips (2-3 bullet points)
Return strictly valid JSON.
`.trim();

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: formatted }
      ]
    });

    let raw = response.choices?.[0]?.message?.content || '';
    raw = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/(\[.*\])/s);
      parsed = match ? JSON.parse(match[1]) : { raw };
    }

    res.json({ feedback: parsed });
  } catch (err) {
    console.error('Interview analysis error:', err);
    res.status(500).json({ error: 'analysis_failed' });
  }
});

/* -------------------- Interview Question (seed bank, no repeats) -------------------- */
app.post('/api/interview/question', (req, res) => {
  try {
    const { type, level, askedIds = [] } = req.body || {};
    const safeType = type || 'Behavioral';
    const safeLevel = level || 'Intern';

    const seedPath = path.join(__dirname, 'interview-questions.json');
    if (!fs.existsSync(seedPath)) {
      return res.status(500).json({
        error: 'questions_seed_missing',
        message: 'Create interview-questions.json next to server.js'
      });
    }

    const all = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

    const pool = all.filter(q =>
      q.type === safeType &&
      q.level === safeLevel &&
      !askedIds.includes(q.id)
    );

    const fallbackPool = all.filter(q =>
      q.type === safeType &&
      !askedIds.includes(q.id)
    );

    const pickFrom = pool.length ? pool : fallbackPool;
    if (!pickFrom.length) return res.json({ done: true, message: 'No more questions available.' });

    const picked = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    res.json({ done: false, question: picked });
  } catch (err) {
    console.error('Question endpoint error:', err);
    res.status(500).json({ error: 'question_failed' });
  }
});

/* -------------------- Interview Feedback (single Q/A) -------------------- */
app.post('/api/interview/feedback', async (req, res) => {
  try {
    const { question, answer, coachId, coachStyle } = req.body || {};

    const questionText =
      typeof question === 'string'
        ? question
        : question?.text;

    if (!questionText || !answer) {
      return res.status(400).json({ error: 'question_and_answer_required' });
    }

    const systemPrompt = `
You are an expert interview coach.
You MUST NOT invent facts. You can only improve the answer using the user's content.

Return STRICT JSON with:
{
  "score": number (0-100),
  "strengths": string[],
  "mistakes": string[],
  "improvedAnswer": string,
  "tips": string[]
}

Guidelines:
- Encourage STAR when relevant.
- Make it interviewer-friendly.
- Ask for metrics ONLY if reasonable; do not fabricate numbers.
- Keep improvedAnswer concise but premium.

Coach persona: ${coachStyle || coachId || 'InternBuddy Coach'}
`.trim();

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            `Question: ${questionText}\n` +
            `Type: ${(typeof question === 'object' && question?.type) ? question.type : 'Unknown'}\n` +
            `Level: ${(typeof question === 'object' && question?.level) ? question.level : 'Unknown'}\n\n` +
            `User answer:\n${answer}\n`
        }
      ]
    });

    let raw = response.choices?.[0]?.message?.content || '';
    raw = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return res.status(500).json({ error: 'bad_ai_response', raw });
    }

    if (typeof parsed.score !== 'number') parsed.score = 0;
    if (!Array.isArray(parsed.strengths)) parsed.strengths = [];
    if (!Array.isArray(parsed.mistakes)) parsed.mistakes = [];
    if (!Array.isArray(parsed.tips)) parsed.tips = [];
    if (typeof parsed.improvedAnswer !== 'string') parsed.improvedAnswer = '';

    res.json({ feedback: parsed });
  } catch (err) {
    console.error('Interview feedback error:', err);
    res.status(500).json({ error: 'feedback_failed' });
  }
});

/* -------------------- Text-to-Speech (REALISTIC VOICE) -------------------- */
/*
  Supports:
  - model: "gpt-4o-mini-tts" (steerable via instructions) or "tts-1-hd" (higher quality, not steerable)
  - voice: e.g. alloy, nova, onyx, shimmer, sage, verse, marin, cedar...
  - instructions: style control (works with gpt-4o-mini-tts only)
  - response_format: mp3/wav/etc
  Docs: voices + models listed by OpenAI API reference. :contentReference[oaicite:1]{index=1}
*/
app.post('/api/tts', async (req, res) => {
  const { text, voice, quality, response_format, instructions } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Text required' });

  try {
    // If you want “most realistic” default:
    // - Use tts-1-hd for quality
    // - Or use gpt-4o-mini-tts for steerable style
    const model =
      quality === 'hd'
        ? 'tts-1-hd'
        : 'gpt-4o-mini-tts';

    const chosenVoice = voice || 'marin'; // good default (you can change per male/female)
    const fmt = response_format || 'mp3';

    const payload = {
      model,
      voice: chosenVoice,
      input: text,
      response_format: fmt
    };

    // Only gpt-4o-mini-tts supports "instructions" per docs :contentReference[oaicite:2]{index=2}
    if (model === 'gpt-4o-mini-tts') {
      payload.instructions =
        instructions ||
        'Speak like a realistic, professional interviewer. Natural pacing, warm tone, subtle expressiveness. No robotic cadence.';
    }

    const response = await openai.audio.speech.create(payload);

    const audio = Buffer.from(await response.arrayBuffer());

    const contentType =
      fmt === 'wav' ? 'audio/wav' :
      fmt === 'aac' ? 'audio/aac' :
      fmt === 'flac' ? 'audio/flac' :
      fmt === 'opus' ? 'audio/opus' :
      'audio/mpeg';

    res.set({ 'Content-Type': contentType, 'Content-Length': audio.length });
    res.send(audio);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'tts_failed' });
  }
});

/* -------------------- Explicit Page Routes (NO bouncing) -------------------- */
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/homepage.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'homepage.html')));
app.get('/cvcreator.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cvcreator.html')));
app.get('/edit-profile.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edit-profile.html')));

// add if you use these pages
app.get('/interview-prep.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'interview-prep.html')));
app.get('/mock-interview.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mock-interview.html')));

/* -------------------- 404 -------------------- */
app.use((req, res) => {
  res.status(404).send('Not found');
});

/* -------------------- Server -------------------- */
app.listen(PORT, () => {
  console.log(`InternBuddy backend live on port ${PORT}`);
  console.log(`Serving static from: ${PUBLIC_DIR}`);
});

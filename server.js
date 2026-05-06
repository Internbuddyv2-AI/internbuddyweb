const express = require('express');
const path = require('path');
const fs = require('fs');

let dotenv;
try {
  dotenv = require('dotenv');
  dotenv.config();
} catch {
  console.warn('dotenv not installed or not needed on Vercel.');
}

const app = express();

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;

const ROOT_DIR = process.cwd();
const PUBLIC_DIR = fs.existsSync(path.join(ROOT_DIR, 'public'))
  ? path.join(ROOT_DIR, 'public')
  : ROOT_DIR;

/* -------------------- Middleware -------------------- */

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Local only. On Vercel, static files should ideally be in /public.
if (!IS_VERCEL) {
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
}

/* -------------------- Helpers -------------------- */

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function getFilePath(filename) {
  const publicPath = path.join(PUBLIC_DIR, filename);
  const rootPath = path.join(ROOT_DIR, filename);

  if (fileExists(publicPath)) return publicPath;
  if (fileExists(rootPath)) return rootPath;

  return null;
}

function sendPage(res, filename) {
  const filePath = getFilePath(filename);

  if (!filePath) {
    return res.status(404).send(`Page not found: ${filename}`);
  }

  return res.sendFile(filePath);
}

function readJsonFile(filename) {
  const filePath = getFilePath(filename);

  if (!filePath) {
    throw new Error(`${filename} not found`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const { OpenAI } = require('openai');
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  } catch (error) {
    console.error('OpenAI package load error:', error.message);
    return null;
  }
}

/* -------------------- Health Check -------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'InternBuddy backend running',
    environment: IS_VERCEL ? 'vercel' : 'local',
    publicDir: PUBLIC_DIR
  });
});

/* -------------------- Generate Search Query -------------------- */

app.post('/api/generate-query', async (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'prompt_required' });
  }

  const openai = getOpenAIClient();

  if (!openai) {
    return res.status(500).json({
      error: 'openai_not_configured',
      message: 'Add OPENAI_API_KEY in Vercel Environment Variables and make sure openai is in package.json dependencies.'
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 80
    });

    res.json({
      query: completion.choices?.[0]?.message?.content?.trim() || ''
    });
  } catch (err) {
    console.error('Generate query error:', err);
    res.status(500).json({ error: 'query_generation_failed' });
  }
});

/* -------------------- Job Search -------------------- */

app.post('/api/search-jobs', async (req, res) => {
  const { query } = req.body || {};

  if (!query) {
    return res.status(400).json({ error: 'query_required' });
  }

  if (!process.env.RAPIDAPI_KEY) {
    return res.status(500).json({
      error: 'rapidapi_key_missing',
      message: 'Add RAPIDAPI_KEY in Vercel Environment Variables.'
    });
  }

  try {
    const response = await fetch(
      `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=1`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('RapidAPI error:', response.status, text);
      return res.status(500).json({ error: 'rapidapi_request_failed' });
    }

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
    const jobs = readJsonFile('sponsor-jobs.json');
    res.json(jobs);
  } catch (err) {
    console.error('Sponsor jobs error:', err.message);
    res.status(500).json({ error: 'sponsor_jobs_unavailable' });
  }
});

/* -------------------- Interview Analysis Batch -------------------- */

app.post('/api/analyze-interview', async (req, res) => {
  const { qa } = req.body || {};

  if (!Array.isArray(qa)) {
    return res.status(400).json({ error: 'qa_array_required' });
  }

  const openai = getOpenAIClient();

  if (!openai) {
    return res.status(500).json({
      error: 'openai_not_configured',
      message: 'Add OPENAI_API_KEY in Vercel Environment Variables and make sure openai is in package.json dependencies.'
    });
  }

  const formatted = qa
    .map((item, i) => {
      return `${i + 1}. Q: ${item.question}\nA: ${item.answer || '(no answer)'}\nConfidence: ${item.confidence ?? 'N/A'}`;
    })
    .join('\n\n');

  const systemPrompt = `
You are an expert interview coach.
Return a JSON array where each item has:
- score: number from 0 to 100
- mistakes: array of short strings
- improvedAnswer: 1 to 3 paragraphs
- tips: 2 to 3 short strings

Return strictly valid JSON only.
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
      const match = raw.match(/(\[[\s\S]*\])/);
      parsed = match ? JSON.parse(match[1]) : [{ raw }];
    }

    res.json({ feedback: parsed });
  } catch (err) {
    console.error('Interview analysis error:', err);
    res.status(500).json({ error: 'analysis_failed' });
  }
});

/* -------------------- Interview Question -------------------- */

app.post('/api/interview/question', (req, res) => {
  try {
    const { type, level, askedIds = [] } = req.body || {};

    const safeType = type || 'Behavioral';
    const safeLevel = level || 'Intern';

    const all = readJsonFile('interview-questions.json');

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

    if (!pickFrom.length) {
      return res.json({
        done: true,
        message: 'No more questions available.'
      });
    }

    const picked = pickFrom[Math.floor(Math.random() * pickFrom.length)];

    res.json({
      done: false,
      question: picked
    });
  } catch (err) {
    console.error('Question endpoint error:', err);
    res.status(500).json({ error: 'question_failed' });
  }
});

/* -------------------- Interview Feedback Single Q/A -------------------- */

app.post('/api/interview/feedback', async (req, res) => {
  const { question, answer, coachId, coachStyle } = req.body || {};

  const questionText =
    typeof question === 'string'
      ? question
      : question?.text;

  if (!questionText || !answer) {
    return res.status(400).json({ error: 'question_and_answer_required' });
  }

  const openai = getOpenAIClient();

  if (!openai) {
    return res.status(500).json({
      error: 'openai_not_configured',
      message: 'Add OPENAI_API_KEY in Vercel Environment Variables and make sure openai is in package.json dependencies.'
    });
  }

  const systemPrompt = `
You are an expert interview coach.
You MUST NOT invent facts. You can only improve the answer using the user's content.

Return STRICT JSON with:
{
  "score": number,
  "strengths": string[],
  "mistakes": string[],
  "improvedAnswer": string,
  "tips": string[]
}

Guidelines:
- Encourage STAR when relevant.
- Make it interviewer-friendly.
- Ask for metrics only if reasonable.
- Do not fabricate numbers.
- Keep improvedAnswer concise.

Coach persona: ${coachStyle || coachId || 'InternBuddy Coach'}
`.trim();

  try {
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
      return res.status(500).json({
        error: 'bad_ai_response',
        raw
      });
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

/* -------------------- Text To Speech -------------------- */

app.post('/api/tts', async (req, res) => {
  const { text, voice, quality, response_format, instructions } = req.body || {};

  if (!text) {
    return res.status(400).json({ error: 'text_required' });
  }

  const openai = getOpenAIClient();

  if (!openai) {
    return res.status(500).json({
      error: 'openai_not_configured',
      message: 'Add OPENAI_API_KEY in Vercel Environment Variables and make sure openai is in package.json dependencies.'
    });
  }

  try {
    const model = quality === 'hd' ? 'tts-1-hd' : 'gpt-4o-mini-tts';
    const chosenVoice = voice || 'alloy';
    const fmt = response_format || 'mp3';

    const payload = {
      model,
      voice: chosenVoice,
      input: text,
      response_format: fmt
    };

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

    res.set({
      'Content-Type': contentType,
      'Content-Length': audio.length
    });

    res.send(audio);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'tts_failed' });
  }
});

/* -------------------- Page Routes -------------------- */

app.get('/', (req, res) => sendPage(res, 'index.html'));

const pages = [
  'index',
  'login',
  'signup',
  'homepage',
  'cvcreator',
  'edit-profile',
  'find-job',
  'job-results',
  'application-tracker',
  'all-sponsor-jobs',
  'interview-prep',
  'mock-interview',
  'onboarding',
  'resetpassword',
  'terms-and-conditions',
  'about',
  'google-index'
];

pages.forEach(page => {
  app.get(`/${page}`, (req, res) => sendPage(res, `${page}.html`));
  app.get(`/${page}.html`, (req, res) => sendPage(res, `${page}.html`));
});

/* -------------------- 404 -------------------- */

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    path: req.path
  });
});

/* -------------------- Local Server / Vercel Export -------------------- */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`InternBuddy backend live on http://localhost:${PORT}`);
    console.log(`Serving files from: ${PUBLIC_DIR}`);
  });
}

module.exports = app;
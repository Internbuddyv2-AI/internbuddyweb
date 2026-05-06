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
const IS_VERCEL = !!process.env.VERCEL;

/*
  VERCEL IMPORTANT:
  Best structure:
  - server.js
  - package.json
  - public/
      index.html
      login.html
      homepage.html
      css/styles.css
      script.js
      interview.js
      interview.css
      interview-questions.json
      coach.glb

  If you keep HTML files in the root, this file will still try to serve them locally,
  but for Vercel, putting frontend files in /public is cleaner.
*/

const publicDir = path.join(__dirname, 'public');
const rootDir = __dirname;

const PUBLIC_DIR = fs.existsSync(publicDir) ? publicDir : rootDir;

const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* -------------------- Middleware -------------------- */

app.disable('x-powered-by');

app.use(cors({
  origin: true,
  credentials: false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/*
  Local dev only.
  On Vercel, static files should be served from /public by Vercel itself.
*/
if (!IS_VERCEL) {
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
}

/* -------------------- OpenAI Client -------------------- */

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

if (!hasOpenAIKey) {
  console.warn('OPENAI_API_KEY is missing. Add it in Vercel Environment Variables.');
}

const openai = hasOpenAIKey
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* -------------------- Helpers -------------------- */

function sendPage(res, filename) {
  const filePath = path.join(PUBLIC_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send(`Page not found: ${filename}`);
  }

  return res.sendFile(filePath);
}

function readJsonFile(filename) {
  const possiblePaths = [
    path.join(PUBLIC_DIR, filename),
    path.join(rootDir, filename)
  ];

  const foundPath = possiblePaths.find(filePath => fs.existsSync(filePath));

  if (!foundPath) {
    throw new Error(`${filename} not found`);
  }

  return JSON.parse(fs.readFileSync(foundPath, 'utf8'));
}

/* -------------------- Health Check -------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'InternBuddy backend running',
    environment: IS_VERCEL ? 'vercel' : 'local'
  });
});

/* -------------------- Generate Search Query -------------------- */

app.post('/api/generate-query', async (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'prompt_required' });
  }

  if (!openai) {
    return res.status(500).json({ error: 'openai_api_key_missing' });
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
    return res.status(500).json({ error: 'rapidapi_key_missing' });
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

  if (!openai) {
    return res.status(500).json({ error: 'openai_api_key_missing' });
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

  if (!openai) {
    return res.status(500).json({ error: 'openai_api_key_missing' });
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

  if (!openai) {
    return res.status(500).json({ error: 'openai_api_key_missing' });
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
app.get('/index.html', (req, res) => sendPage(res, 'index.html'));
app.get('/login.html', (req, res) => sendPage(res, 'login.html'));
app.get('/signup.html', (req, res) => sendPage(res, 'signup.html'));
app.get('/homepage.html', (req, res) => sendPage(res, 'homepage.html'));
app.get('/cvcreator.html', (req, res) => sendPage(res, 'cvcreator.html'));
app.get('/edit-profile.html', (req, res) => sendPage(res, 'edit-profile.html'));
app.get('/find-job.html', (req, res) => sendPage(res, 'find-job.html'));
app.get('/job-results.html', (req, res) => sendPage(res, 'job-results.html'));
app.get('/application-tracker.html', (req, res) => sendPage(res, 'application-tracker.html'));
app.get('/all-sponsor-jobs.html', (req, res) => sendPage(res, 'all-sponsor-jobs.html'));
app.get('/interview-prep.html', (req, res) => sendPage(res, 'interview-prep.html'));
app.get('/mock-interview.html', (req, res) => sendPage(res, 'mock-interview.html'));
app.get('/onboarding.html', (req, res) => sendPage(res, 'onboarding.html'));
app.get('/resetpassword.html', (req, res) => sendPage(res, 'resetpassword.html'));
app.get('/terms-and-conditions.html', (req, res) => sendPage(res, 'terms-and-conditions.html'));
app.get('/about.html', (req, res) => sendPage(res, 'about.html'));

/* Clean URL versions */

app.get('/login', (req, res) => sendPage(res, 'login.html'));
app.get('/signup', (req, res) => sendPage(res, 'signup.html'));
app.get('/homepage', (req, res) => sendPage(res, 'homepage.html'));
app.get('/cvcreator', (req, res) => sendPage(res, 'cvcreator.html'));
app.get('/edit-profile', (req, res) => sendPage(res, 'edit-profile.html'));
app.get('/find-job', (req, res) => sendPage(res, 'find-job.html'));
app.get('/job-results', (req, res) => sendPage(res, 'job-results.html'));
app.get('/application-tracker', (req, res) => sendPage(res, 'application-tracker.html'));
app.get('/all-sponsor-jobs', (req, res) => sendPage(res, 'all-sponsor-jobs.html'));
app.get('/interview-prep', (req, res) => sendPage(res, 'interview-prep.html'));
app.get('/mock-interview', (req, res) => sendPage(res, 'mock-interview.html'));
app.get('/onboarding', (req, res) => sendPage(res, 'onboarding.html'));
app.get('/resetpassword', (req, res) => sendPage(res, 'resetpassword.html'));
app.get('/terms-and-conditions', (req, res) => sendPage(res, 'terms-and-conditions.html'));
app.get('/about', (req, res) => sendPage(res, 'about.html'));

/* -------------------- 404 -------------------- */

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    path: req.path
  });
});

/* -------------------- Local Server Only -------------------- */

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`InternBuddy backend live on http://localhost:${PORT}`);
    console.log(`Serving files from: ${PUBLIC_DIR}`);
  });
}

/*
  Required for Vercel.
  Vercel can run exported Express apps as a function.
*/
module.exports = app;
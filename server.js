const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Load .env
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach((l) => {
    const t = l.trim();
    if (t && !t.startsWith("#")) {
      const [k, ...v] = t.split("=");
      const val = v.join("=").trim();
      if (k && val && val.length > 5) process.env[k.trim()] = val;
    }
  });
} catch (e) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
const FB = path.join(__dirname, "feedback.json");

// ===== RATE LIMITING: 30 req/hour per IP =====
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    entry = { count: 0, start: now };
    rateMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) {
    const mins = Math.ceil((entry.start + RATE_WINDOW - now) / 60000);
    return res.status(429).json({ error: "Rate limit: " + RATE_LIMIT + " requests/hour. Try again in " + mins + " min.", retryMinutes: mins });
  }
  res.set("X-RateLimit-Limit", String(RATE_LIMIT));
  res.set("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT - entry.count)));
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of rateMap) { if (now - e.start > RATE_WINDOW) rateMap.delete(ip); } }, 600000);

// ===== HELPERS =====
function ft(url, opts, ms = 30000) {
  return Promise.race([fetch(url, opts), new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), ms))]);
}

async function groqChat(sys, usr, maxT) {
  const k = process.env.GROQ_API_KEY;
  if (!k) return null;
  try {
    const r = await ft("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + k },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: sys }, { role: "user", content: usr }], max_tokens: maxT || 1200, temperature: 0.1 }),
    });
    const d = await r.json();
    if (d.error) { console.log("  Groq err:", d.error.message); return null; }
    return d.choices?.[0]?.message?.content || null;
  } catch (e) { console.log("  Groq err:", e.message); return null; }
}

// ===== STEP 1: PROMPT OPTIMIZER =====
async function optimizePrompt(userPrompt, history) {
  let ctx = "";
  if (history && history.length > 0) {
    ctx = "\n\nConversation history:\n" + history.slice(-6).map((h) => (h.role === "user" ? "User: " : "AI: ") + h.content.slice(0, 200)).join("\n") + "\n\nThis is a follow-up. Make the optimized prompt self-contained.";
  }
  const r = await groqChat(
    "You are a prompt optimizer. Rewrite the user's question to be clearer and more specific so AI models give better answers. If it's a follow-up, include enough context so models can answer without seeing the history. Return ONLY the improved prompt, nothing else.",
    "Optimize this: " + userPrompt + ctx, 300
  );
  return r || userPrompt;
}

// ===== CONVERSATION HISTORY =====
function buildMsgs(history, prompt) {
  const msgs = [];
  if (history?.length) { for (const h of history.slice(-8)) msgs.push({ role: h.role === "user" ? "user" : "assistant", content: h.content.slice(0, 600) }); }
  msgs.push({ role: "user", content: prompt });
  return msgs;
}
function buildGemini(history, prompt) {
  const msgs = [];
  if (history?.length) { for (const h of history.slice(-8)) msgs.push({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.content.slice(0, 600) }] }); }
  msgs.push({ role: "user", parts: [{ text: prompt }] });
  return msgs;
}

// ===== 3 COMPETITORS =====
async function callGemini(p, h) {
  const k = process.env.GEMINI_API_KEY;
  if (!k) return { answer: null, error: "No key", connected: false };
  try {
    const r = await ft("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k },
      body: JSON.stringify({ contents: buildGemini(h, p) }),
    });
    const d = await r.json();
    if (d.error) return { answer: null, error: d.error.message.split(".")[0], connected: true };
    return { answer: d.candidates?.[0]?.content?.parts?.map((x) => x.text).join("\n") || null, error: null, connected: true };
  } catch (e) { return { answer: null, error: e.message, connected: true }; }
}

async function callOpenRouter(p, h) {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) return { answer: null, error: "No key", connected: false };
  try {
    const r = await ft("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + k, "HTTP-Referer": "https://ai-arena.com", "X-Title": "AI Arena" },
      body: JSON.stringify({ model: "nvidia/nemotron-3-nano-30b-a3b:free", messages: buildMsgs(h, p), max_tokens: 1024 }),
    });
    const d = await r.json();
    if (d.error) return { answer: null, error: d.error.message || JSON.stringify(d.error), connected: true };
    return { answer: d.choices?.[0]?.message?.content || null, error: null, connected: true };
  } catch (e) { return { answer: null, error: e.message, connected: true }; }
}

async function callMistral(p, h) {
  const k = process.env.MISTRAL_API_KEY;
  if (!k) return { answer: null, error: "No key", connected: false };
  try {
    const r = await ft("https://api.mistral.ai/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k },
      body: JSON.stringify({ model: "mistral-small-latest", messages: buildMsgs(h, p), max_tokens: 1024 }),
    });
    const d = await r.json();
    if (d.error) return { answer: null, error: d.error.message || JSON.stringify(d.error), connected: true };
    return { answer: d.choices?.[0]?.message?.content || null, error: null, connected: true };
  } catch (e) { return { answer: null, error: e.message, connected: true }; }
}

// ===== STEP 3: JUDGE =====
async function evaluate(prompt, optimized, answers) {
  const valid = Object.entries(answers).filter(([, v]) => v.answer);

  if (valid.length === 0) return { scores: {}, bestAnswer: "No models responded. Please check API keys.", winner: "none", reasoning: "All failed.", corrections: "" };

  if (valid.length === 1) {
    const [id, d] = valid[0];
    return { scores: { [id]: { accuracy: 8, completeness: 7, clarity: 8, helpfulness: 8, overall: 8 } }, bestAnswer: d.answer, winner: id, reasoning: id + " was the only responder.", corrections: "" };
  }

  const block = valid.map(([id, d]) => "[" + id + "]:\n" + d.answer.slice(0, 1200)).join("\n\n---\n\n");

  const judgePrompt = `You are an impartial AI judge evaluating answers from different AI models.

The user asked: "${prompt}"
The optimized prompt was: "${optimized}"

Here are the competing answers:

${block}

YOUR TASK:
1. Score each model 1-10 on: accuracy, completeness, clarity, helpfulness
2. Calculate overall = rounded average of those 4 scores
3. Pick the winner (highest overall score)
4. IMPORTANT: Write a complete, detailed "bestAnswer" that is a FULL response to the user's question. Combine the best information from all answers into one comprehensive, well-written answer. The bestAnswer must be at least 100 words and must directly answer the question - do NOT just write a model name.
5. Note any factual corrections needed (or empty string if none)

Return ONLY valid JSON with NO markdown fences:
{"scores":{"gemini":{"accuracy":8,"completeness":7,"clarity":9,"helpfulness":8,"overall":8},"mistral":{"accuracy":7,"completeness":8,"clarity":8,"helpfulness":7,"overall":8}},"corrections":"","bestAnswer":"[WRITE THE FULL DETAILED ANSWER HERE - THIS MUST BE A COMPLETE RESPONSE TO THE USER'S QUESTION, NOT A MODEL NAME]","winner":"mistral","reasoning":"Brief explanation of scoring"}`;

  const text = await groqChat("You are an impartial AI judge. Return ONLY valid JSON. No markdown. No extra text.", judgePrompt, 2000);

  if (!text) {
    // Fallback: use longest answer
    const b = valid.sort((a, c) => c[1].answer.length - a[1].answer.length)[0];
    return { scores: Object.fromEntries(valid.map(([id]) => [id, { accuracy: 7, completeness: 7, clarity: 7, helpfulness: 7, overall: 7 }])), bestAnswer: b[1].answer, winner: b[0], reasoning: "Judge unavailable. Showing best answer.", corrections: "" };
  }

  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON found");
    const result = JSON.parse(m[0]);

    // Validate winner
    if (!result.winner || !answers[result.winner]?.answer) {
      const best = valid.sort((a, c) => (result.scores?.[c[0]]?.overall || 0) - (result.scores?.[a[0]]?.overall || 0))[0];
      result.winner = best[0];
    }

    // CRITICAL FIX: If bestAnswer is too short or is just a model name, use the winner's actual answer
    if (!result.bestAnswer || result.bestAnswer.length < 50 || valid.some(([id]) => result.bestAnswer.trim().toLowerCase() === id.toLowerCase())) {
      console.log("  Judge gave bad bestAnswer, using winner's answer instead");
      result.bestAnswer = answers[result.winner].answer;
    }

    return result;
  } catch (e) {
    console.log("  Judge parse error:", e.message);
    const b = valid.sort((a, c) => c[1].answer.length - a[1].answer.length)[0];
    return { scores: Object.fromEntries(valid.map(([id]) => [id, { accuracy: 7, completeness: 7, clarity: 7, helpfulness: 7, overall: 7 }])), bestAnswer: b[1].answer, winner: b[0], reasoning: "Judge error. Showing best answer.", corrections: "" };
  }
}

// ===== ROUTES =====
app.get("/api/status", (req, res) => {
  const models = {
    gemini: { connected: !!process.env.GEMINI_API_KEY, name: "Gemini 3 Flash", provider: "Google", icon: "\u25C6", color: "#4c8bf5" },
    openrouter: { connected: !!process.env.OPENROUTER_API_KEY, name: "Nemotron 30B", provider: "OpenRouter", icon: "\u25CE", color: "#6d28d9" },
    mistral: { connected: !!process.env.MISTRAL_API_KEY, name: "Mistral Small", provider: "Mistral", icon: "\u25B2", color: "#ff7000" },
  };
  res.json({ models, groq: { connected: !!process.env.GROQ_API_KEY, name: "Llama 3.3 70B" }, connected: Object.entries(models).filter(([, v]) => v.connected).map(([id]) => id), rateLimit: RATE_LIMIT });
});

app.post("/api/ask", rateLimit, async (req, res) => {
  const { prompt, history } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  console.log("\n=== QUESTION ===");
  console.log("  Q:", prompt.slice(0, 80));
  if (history?.length) console.log("  History:", history.length, "msgs");

  console.log("  [1] Optimizing...");
  const optimized = await optimizePrompt(prompt, history);
  console.log("  Opt:", optimized.slice(0, 100));

  console.log("  [2] Competing...");
  const [gemini, openrouter, mistral] = await Promise.all([
    callGemini(optimized, history).then((r) => { console.log("  Gem:", r.answer ? "OK (" + r.answer.length + " chars)" : "FAIL " + r.error); return r; }),
    callOpenRouter(optimized, history).then((r) => { console.log("  OR:", r.answer ? "OK (" + r.answer.length + " chars)" : "FAIL " + r.error); return r; }),
    callMistral(optimized, history).then((r) => { console.log("  Mis:", r.answer ? "OK (" + r.answer.length + " chars)" : "FAIL " + r.error); return r; }),
  ]);
  const answers = { gemini, openrouter, mistral };

  console.log("  [3] Judging...");
  const evaluation = await evaluate(prompt, optimized, answers);
  console.log("  Win:", evaluation.winner, "| Best:", evaluation.bestAnswer?.slice(0, 60) + "...");

  res.json({ answers, evaluation, optimizedPrompt: optimized });
});

app.post("/api/feedback", (req, res) => {
  const { rating, comment } = req.body;
  let fb = []; try { fb = JSON.parse(fs.readFileSync(FB, "utf8")); } catch (e) {}
  fb.push({ rating, comment, date: new Date().toISOString() });
  fs.writeFileSync(FB, JSON.stringify(fb, null, 2));
  console.log("  Feedback:", rating, "stars");
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  const c = (k) => (process.env[k] ? "YES" : "NO ");
  console.log("\n=================================================");
  console.log("  AI ARENA v2 — http://localhost:" + PORT);
  console.log("=================================================");
  console.log("  Competitors:");
  console.log("    Gemini 3 Flash   " + c("GEMINI_API_KEY"));
  console.log("    Nemotron 30B     " + c("OPENROUTER_API_KEY"));
  console.log("    Mistral Small    " + c("MISTRAL_API_KEY"));
  console.log("  Judge + Optimizer:");
  console.log("    Llama 3.3 70B    " + c("GROQ_API_KEY"));
  console.log("  Rate limit: " + RATE_LIMIT + " req/hour");
  console.log("=================================================\n");
});

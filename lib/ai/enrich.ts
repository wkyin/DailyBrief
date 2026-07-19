import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";

interface EnrichInput {
  url: string;
  title: string;
  excerpt?: string;
  source?: string;
}

const GH_SYSTEM_PROMPT_ZH = `你是一名技術編輯，負責為 GitHub Trending 項目寫中文介紹。

輸入：每個項目有 owner/repo 名 + 一行英文 description（可能沒有）。

任務：根據 repo 名和 description，寫一段 60-120 字的**通順中文介紹**，要說清：
  1. 這個項目是做什麼的，解決了什麼問題
  2. 用了什麼技術 / 方法（能從 repo 名 + description 推斷的話）
  3. 誰會用它，典型場景是什麼

寫作風格：
  - 信息密度高，不寫"這是一個…"這種廢話開頭
  - 中文術語優先，技術名詞保留英文
  - 不要標題黨，事實陳述為主
  - 如果信息不足，寧可短不要編造

輸出嚴格 JSON 對象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，從輸入中精確覆制>", "summary": "<60-120 字中文介紹>" },
    ...
  ]
}`;

const GH_SYSTEM_PROMPT_EN = `You are a technical editor writing English summaries for GitHub Trending repositories.

Input: each repo has owner/repo name + a one-line description (may be missing).

Task: write a 60-120 word **fluent English summary** covering:
  1. What the project does and what problem it solves
  2. What technology / approach (inferable from repo name + description)
  3. Who uses it, typical use case

Style:
  - High information density; avoid "This is a..." filler openings
  - Concrete; if info is insufficient, prefer shorter over fabrication
  - Factual statements only, no hype

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-120 word English summary>" },
    ...
  ]
}`;

const FINANCE_SYSTEM_PROMPT_ZH = `你是一名中文財經編輯，為英文/中文財經新聞生成**中文事實摘要**。

輸入：每條新聞有 url、title、excerpt 和 source（來源媒體名）。

任務：根據 title + excerpt，生成一段 50-100 字的**中文摘要**：
  - 原文是英文 → 翻譯關鍵信息為中文（不是逐字翻譯，而是抽出要點）
  - 原文是中文 → 凝練為信息密度更高的中文
  - 必須保留：關鍵數字（漲跌幅、金額、利率）、機構/公司/人名、地區
  - 必須中性事實陳述，不帶情緒、不標題黨
  - 信息不足時寧可短，不要編造或擴展

輸出嚴格 JSON 對象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，從輸入中精確覆制>", "summary": "<50-100 字中文摘要>" },
    ...
  ]
}

**引號規則（重要！）**：summary 內的引用一律用中文全角引號「」或""，**絕不**用英文雙引號 \" —— 否則會導致 JSON 解析失敗。`;

const FINANCE_SYSTEM_PROMPT_EN = `You are an English-language financial / world-news editor producing **factual summaries**.

Input: each news item has url, title, excerpt, and source (publisher name).

Task: from title + excerpt, write a 50-100 word **English summary**:
  - If the source text is non-English, translate the key information (not word-for-word; extract the points)
  - If already English, condense to higher information density
  - Preserve: key numbers (% moves, amounts, rates), institutions / companies / people / regions
  - Neutral factual tone — no emotion, no clickbait
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<50-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const XVIRAL_SYSTEM_PROMPT_ZH = `你是一名中文 AI 圈編輯，為 X（Twitter）上的爆款 AI 帖子生成**中文摘要**。

輸入：每條帖子有 url、title、author（@handle 形式）、previewText（推文開頭幾句）。

注意 X 帖子的特點：
  - title 經常是博主自己起的標題黨，**摘要不要照搬標題**
  - previewText 是推文實際內容開頭，**信息源以它為準**
  - 內容多是 prompt 工程 / 工作流 / 工具對比 / 案例分享 / 教程

任務：生成 60-100 字中文摘要，說清楚：
  1. **博主在分享什麼**（教程？工作流？踩坑？產品發布？）
  2. **關鍵數字/工具/概念**（如果有）：如 \"用 Claude Code 月入 4 萬美元\"、\"40 條 prompt 模板\"、\"3 個 sub-agent 協作\"
  3. **價值/角度**（如果能推斷）：是新發現還是老話題？

寫作風格：
  - 信息密度高，不寫 \"博主分享了…\" 這種廢話開頭
  - 中文術語優先，工具名/平台名保留英文（Claude、GPT、Codex、Cursor 等）
  - 不帶營銷腔，不要 "震驚！" "必看！" 這種標題黨
  - 信息不足寧可短，不要硬擴

輸出嚴格 JSON 對象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，從輸入中精確覆制>", "summary": "<60-100 字中文摘要>" },
    ...
  ]
}

**引號規則（重要！）**：summary 內的引用一律用中文全角引號「」或""，**絕不**用英文雙引號 \" —— 否則會導致 JSON 解析失敗。`;

const XVIRAL_SYSTEM_PROMPT_EN = `You are an editor producing **English summaries** of viral AI-related X (Twitter) posts.

Input: each post has url, title, author (@handle), and previewText (first lines of the tweet).

X-post patterns:
  - title is often the author's clickbait headline — **do not just rephrase the title**
  - previewText is the actual tweet opening — **treat it as the source of truth**
  - typical content: prompt engineering / workflows / tool comparisons / case studies / tutorials

Task: write a 60-100 word English summary covering:
  1. **What the author is sharing** (tutorial? workflow? gotcha? product launch?)
  2. **Key numbers / tools / concepts** (if present): e.g. "\$40k/month with Claude Code", "40 prompt templates", "3 sub-agents collaborating"
  3. **Angle / value** (if inferable): novel finding or established take?

Style:
  - High information density; avoid "The author shares..." filler
  - Keep tool / platform names in original case (Claude, GPT, Codex, Cursor, etc.)
  - No marketing tone; no "Mind-blowing!" / "Must-read!" hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const PAPERS_SYSTEM_PROMPT_ZH = `你是一名 AI 研究方向的中文編輯，為 HuggingFace 上的熱門論文寫**中文摘要**。

輸入：每篇論文有 url、title（英文標題）、excerpt（英文摘要開頭）。

任務：根據 title + excerpt，寫一段 60-110 字的**中文摘要**，說清：
  1. 這篇論文解決什麼問題 / 提出什麼方法
  2. 核心技術思路（模型、訓練方式、數據等，能從摘要推斷的話）
  3. 關鍵結果或貢獻（有量化指標就保留，如準確率、加速比）

寫作風格：
  - 信息密度高，不寫"這篇論文…"這種廢話開頭
  - 中文表達，專業術語 / 模型名 / 方法名保留英文（Transformer、RLHF、CoT、MoE 等）
  - 事實陳述，不誇大、不標題黨
  - 信息不足寧可短，不要編造

輸出嚴格 JSON 對象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，從輸入中精確覆制>", "summary": "<60-110 字中文摘要>" },
    ...
  ]
}

**引號規則（重要！）**：summary 內的引用一律用中文全角引號「」或""，**絕不**用英文雙引號 \" —— 否則會導致 JSON 解析失敗。`;

const PAPERS_SYSTEM_PROMPT_EN = `You are an AI-research editor writing **English summaries** of trending HuggingFace papers.

Input: each paper has url, title, and excerpt (start of the English abstract).

Task: from title + excerpt, write a 60-110 word **English summary** covering:
  1. What problem the paper tackles / what method it proposes
  2. The core technical approach (model, training method, data — if inferable)
  3. Key result or contribution (keep quantitative metrics if present)

Style:
  - High information density; avoid "This paper..." filler openings
  - Keep model / method names in original form (Transformer, RLHF, CoT, MoE, etc.)
  - Factual, no hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-110 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

// Pick the right localized prompt set at module init. Each enricher reaches
// in via PROMPTS.<key> so the call sites stay locale-agnostic.
const PROMPTS =
  REPORT_LOCALE === "en"
    ? { gh: GH_SYSTEM_PROMPT_EN, finance: FINANCE_SYSTEM_PROMPT_EN, xViral: XVIRAL_SYSTEM_PROMPT_EN, papers: PAPERS_SYSTEM_PROMPT_EN }
    : { gh: GH_SYSTEM_PROMPT_ZH, finance: FINANCE_SYSTEM_PROMPT_ZH, xViral: XVIRAL_SYSTEM_PROMPT_ZH, papers: PAPERS_SYSTEM_PROMPT_ZH };

const USER_PROMPT_HEADER =
  REPORT_LOCALE === "en"
    ? (n: number) => `Candidate items (${n} entries, JSON array):`
    : (n: number) => `候選條目（共 ${n} 條，JSON 數組）：`;
const USER_PROMPT_FOOTER =
  REPORT_LOCALE === "en"
    ? `Output \`{"summaries": [{"url": ..., "summary": ...}, ...]}\` — url must be copied exactly from input.`
    : `請輸出 {"summaries": [{"url": ..., "summary": ...}, ...]}，url 必須精確回填輸入值。`;

async function runEnrichment(
  payload: unknown[],
  systemPrompt: string,
  scope: string,
): Promise<Map<string, string>> {
  // Sonnet has a strong "match input language" reflex — when items contain
  // English titles + Chinese-tinted source names (or just a Chinese-leaning
  // RLHF default), system-prompt-only language constraints get ignored. Pin
  // the output language as the first line of the *user* prompt for recency.
  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Every summary string must be written entirely in English, even if the input title or description contains Chinese."
      : "**輸出語言：僅中文。** 每個 summary 字段必須全部是中文，即使輸入條目是英文。";
  const userPrompt = [
    langHeader,
    "",
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    USER_PROMPT_FOOTER,
  ].join("\n");

  const result = new Map<string, string>();

  try {
    const { text } = await runLlm({
      systemPrompt,
      userPrompt,
      timeoutMs: 240_000,
    });
    const cleaned = extractJson(text);

    let parsed: { summaries?: Array<{ url?: string; summary?: string }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const s of parsed.summaries ?? []) {
      if (s.url && s.summary) result.set(s.url, s.summary.trim());
    }

    // Diagnostic: if we got back substantially fewer entries than asked for,
    // dump the raw LLM output so the cause is visible without re-running.
    // Common reasons: provider max_tokens too low → truncated JSON, model
    // refused some items, URL field altered so the upstream URL-match drops
    // entries downstream. Without this dump the failure is silent.
    if (result.size < payload.length / 2 && payload.length >= 3) {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const tag = scope.replace(/[^a-z0-9]/gi, "-");
        fs.writeFileSync(
          `logs/enrich-undercount-${tag}-${ts}.txt`,
          `scope=${scope}\nrequested=${payload.length}\nreturned=${result.size}\n\n--- raw LLM output ---\n${text}`,
          "utf8",
        );
        console.warn(
          `[enrich] ${scope}: undercount ${result.size}/${payload.length} — raw dumped to logs/enrich-undercount-${tag}-${ts}.txt`,
        );
      } catch {
        // Can't write log (read-only fs?) — non-fatal, just skip.
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] ${scope} failed: ${msg}`);
  }

  return result;
}

/**
 * Generate Chinese summaries for a batch of GitHub Trending repos in
 * a single Claude CLI call. Failures are non-fatal — caller gets an
 * empty map and the rendering simply omits summaries.
 */
export async function enrichGithubTrendingSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    repo: it.title,
    description: (it.excerpt ?? "").slice(0, 200),
  }));
  return runEnrichment(payload, PROMPTS.gh, "GH summaries");
}

/**
 * Generate Chinese factual summaries for the (up to ~50) finance news
 * items that will be shown in the raw panel. One Sonnet call covers
 * the whole batch.
 */
export async function enrichFinanceNewsSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    source: it.source ?? "",
    excerpt: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.finance, "finance summaries");
}

/**
 * Generate Chinese summaries for viral X posts. Different prompt from
 * finance because X tweets are usually clickbait titles + first-person
 * tutorial / case-study text — the model needs to dig past the headline.
 */
export async function enrichXViralSummaries(
  items: Array<EnrichInput & { author?: string }>,
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    author: it.author ?? "",
    previewText: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.xViral, "X-viral summaries");
}

/**
 * Generate summaries for trending HuggingFace papers. Separate prompt
 * from finance/GH because papers need a problem/method/result framing
 * and the excerpt is an English research abstract.
 */
export async function enrichTrendingPapersSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    excerpt: (it.excerpt ?? "").slice(0, 300),
  }));
  return runEnrichment(payload, PROMPTS.papers, "papers summaries");
}

# Copilot Studio MCP Server Setup Guide

Step-by-step guide for a **tenant admin** to connect the Mandumah MCP server
to a Microsoft Copilot Studio agent.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Microsoft 365 tenant | With Copilot Studio access for your account |
| Deployed server URL | The public HTTPS URL of your Mandumah deployment |
| API key | The value of the `API_KEY` environment variable set on the server |
| Server reachable over HTTPS | Copilot Studio requires HTTPS; use ngrok/Cloudflare Tunnel for demo day |

> **Demo-day tunnel option:** `ngrok http 8000` or `cloudflared tunnel --url http://localhost:8000`
> gives you a temporary public HTTPS URL like `https://abc123.ngrok.io`.

---

## 1. Verify the server is running

Before configuring Copilot Studio, confirm the server responds:

```bash
curl -s https://<your-host>/api/health
# → {"status":"ok","collection":"..."}

curl -s -X POST https://<your-host>/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your-key>" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' 
# → {"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},...}}
```

---

## 2. Create a Copilot Studio agent

1. Navigate to [copilotstudio.microsoft.com](https://copilotstudio.microsoft.com)
2. Click **Create** → **New agent**
3. Name: **Mandumah Research Assistant** (or similar)
4. Language: Arabic (العربية) as primary, English as secondary
5. Click **Create**

---

## 3. Add the MCP server as a tool connection

1. In the agent editor, open the **Tools** tab (left sidebar)
2. Click **+ Add a tool** → **Model Context Protocol (MCP)**
3. Fill in:
   - **Name:** `Mandumah Search`
   - **Server URL:** `https://<your-host>/mcp`
   - **Authentication type:** `API key`
   - **API key header name:** `X-API-Key`
   - **API key value:** `<your-key>` *(enter securely; never commit to source control)*
4. Click **Connect**
5. Copilot Studio will discover the tools. Verify you see **4 tools** in the list:
   - `search_articles`
   - `get_article`
   - `get_article_passages`
   - `get_corpus_overview`

---

## 4. Write agent instructions

Paste the following into the agent's **Instructions** field (System prompt):

```
You are a research assistant specialising in Arabic academic literature from the Mandumah corpus.

Rules:
- Answer ONLY from what the Mandumah tools return. Do not use general knowledge.
- Always call search_articles with an Arabic query for best results.
- Cite sources using the pdf_url from search results. Format citations as [عنوان المقال](pdf_url).
- Answer in the same language the user writes in. If they write in Arabic, reply in Arabic; if English, reply in English.
- When low_confidence is true in the search result, say "النتائج أولية وقد لا تكون دقيقة" before summarising.
- If no results are found or confidence is too low, say so and suggest rephrasing the query in Arabic.
- Use get_article_passages to drill into a specific article rather than loading the full text.
- Use get_corpus_overview to answer questions like "how many articles do you have?".
```

---

## 5. Publish to Teams / demo website

1. Click **Publish** in the top-right corner
2. Choose **Microsoft Teams** or **Demo website**
3. For Teams: follow the prompts to create a Teams app manifest and submit
4. For demo website: copy the embed code

---

## 6. Rehearsed demo questions

The following five questions exercise all four MCP tools and produce demo-quality answers.
Replace the placeholders with actual corpus topics before the demo.

| # | Question (Arabic) | Expected tool(s) called |
|---|---|---|
| 1 | ما هي أبرز الدراسات حول التعلم الإلكتروني في التعليم العالي؟ | `search_articles` |
| 2 | كم عدد المقالات التي يغطيها هذا النظام؟ | `get_corpus_overview` |
| 3 | هل يمكنك إيجاد مقالات تتحدث عن دور المعلم في التعليم عن بُعد؟ | `search_articles` |
| 4 | اشرح محتوى هذا البحث بالتفصيل: [أدرج doc_id من نتيجة سابقة] | `get_article` or `get_article_passages` |
| 5 | ما الفرق بين التعليم المدمج والتعليم الإلكتروني بحسب المصادر؟ | `search_articles` (multiple results) |

> **Before the demo:** run each question once in Copilot Studio and record the answers here.
> Fill in the actual expected answers in the table below:

| # | Final answer summary | Notes |
|---|---|---|
| 1 | *(fill after rehearsal)* | |
| 2 | *(fill after rehearsal)* | |
| 3 | *(fill after rehearsal)* | |
| 4 | *(fill after rehearsal)* | |
| 5 | *(fill after rehearsal)* | |

---

## 7. Security checklist before public exposure

- [ ] Server is behind HTTPS (never expose plain HTTP to the internet)
- [ ] `API_KEY` is set on the deployed instance
- [ ] `API_KEY` value is **not** committed to the git repository
  (`grep -r "API_KEY" .` — only env references, not actual values)
- [ ] `/docs` (OpenAPI) is only accessible over HTTPS with the API key
  (or disabled for production: `app = FastAPI(docs_url=None, redoc_url=None)`)
- [ ] Tool responses never expose filesystem paths or stack traces
  (test by stopping Qdrant and calling `search_articles` — error should be generic)

---

## 8. Phase 2 (gallery submission — out of scope now)

The current server uses API-key auth (`X-API-Key` header). Microsoft's Copilot connector
gallery requires OAuth 2.1 / Entra ID. This is tracked as a `# phase 2: OAuth` comment
in `backend/main.py` and `backend/mcp_server.py`. Do not implement until the gallery
submission phase is started.

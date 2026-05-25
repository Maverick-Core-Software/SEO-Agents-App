# Grizzly SEO Agents

CrewAI is installed in `.venv` and this repo is wired for the Grizzly Electrical Solutions local SEO agent crew.

Imported agents:

- Grizzly Local Presence Agent-Manager
- Grizzly Content and Keyword Agent
- Grizzly Website SEO Agent
- GBP and Local Rankings Agent
- Reviews and Reputation Agent

Imported baseline reports live in `knowledge/baselines/`. Agent prompt files live in `prompts/agents/`.

## Setup

```powershell
.\.venv\Scripts\Activate.ps1
pip install -e .
Copy-Item .env.example .env
```

Add your `OPENAI_API_KEY` to `.env`. Add `SERPER_API_KEY` if you want live Google-style search through Serper.

## Run

Validate the crew without calling an LLM:

```powershell
seo-agents "electrical troubleshooting service page" --dry-run
```

Run the Grizzly local presence crew:

```powershell
seo-agents "electrical troubleshooting service page" --site-url "https://www.grizzlyelectricaltx.com/" --region "DFW, Texas"
```

The crew writes the final manager plan to `outputs/grizzly_local_presence_plan.md`.

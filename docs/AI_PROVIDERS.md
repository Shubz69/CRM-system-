# AI providers

Agent Desk's AI layer is provider-agnostic by design: every feature calls
`getAiProvider()` from `src/adapters/ai`, which returns an object implementing
the shared `AiProvider` interface (`complete()` and `analyseConversation()`).
Swapping or adding a provider never touches feature code.

## Anthropic Claude — primary, default

Claude is the only provider every part of the app relies on implicitly.
`ANTHROPIC_API_KEY` unset means AI features either fail closed
(`NotConfiguredAiProvider`) or use a deterministic mock outside production —
never a silent broken call, never invented output.

## Optional secondary / free-tier providers

These exist for three reasons, matched to what each is actually good for:

- **New capabilities** — a provider that's meaningfully better or cheaper at
  a specific job (e.g. Gemini's long context, Groq's raw speed for
  latency-sensitive tasks).
- **Reliability / fallback** — if Anthropic has an outage or gets
  rate-limited, a feature can explicitly fall back to a secondary provider
  instead of failing.
- **Cost savings on high-volume/cheap tasks** — classification, sentiment,
  and summary tasks run far more often than reasoning-heavy ones. Routing
  those to a free tier can cut spend without touching quality where it
  matters.

None of them are required, and none of them silently replace Claude. Each is
reached only by an explicit `getAiProvider("groq" | "mistral" | "deepseek" |
"gemini")` call from a feature, or by setting `AI_PROVIDER` globally in env.
If the corresponding API key is missing, the app logs a warning and falls
back to Anthropic (or a mock outside production) — the same fail-closed
convention used everywhere else in this codebase (see `SocialNotConfiguredError`,
`SourceNotConfiguredError`).

| Provider | Free tier | Best for | Get a key |
|---|---|---|---|
| Groq | Yes — generous, fast Llama/Qwen inference | Latency-sensitive tasks, high request volume | console.groq.com |
| Google Gemini | Yes — Flash/Flash-Lite have a real daily free quota | Long context, general-purpose free tier | aistudio.google.com |
| Mistral | Free/experiment usage tier with rate limits | European-hosted alternative, coding tasks | console.mistral.ai |
| DeepSeek | Very low cost per token (not free, but cheap) | Bulk/background tasks where cost matters most | platform.deepseek.com |

Add the relevant `*_API_KEY` in `.env` (see `.env.example` for the full list,
including per-tier model overrides). Gemini's chat models share
`GEMINI_API_KEY` with the image-generation adapter — the chat model IDs are
configured separately (`GEMINI_CHAT_*_MODEL`) so the two features never
fight over one model env var.

### Model IDs move fast — check before relying on them

Every provider's model catalog changes over time (new releases, retirements).
The defaults baked into `src/lib/ai-models.ts` are what was current when this
was written; they are always overridable via env
(`GROQ_ADVANCED_MODEL`, `MISTRAL_DEFAULT_MODEL`, etc.). Before switching any
real traffic to one of these providers, check the provider's own docs for
their current model IDs and update the env override rather than assuming the
shipped default is still valid.

### What's not built yet (deliberately)

- **No automatic cross-provider fallback loop.** If Anthropic fails mid-request
  today, the request fails — it does not silently retry on Groq. Wiring that
  up is a reasonable next step, but it changes latency/cost/quality
  characteristics for every caller, so it should be an explicit, reviewed
  decision per feature rather than a blanket default.
- **No admin UI to pick a provider per task yet.** `src/services/ai-router.ts`
  already lets an admin remap which *tier* (cheap/balanced/heavy) handles
  each task type, stored in `SystemSetting` under key `ai.router`. Extending
  that to also pick a *provider* per task is straightforward given the
  adapters that now exist, but is a UI + admin-route change left for when
  there's a concrete cost/reliability need driving it.

## Research/listening sources are separate

The optional AI chat providers above are unrelated to the Apify-backed
research adapters in `src/adapters/sources` (Instagram/LinkedIn/TikTok/
Twitter-X/Threads listening) — those are a different system entirely, gated
on `APIFY_TOKEN`. See the top-level `README.md` and
`src/adapters/sources/apify-platforms.ts` for that side.

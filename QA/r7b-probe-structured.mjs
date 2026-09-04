import { config as loadEnv } from "dotenv";
loadEnv();

const k = process.env.ANTHROPIC_API_KEY;
if (!k) {
  console.log("NO_KEY");
  process.exit(1);
}

const schema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          sourceUrl: { type: "string" },
          evidenceExcerpt: { type: "string" },
          claimKind: {
            type: "string",
            enum: ["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"],
          },
          confidence: { type: "number" },
        },
        required: ["claim", "sourceUrl"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

const models = [
  process.env.ANTHROPIC_ECONOMY_MODEL || "claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
];

for (const model of models) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": k,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "Return empty findings array JSON" }],
      output_config: { format: { type: "json_schema", schema } },
    }),
  });
  const t = await r.text();
  console.log(model, r.status, t.slice(0, 220).replace(/\s+/g, " "));
}

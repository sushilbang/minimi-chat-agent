import "dotenv/config";

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  braveKey: process.env.BRAVE_API_KEY ?? "",
  model: process.env.AGENT_MODEL ?? "claude-sonnet-5-5",
  fastModel: process.env.FAST_MODEL ?? "claude-haiku-5-5",
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./data/agent.db",
  /** Max tool rounds per turn before the model is forced to answer. */
  maxRounds: 4,
};

export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.anthropicKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.braveKey) missing.push("BRAVE_API_KEY");
  if (missing.length) {
    console.error(
      `Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
}

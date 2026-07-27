const { Redis } = require("@upstash/redis");

// Vercelの環境変数(UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)が
// 設定されていればそちらを優先し、無ければ本体側(auth.js)と同じ接続先にフォールバックする。
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "https://big-monkfish-128403.upstash.io",
  token:
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    "gQAAAAAAAfWTAAIgcDFiMmMyYjE5ZTA5ODc0Y2ZiYTM2NGFiYTU4MWVlMGViYQ",
});

module.exports = { kv };

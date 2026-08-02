const { kv } = require("./redis");

/**
 * test-invidious.js - Vercelから本当にInvidiousに繋がる瞬間があるのか、
 * 時間いっぱい粘って確かめるための使い捨てテスト用エンドポイント。
 *
 * 「1回叩いてダメだった」ではなく、50秒間ひたすら繰り返し叩いてみて、
 * 1回でも成功するかどうかを見る。
 * ------------------------------------------------------------
 */

const INSTANCE_LIST_URL = "https://api.invidious.io/instances.json?sort_by=type,health";
const FALLBACK_INSTANCES = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.privacydev.net",
  "https://iv.ggtyler.dev",
  "https://invidious.f5.si",
];

const TEST_VIDEO_ID = "dQw4w9WgXcQ";
const TIME_BUDGET_MS = 50000; // 50秒粘る
const PER_TRY_TIMEOUT_MS = 4000;

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialInstanceList() {
  try {
    const res = await fetchWithTimeout(INSTANCE_LIST_URL, 8000);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(([, details]) => details?.type === "https")
      .map(([domain, details]) => details?.uri || `https://${domain}`)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  let instances = await fetchOfficialInstanceList();
  if (instances.length === 0) instances = FALLBACK_INSTANCES;

  let attempts = 0;
  let successes = 0;
  const successDetails = [];
  const errorSamples = [];

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const base = instances[attempts % instances.length];
    attempts++;
    const tryStart = Date.now();
    try {
      const url = `${base.replace(/\/$/, "")}/api/v1/videos/${TEST_VIDEO_ID}?region=JP`;
      const r = await fetchWithTimeout(url, PER_TRY_TIMEOUT_MS);
      const latency = Date.now() - tryStart;
      if (!r.ok) {
        if (errorSamples.length < 5)
          errorSamples.push({ base, status: r.status, latency });
        continue;
      }
      const data = await r.json();
      const hasRelated =
        Array.isArray(data?.relatedVideos) && data.relatedVideos.length > 0;
      if (hasRelated) {
        successes++;
        if (successDetails.length < 5) successDetails.push({ base, latency });
      } else if (errorSamples.length < 5) {
        errorSamples.push({ base, status: "no_related_field", latency });
      }
    } catch (e) {
      if (errorSamples.length < 5)
        errorSamples.push({
          base,
          status: "error",
          message: e.message,
          latency: Date.now() - tryStart,
        });
    }
  }

  return res.status(200).json({
    durationMs: Date.now() - startedAt,
    instancesUsed: instances.length,
    attempts,
    successes,
    successRate: attempts > 0 ? `${((successes / attempts) * 100).toFixed(1)}%` : "0%",
    successDetails,
    errorSamples,
  });
};

const { kv } = require("./redis");

/**
 * test-invidious.js - Vercelから本当にInvidiousに繋がるのか、
 * kanrenn.js(本家・実際に動いている方)と全く同じ27個の固定リストを使って
 * 時間いっぱい粘って確かめるための使い捨てテスト用エンドポイント。
 *
 * 前回のテストは「Invidious公式の生存インスタンス一覧API」を使っていたが、
 * それとは別に、kanrenn.js自体が持つ実績のある27個の固定リストで
 * 試したらCodeSandboxからは繋がった実績があるため、
 * 今回は同じ条件でVercelからも試す。
 * ------------------------------------------------------------
 */

// kanrenn.js(本家)と全く同じ27個の固定リスト・同じ順番
const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.f5.si",
  "https://invidious.lunivers.trade",
  "https://invidious.ducks.party",
  "https://iv.melmac.space",
  "https://invidious.nerdvpn.de",
  "https://invidious.privacyredirect.com",
  "https://invidious.technicalvoid.dev",
  "https://invidious.darkness.services",
  "https://invidious.nikkosphere.com",
  "https://invidious.schenkel.eti.br",
  "https://invidious.tiekoetter.com",
  "https://invidious.perennialte.ch",
  "https://invidious.reallyaweso.me",
  "https://invidious.private.coffee",
  "https://invidious.privacydev.net",
  "https://yewtu.be",
  "https://iv.nboeck.de",
  "https://inv.tux.pizza",
  "https://iv.ggtyler.dev",
  "https://yt.omada.cafe",
  "https://super8.absturztau.be",
  "https://invidious.adminforge.de",
  "https://youtube.alt.tyil.nl",
  "https://rust.oskamp.nl",
  "https://invidious.nietzospannend.nl",
  "https://youtube.mosesmang.com",
];

const TEST_VIDEO_ID = "dQw4w9WgXcQ";
const TIME_BUDGET_MS = 50000; // 50秒粘る
const PER_TRY_TIMEOUT_MS = 2500; // kanrenn.jsと同じ秒数

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  const instances = INVIDIOUS_INSTANCES;

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
        if (errorSamples.length < 10)
          errorSamples.push({ base, status: r.status, latency });
        continue;
      }
      const data = await r.json();
      // relatedVideos と recommendedVideos の両方をチェック（kanrenn.jsと同じ）
      const related = data?.relatedVideos || data?.recommendedVideos || [];
      if (related.length > 0) {
        successes++;
        if (successDetails.length < 10) successDetails.push({ base, latency });
      } else if (errorSamples.length < 10) {
        errorSamples.push({ base, status: "no_related_field", latency });
      }
    } catch (e) {
      if (errorSamples.length < 10)
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

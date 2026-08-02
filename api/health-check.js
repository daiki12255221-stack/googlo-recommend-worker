const { kv } = require("./redis");

/**
 * health-check.js - server3「健康診断係」
 * ------------------------------------------------------------
 * cron-job.orgから1時間おきに叩かれる想定。
 *
 * 固定の27個リストは古くなって死んでるインスタンスだらけだったので、
 * Invidious公式が公開している「今生きてるインスタンス一覧」API
 * (api.invidious.io/instances.json) を毎回取得し、その中から
 * 実際に関連動画(relatedVideos)を返せるインスタンスをテストする。
 *
 * 消える心配がほぼ無い有名な固定動画(Never Gonna Give You Up)で
 * テストし、速い順に上位5つを「スタメン」として
 * recommend:healthy_instances に保存する。
 *
 * 公式リストの取得自体に失敗した場合は、保険として固定リストにフォールバックする。
 * ------------------------------------------------------------
 */

// 保険用のフォールバックリスト（公式リスト取得に失敗した時だけ使う）
const FALLBACK_INSTANCES = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.privacydev.net",
  "https://iv.ggtyler.dev",
  "https://invidious.f5.si",
];

const INSTANCE_LIST_URL = "https://api.invidious.io/instances.json?sort_by=type,health";
const TEST_VIDEO_ID = "dQw4w9WgXcQ"; // Never Gonna Give You Up（定番の消えない動画）
const PING_TIMEOUT_MS = 5000;
const LIST_TIMEOUT_MS = 8000;
const TOP_N = 5;

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Invidious公式の「生きてるインスタンス一覧」を取得する
async function fetchOfficialInstanceList() {
  try {
    const res = await fetchWithTimeout(INSTANCE_LIST_URL, LIST_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    // 形式: [ ["domain.com", { type: "https", uri: "https://domain.com", ... }], ... ]
    return data
      .filter(([, details]) => details?.type === "https")
      .map(([domain, details]) => details?.uri || `https://${domain}`)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  try {
    let instances = await fetchOfficialInstanceList();
    let usedFallback = false;
    if (instances.length === 0) {
      instances = FALLBACK_INSTANCES;
      usedFallback = true;
    }

    const results = await Promise.allSettled(
      instances.map(async (base) => {
        const start = Date.now();
        const url = `${base.replace(/\/$/, "")}/api/v1/videos/${TEST_VIDEO_ID}?region=JP`;
        const r = await fetchWithTimeout(url, PING_TIMEOUT_MS);
        const latency = Date.now() - start;

        if (!r.ok) return { base, alive: false, hasRelated: false, latency };

        const data = await r.json();
        const hasRelated =
          Array.isArray(data?.relatedVideos) && data.relatedVideos.length > 0;

        return { base, alive: true, hasRelated, latency };
      })
    );

    const all = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    const alive = all.filter((v) => v.alive);
    const workingRelated = all
      .filter((v) => v.hasRelated)
      .sort((a, b) => a.latency - b.latency);

    const topInstances = workingRelated.slice(0, TOP_N).map((v) => v.base);

    if (topInstances.length > 0) {
      await kv.set("recommend:healthy_instances", JSON.stringify(topInstances));
    }

    return res.status(200).json({
      usedFallback,
      checked: instances.length,
      alive: alive.length,
      relatedVideosWorking: workingRelated.length,
      selected: topInstances,
    });
  } catch (error) {
    console.error("[health-check] エラー:", error);
    return res
      .status(500)
      .json({ error: "health check failed", details: error.message });
  }
};

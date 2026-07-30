const { kv } = require("./redis");

/**
 * health-check.js - server3「健康診断係」
 * ------------------------------------------------------------
 * cron-job.orgから1時間おきに叩かれる想定。
 *
 * ただの生存確認(/api/v1/stats)だけだと「関連動画(relatedVideos)が
 * ちゃんと機能してるか」までは分からないので、消える心配がほぼ無い
 * 有名な固定動画(Never Gonna Give You Up)で実際に関連動画を取得できるか
 * をテストする。取れたインスタンスの中から速い順に上位5つを
 * 「スタメン」として recommend:healthy_instances に保存する。
 * ------------------------------------------------------------
 */

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

// テスト用の固定動画（Never Gonna Give You Up。消える心配がほぼ無い定番動画）
const TEST_VIDEO_ID = "dQw4w9WgXcQ";
const PING_TIMEOUT_MS = 5000;
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

module.exports = async function handler(req, res) {
  try {
    const results = await Promise.allSettled(
      INVIDIOUS_INSTANCES.map(async (base) => {
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
      checked: INVIDIOUS_INSTANCES.length,
      alive: alive.length, // 応答自体はあったインスタンス数
      relatedVideosWorking: workingRelated.length, // その中で関連動画も返せたインスタンス数
      selected: topInstances,
    });
  } catch (error) {
    console.error("[health-check] エラー:", error);
    return res
      .status(500)
      .json({ error: "health check failed", details: error.message });
  }
};

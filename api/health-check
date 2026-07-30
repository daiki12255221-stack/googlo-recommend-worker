const { kv } = require("./redis");

/**
 * health-check.js - server3「健康診断係」
 * ------------------------------------------------------------
 * cron-job.orgから1時間おきに叩かれる想定。
 * Invidiousインスタンス27個全部に軽いリクエストを送って、
 * 生きていて・速いものを上位5つ「スタメン」として選び、
 * recommend:healthy_instances に保存する。
 *
 * server1(compute.js)はこのスタメンだけを使ってfetchするようになる。
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

const PING_TIMEOUT_MS = 4000;
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
        const url = `${base.replace(/\/$/, "")}/api/v1/stats`;
        const r = await fetchWithTimeout(url, PING_TIMEOUT_MS);
        if (!r.ok) throw new Error("not ok");
        await r.json(); // 中身がちゃんとJSONとして返ってくるかも確認する
        return { base, latency: Date.now() - start };
      })
    );

    const alive = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => a.latency - b.latency);

    const topInstances = alive.slice(0, TOP_N).map((v) => v.base);

    if (topInstances.length > 0) {
      await kv.set("recommend:healthy_instances", JSON.stringify(topInstances));
    }

    return res.status(200).json({
      checked: INVIDIOUS_INSTANCES.length,
      alive: alive.length,
      selected: topInstances,
    });
  } catch (error) {
    console.error("[health-check] エラー:", error);
    return res
      .status(500)
      .json({ error: "health check failed", details: error.message });
  }
};

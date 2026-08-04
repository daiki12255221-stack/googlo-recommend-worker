const { kv } = require("./redis");
const RELAY_BASE = "https://t8rymp-8080.csb.app";
const RELAY_TIMEOUT_MS = 15000;
const YT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3; // 初回 + お残しリトライ2回

const FALLBACK_KEYS = [
  "AIzaSyBfCvyZ_J9mJiMFNYB6WfcuLyvf9zDdcUU",
  "AIzaSyCgVn-JWHKT_z6EC73Z6Vlex0F_d-BP_fY",
  "AIzaSyBbqPhAbqoWDOurTt7hejQmwc6dAoZ5Iy0",
  "AIzaSyAWk9mmie23-khi8-nipv1jHJND__UtEWA",
  "AIzaSyBL38iyqeiaKHoKqhloSnhG590DfJ35vCE",
  "AIzaSyDU4jrOT0o2Jd4zDwZyU5OOBsKt1P3RJNs",
  "AIzaSyB2L_plk45E1wihBUB4VJ516pIfqcBc2Yw",
  "AIzaSyDcYrvxFDKcXNqI65Aihrqk0uK2Ebj7KVo",
  "AIzaSyAmfASO-61oyXFOfzJCR9e3oGbnKenBZb",
  "AIzaSyCU7xnDWAFbXt1ze0_DBaWDKt7NDT1XP7",
];
let fallbackKeyIndex = 0;
function getNextFallbackKey() {
  const key = FALLBACK_KEYS[fallbackKeyIndex % FALLBACK_KEYS.length];
  fallbackKeyIndex = (fallbackKeyIndex + 1) % FALLBACK_KEYS.length;
  return key;
}

function getVideoId(item) {
  if (!item) return "";
  return (
    item.videoId ||
    item.id?.videoId ||
    (typeof item.id === "string" ? item.id : "") ||
    item.contentDetails?.videoId ||
    ""
  );
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchWithTimeout(url, ms, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Invidiousへのアクセス ────────────────────────────
async function fetchInvidious(path) {
  if (!RELAY_BASE) {
    console.error("[compute] INVIDIOUS_RELAY_URL が設定されていません");
    return null;
  }
  try {
    const url = `${RELAY_BASE.replace(/\/$/, "")}/api/invidious-relay?path=${encodeURIComponent(path)}`;
    const res = await fetchWithTimeout(url, RELAY_TIMEOUT_MS, {
      headers: { Cookie: "csb_is_trusted=true" },
    });

    if (!res.ok) {
      let detail = null;
      try {
        detail = await res.json();
      } catch (_) {}
      console.error(
        `[compute] invidious-relay 失敗 path=${path} status=${res.status}`,
        JSON.stringify(detail?.errorSamples || detail || {})
      );
      return null;
    }

    const json = await res.json();
    return json?.data || null;
  } catch (e) {
    console.error(`[compute] invidious-relay 通信エラー path=${path}:`, e.message);
    return null;
  }
}

async function fetchYouTube(endpoint, params, apiKey, retried = false) {
  const key = apiKey || getNextFallbackKey();
  const qs = new URLSearchParams({ ...params, key });
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`;
  try {
    const res = await fetchWithTimeout(url, YT_TIMEOUT_MS);
    if (res.status === 403 && !retried)
      return fetchYouTube(endpoint, params, getNextFallbackKey(), true);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

// Invidiousからは関連動画の「ID」のみを抽出して返す
async function fetchRelatedIds(vId, limit = 2) {
  const data = await fetchInvidious(`/api/v1/videos/${vId}?region=JP`);
  const related = data?.relatedVideos || data?.recommendedVideos || [];
  return related
    .map((rv) => rv.videoId || (typeof rv.id === "string" ? rv.id : ""))
    .filter(Boolean)
    .slice(0, limit);
}

// YouTube APIからSnippet（動画情報）とStatistics（スコア計算用）を一括取得する
async function fetchVideoDetailsAndScore(ids, apiKey) {
  const result = {};
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50)); // videos APIは最大50件まで一括可能

  await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        const data = await fetchYouTube(
          "videos",
          { id: batch.join(","), part: "snippet,statistics" },
          apiKey
        );
        if (!data?.items) return;
        for (const item of data.items) {
          const likes = parseInt(item.statistics?.likeCount || "0");
          const dislikes = parseInt(item.statistics?.dislikeCount || "0");
          const views = parseInt(item.statistics?.viewCount || "0");
          const score =
            likes + dislikes > 0
              ? (likes / (likes + dislikes)) * 100
              : views > 0
              ? Math.min((likes / views) * 1000, 100)
              : 0;

          result[item.id] = {
            snippet: item.snippet,
            score,
          };
        }
      } catch (_) {}
    })
  );
  return result;
}

async function processWithRetry(items, workerFn, maxAttempts = MAX_ATTEMPTS) {
  let pending = [...items];
  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    const outcomes = await Promise.allSettled(pending.map((item) => workerFn(item)));
    const leftover = [];
    outcomes.forEach((o, i) => {
      const success = o.status === "fulfilled" && o.value === true;
      if (!success) leftover.push(pending[i]);
    });
    pending = leftover;
  }
  return pending;
}

function buildInitialProgress(data) {
  const watchArr = Array.isArray(data?.yt_history) ? data.yt_history : [];
  const searchArr = Array.isArray(data?.yt_search_history)
    ? data.yt_search_history
    : [];

  const searchKeywords = searchArr
    .slice(0, 10)
    .map((s) => (typeof s === "string" ? s : s?.term))
    .filter(Boolean);

  const seenIds = new Set();
  for (const item of watchArr.slice(0, 10)) {
    const id = item?.id || (typeof item === "string" ? item : "");
    if (id) seenIds.add(id);
  }

  return {
    stage: "search",
    searchKeywords,
    recentWatch: watchArr.slice(0, 20),
    midWatch: shuffle(watchArr.slice(20, 100)).slice(0, 10),
    longWatch: shuffle(watchArr.slice(100, 500)).slice(0, 10),
    chCount: {},
    tagCount: {},
    candidates: [],
    seenIds: Array.from(seenIds),
    trendingPool: [],
    gaveUp: {},
  };
}

module.exports = async function handler(req, res) {
  try {
    if (!RELAY_BASE) {
      return res.status(500).json({
        error: "INVIDIOUS_RELAY_URL が設定されていません。Vercelの環境変数に追加してください。",
      });
    }

    let username = await kv.get("recommend:current_user");
    if (!username) {
      username = await kv.lpop("recommend:queue");
      if (!username) {
        return res.status(200).json({ message: "キューに誰もいません" });
      }
      await kv.set("recommend:current_user", username);
      await kv.set(`recommend:${username}:status`, "computing");
    }

    const progressKey = `recommend:${username}:progress`;
    const rawProgress = await kv.get(progressKey);
    let progress = rawProgress
      ? typeof rawProgress === "string"
        ? JSON.parse(rawProgress)
        : rawProgress
      : null;

    if (!progress) {
      const rawData = await kv.get(`user:${username}:data`);
      const data = rawData
        ? typeof rawData === "string"
          ? JSON.parse(rawData)
          : rawData
        : {};
      progress = buildInitialProgress(data);
    }
    if (!progress.gaveUp) progress.gaveUp = {};

    const seenIds = new Set(progress.seenIds);
    const addIfNew = (id) => {
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    };

    switch (progress.stage) {
      case "search": {
        await Promise.allSettled(
          progress.searchKeywords.map(async (word) => {
            if (!word) return;
            const data = await fetchYouTube("search", {
              q: word,
              part: "snippet",
              type: "video",
              maxResults: 3,
              regionCode: "JP",
            });
            if (!data?.items) return;
            for (const item of data.items) {
              const id = getVideoId(item);
              if (!addIfNew(id)) continue;
              progress.candidates.push({
                id,
                _route: "search",
                _sourceRef: word,
              });
            }
          })
        );
        progress.stage = "watch_recent";
        break;
      }

      case "watch_recent": {
        const gaveUp = await processWithRetry(progress.recentWatch, async (item) => {
          const id = item?.id || (typeof item === "string" ? item : "");
          if (!id) return true;
          const chId = item?.channelId || item?.snippet?.channelId || "";
          if (chId) progress.chCount[chId] = (progress.chCount[chId] || 0) + 1;

          // InvidiousからはIDのみ取得
          const relatedIds = await fetchRelatedIds(id, 2);
          for (const rvId of relatedIds) {
            if (!addIfNew(rvId)) continue;
            progress.candidates.push({
              id: rvId,
              _route: "watch_recent",
              _sourceRef: id,
            });
          }
          return relatedIds.length > 0;
        });
        progress.gaveUp.watch_recent = gaveUp.map((it) => it?.id || it);
        progress.stage = "watch_mid";
        break;
      }

      case "watch_mid": {
        const gaveUp = await processWithRetry(progress.midWatch, async (item) => {
          const id = item?.id || (typeof item === "string" ? item : "");
          if (!id) return true;

          // InvidiousからはIDのみ取得
          const relatedIds = await fetchRelatedIds(id, 1);
          for (const rvId of relatedIds) {
            if (!addIfNew(rvId)) continue;
            progress.candidates.push({
              id: rvId,
              _route: "watch_mid",
              _sourceRef: id,
            });
          }
          return relatedIds.length > 0;
        });
        progress.gaveUp.watch_mid = gaveUp.map((it) => it?.id || it);
        progress.stage = "long_tag";
        break;
      }

      case "long_tag": {
        const gaveUp = await processWithRetry(progress.longWatch, async (item) => {
          const id = item?.id || (typeof item === "string" ? item : "");
          if (!id) return true;
          const data = await fetchInvidious(`/api/v1/videos/${id}?fields=keywords`);
          if (!data?.keywords) return false;
          for (const tag of data.keywords) {
            progress.tagCount[tag] = (progress.tagCount[tag] || 0) + 1;
          }
          return true;
        });
        progress.gaveUp.long_tag = gaveUp.map((it) => it?.id || it);

        const topTag = Object.entries(progress.tagCount).sort(
          (a, b) => b[1] - a[1]
        )[0]?.[0];
        if (topTag) {
          const data = await fetchYouTube("search", {
            q: topTag,
            part: "snippet",
            type: "video",
            maxResults: 10,
            regionCode: "JP",
          });
          if (data?.items) {
            for (const item of data.items) {
              const id = getVideoId(item);
              if (!addIfNew(id)) continue;
              progress.candidates.push({
                id,
                _route: "long_tag",
                _sourceRef: topTag,
              });
            }
          }
        }
        progress.stage = "fav_channel";
        break;
      }

      case "fav_channel": {
        const topChId = Object.entries(progress.chCount).sort(
          (a, b) => b[1] - a[1]
        )[0]?.[0];
        if (topChId) {
          let data = null;
          for (let i = 0; i < MAX_ATTEMPTS && !data; i++) {
            data = await fetchInvidious(`/api/v1/channels/${topChId}/videos?region=JP`);
          }
          const chVideos = data?.videos || data?.items || [];
          const picked = shuffle(chVideos).slice(0, 10);
          for (const v of picked) {
            const id = v.videoId || v.id || "";
            if (!addIfNew(id)) continue;
            // InvidiousからはIDのみ取得して追加
            progress.candidates.push({
              id,
              _route: "fav_channel",
              _sourceRef: topChId,
            });
          }
        }
        progress.stage = "trending";
        break;
      }

      case "trending": {
        let data = null;
        for (let i = 0; i < MAX_ATTEMPTS && !data?.items; i++) {
          data = await fetchYouTube("videos", {
            chart: "mostPopular",
            part: "snippet",
            maxResults: 24,
            regionCode: "JP",
          });
        }
        const trendingArr = data?.items || [];
        progress.trendingPool = shuffle(trendingArr)
          .slice(0, 10)
          .map((item) => {
            const id = getVideoId(item);
            return {
              id,
              snippet: item.snippet,
              _route: "trending",
              _sourceRef: "trending",
              _score: null,
            };
          })
          .filter((v) => v.id);
        progress.stage = "substitute";
        break;
      }

      case "substitute": {
        if (progress.candidates.length < 90) {
          const shortage = 90 - progress.candidates.length;
          const triggers = shuffle(progress.candidates).slice(0, shortage);
          const gaveUp = await processWithRetry(triggers, async (v) => {
            if (progress.candidates.length >= 90) return true;

            // InvidiousからはIDのみ取得
            const relatedIds = await fetchRelatedIds(v.id, 1);
            for (const rvId of relatedIds) {
              if (!addIfNew(rvId)) continue;
              progress.candidates.push({
                id: rvId,
                _route: "substitute",
                _sourceRef: v.id,
              });
              break;
            }
            return relatedIds.length > 0;
          });
          progress.gaveUp.substitute = gaveUp.map((it) => it?.id || it);
        }
        progress.stage = "scoring";
        break;
      }

      case "scoring": {
        const scoringTargets = progress.candidates.slice(0, 90);
        const ids = scoringTargets.map((v) => v.id);

        // YouTube Data API から snippet と score(statistics) を一括取得
        const detailsMap = await fetchVideoDetailsAndScore(ids);

        const scoredVideos = scoringTargets
          .map((v) => {
            const details = detailsMap[v.id];
            return {
              ...v,
              snippet: details?.snippet || {},
              _score: details?.score ?? 0,
            };
          })
          .filter((v) => v.snippet.title) // YouTube API側で消えていた動画（非公開等）を除外
          .sort((a, b) => b._score - a._score);

        const result = [...scoredVideos];
        const trendingPool = progress.trendingPool || [];
        for (let i = trendingPool.length - 1; i >= 0; i--) {
          const pos = Math.min(
            10 + (trendingPool.length - 1 - i) * 7,
            result.length
          );
          result.splice(pos, 0, trendingPool[i]);
        }

        const finalList = result.slice(0, 100).map((v) => ({
          id: v.id,
          snippet: v.snippet || {},
          _score: v._score ?? null,
          _route: v._route,
          _sourceRef: v._sourceRef,
        }));

        await kv.set(`recommend:${username}:display`, JSON.stringify(finalList));
        await kv.del(progressKey);
        await kv.del("recommend:current_user");
        await kv.set(`recommend:${username}:status`, "idle");

        return res.status(200).json({
          username,
          done: true,
          count: finalList.length,
          gaveUp: progress.gaveUp,
        });
      }

      default: {
        progress = buildInitialProgress({});
      }
    }

    progress.seenIds = Array.from(seenIds);
    await kv.set(progressKey, JSON.stringify(progress));

    return res.status(200).json({
      username,
      done: false,
      nextStage: progress.stage,
      candidateCount: progress.candidates.length,
    });
  } catch (error) {
    console.error("[compute] エラー:", error);
    return res
      .status(500)
      .json({ error: "compute failed", details: error.message });
  }
};

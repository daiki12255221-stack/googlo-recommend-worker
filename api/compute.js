const { kv } = require("./redis");

/**
 * compute.js - server1「計算係」
 * ------------------------------------------------------------
 * cron-job.orgから定期的に叩かれる想定。
 * タイムパトロール(recommend:queue)から1人取り出し、recommend.jsのロジックを
 * 「分類(カテゴリ)ごとに1回の呼び出しで1つずつ」処理していく。
 *
 * 分類の順番:
 *   search(検索履歴) → watch_recent(直近視聴) → watch_mid(中期視聴)
 *   → long_tag(長期視聴タグ) → fav_channel(お気に入りチャンネル)
 *   → trending(急上昇) → substitute(身代わり補充) → scoring(最終スコアリング)
 *
 * 各候補には _route(どの分類から来たか) と _sourceRef(その分類の中で
 * 具体的にどの検索ワード／どの動画がきっかけだったか) を必ず記録する。
 *
 * 「お残し」リトライ方式:
 *   各分類でネットワーク的に失敗した項目(=何も取れなかった項目)だけを
 *   メモっておき、最大2回まで再挑戦する。3回目もダメなら諦めて次の分類へ。
 *
 * インスタンス選定はserver3(health-check.js)が1時間おきに選んだ
 * 「スタメン」(recommend:healthy_instances)を優先して使う。
 * まだスタメンが無ければ全27インスタンスからその都度シャッフルして使う。
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
const TRY_INSTANCES_LIMIT = 5;
const INSTANCE_TIMEOUT_MS = 3000;
const YT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3; // 初回 + お残しリトライ2回

// スタメン(健康診断済みインスタンス)。handler()の先頭でRedisから読み込んで上書きする
let activeInstances = INVIDIOUS_INSTANCES;

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

function makeThumbUrl(id) {
  return `/api/thumb?id=${id}`;
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

function makeSnippet(rv) {
  return {
    title: rv.title || "",
    channelTitle: rv.author || rv.channelTitle || "",
    channelId: rv.authorId || rv.channelId || "",
    thumbnails: {
      high: { url: makeThumbUrl(rv.videoId || rv.id || "") },
      default: { url: makeThumbUrl(rv.videoId || rv.id || "") },
    },
    publishedAt: rv.publishedText || rv.published || "",
  };
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

// ─── Invidiousフェッチ（スタメンを優先して試す） ────────────────────────────
async function fetchInvidious(path) {
  const instances = shuffle(activeInstances).slice(0, TRY_INSTANCES_LIMIT);
  for (const base of instances) {
    try {
      const url = `${base.replace(/\/$/, "")}${path}`;
      const res = await fetchWithTimeout(url, INSTANCE_TIMEOUT_MS);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && !data.error) return data;
    } catch (_) {}
  }
  return null;
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

async function fetchRelated(vId, limit = 2) {
  const data = await fetchInvidious(`/api/v1/videos/${vId}?region=JP`);
  if (!data?.relatedVideos) return [];
  return data.relatedVideos.slice(0, limit);
}

async function scoreVideos(ids, apiKey) {
  const result = {};
  const batches = [];
  for (let i = 0; i < ids.length; i += 10) batches.push(ids.slice(i, i + 10));

  await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        const data = await fetchYouTube(
          "videos",
          { id: batch.join(","), part: "statistics" },
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
          result[item.id] = score;
        }
      } catch (_) {}
    })
  );
  return result;
}

// ─── 「お残し」リトライ方式の共通処理 ───────────────────────────────────────
// workerFn(item) は「データが取れたか(true/false)」を返す約束にする。
// falseだったものだけを、最大MAX_ATTEMPTS回まで繰り返し再挑戦する。
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
  return pending; // 最後まで取れなかった項目（諦めたもの）
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
    candidates: [], // { id, snippet, _route, _sourceRef }
    seenIds: Array.from(seenIds),
    trendingPool: [],
    gaveUp: {}, // 分類ごとに、リトライしても取れなかった項目の記録
  };
}

module.exports = async function handler(req, res) {
  try {
    // ⓪ スタメン(健康なインスタンス)を読み込む。無ければ全27個をそのまま使う
    const rawHealthy = await kv.get("recommend:healthy_instances");
    if (rawHealthy) {
      const parsed =
        typeof rawHealthy === "string" ? JSON.parse(rawHealthy) : rawHealthy;
      activeInstances =
        Array.isArray(parsed) && parsed.length > 0 ? parsed : INVIDIOUS_INSTANCES;
    } else {
      activeInstances = INVIDIOUS_INSTANCES;
    }

    // ① 今計算中のユーザーがいなければ、キューから1人取り出す
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

    // ② 初回ならデータを取得して進捗を組み立てる
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

    // ③ 現在の分類(stage)だけを処理する
    switch (progress.stage) {
      case "search": {
        // 検索ワードは1回叩けば結果が来るか来ないかはっきりするので、そのまま処理
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
                snippet: item.snippet,
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
          if (!id) return true; // 空データはリトライ対象にしない
          const chId = item?.channelId || item?.snippet?.channelId || "";
          if (chId) progress.chCount[chId] = (progress.chCount[chId] || 0) + 1;

          const related = await fetchRelated(id, 2);
          for (const rv of related) {
            const rvId = rv.videoId || rv.id || "";
            if (!addIfNew(rvId)) continue;
            progress.candidates.push({
              id: rvId,
              snippet: makeSnippet(rv),
              _route: "watch_recent",
              _sourceRef: id,
            });
          }
          return related.length > 0; // 何も取れなかった時だけ「失敗」扱いにする
        });
        progress.gaveUp.watch_recent = gaveUp.map((it) => it?.id || it);
        progress.stage = "watch_mid";
        break;
      }

      case "watch_mid": {
        const gaveUp = await processWithRetry(progress.midWatch, async (item) => {
          const id = item?.id || (typeof item === "string" ? item : "");
          if (!id) return true;
          const related = await fetchRelated(id, 1);
          for (const rv of related) {
            const rvId = rv.videoId || rv.id || "";
            if (!addIfNew(rvId)) continue;
            progress.candidates.push({
              id: rvId,
              snippet: makeSnippet(rv),
              _route: "watch_mid",
              _sourceRef: id,
            });
          }
          return related.length > 0;
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
                snippet: item.snippet,
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
          // 単発フェッチなので、失敗したら最大3回までその場で挑戦し直す
          let data = null;
          for (let i = 0; i < MAX_ATTEMPTS && !data; i++) {
            data = await fetchInvidious(`/api/v1/channels/${topChId}/videos?region=JP`);
          }
          const chVideos = data?.videos || data?.items || [];
          const picked = shuffle(chVideos).slice(0, 10);
          for (const v of picked) {
            const id = v.videoId || v.id || "";
            if (!addIfNew(id)) continue;
            progress.candidates.push({
              id,
              snippet: {
                title: v.title || "",
                channelTitle: v.author || v.channelTitle || "",
                channelId: topChId,
                thumbnails: {
                  high: { url: makeThumbUrl(id) },
                  default: { url: makeThumbUrl(id) },
                },
                publishedAt: v.publishedText || v.published || "",
              },
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
            const related = await fetchRelated(v.id, 1);
            for (const rv of related) {
              const rvId = rv.videoId || rv.id || "";
              if (!addIfNew(rvId)) continue;
              progress.candidates.push({
                id: rvId,
                snippet: makeSnippet(rv),
                _route: "substitute",
                _sourceRef: v.id,
              });
              break;
            }
            return related.length > 0;
          });
          progress.gaveUp.substitute = gaveUp.map((it) => it?.id || it);
        }
        progress.stage = "scoring";
        break;
      }

      case "scoring": {
        const scoringTargets = progress.candidates.slice(0, 90);
        const scoreMap = await scoreVideos(scoringTargets.map((v) => v.id));

        const scoredVideos = scoringTargets
          .map((v) => ({ ...v, _score: scoreMap[v.id] ?? 0 }))
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

        // 表示データへ一気に移す（計算中の歯抜け状態は絶対に見せない）
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

    // ④ この分類の処理結果を保存して、次回の呼び出しに続きを託す
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

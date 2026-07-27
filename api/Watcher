const { kv } = require("./_redis");

/**
 * watcher.js - server2「見張り係」
 * ------------------------------------------------------------
 * cron-job.org から5分おきに叩かれる想定。
 * 全ユーザーの履歴(yt_history / yt_search_history)と、
 * 前回チェック時点のスナップショット(history_check)を見比べて、
 * 新しく増えた履歴があれば「タイムパトロール」(recommend:queue)に並ばせる。
 *
 * 状態(status)が idle のユーザーだけを対象にすることで、
 * すでに並んでいる/計算中のユーザーを二重に並ばせないようにしている。
 * ------------------------------------------------------------
 */

// 履歴の中身から「比較用のスナップショット」を作る
// 動画IDの集合と、検索キーワードの集合だけ持っておけば差分判定には十分
function buildSnapshot(data) {
  const history = Array.isArray(data?.yt_history) ? data.yt_history : [];
  const searchHistory = Array.isArray(data?.yt_search_history)
    ? data.yt_search_history
    : [];

  return {
    historyIds: history.map((v) => v.id).filter(Boolean),
    searchTerms: searchHistory
      .map((s) => (typeof s === "string" ? s : s?.term))
      .filter(Boolean),
  };
}

// 新しく増えた要素があるかどうかだけを見る
// （履歴を消した／減った、は対象外。増えた時だけ反応する）
function hasNewItems(current, previous) {
  const prevIdSet = new Set(previous.historyIds || []);
  const prevTermSet = new Set(previous.searchTerms || []);

  const newVideo = current.historyIds.some((id) => !prevIdSet.has(id));
  if (newVideo) return true;

  const newTerm = current.searchTerms.some((term) => !prevTermSet.has(term));
  return newTerm;
}

module.exports = async function handler(req, res) {
  try {
    const usernames = await kv.smembers("all_users");

    if (!usernames || usernames.length === 0) {
      return res.status(200).json({ checked: 0, queued: [] });
    }

    const queuedThisRun = [];

    for (const username of usernames) {
      const statusKey = `recommend:${username}:status`;
      const checkKey = `recommend:${username}:history_check`;
      const dataKey = `user:${username}:data`;

      const status = (await kv.get(statusKey)) || "idle";
      if (status !== "idle") continue; // 並び中 or 計算中の人はスキップ（二重防止）

      const rawData = await kv.get(dataKey);
      if (!rawData) continue; // まだ一度もクラウド保存してないユーザーは対象外

      const data = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      const currentSnapshot = buildSnapshot(data);

      const rawCheck = await kv.get(checkKey);
      const previousSnapshot = rawCheck
        ? typeof rawCheck === "string"
          ? JSON.parse(rawCheck)
          : rawCheck
        : { historyIds: [], searchTerms: [] };

      if (hasNewItems(currentSnapshot, previousSnapshot)) {
        await kv.rpush("recommend:queue", username);
        await kv.set(statusKey, "queued");
        // 「もうこの分は見た」と記録しておく（同じ差分を毎回検知しないように）
        await kv.set(checkKey, JSON.stringify(currentSnapshot));
        queuedThisRun.push(username);
      }
    }

    return res.status(200).json({
      checked: usernames.length,
      queued: queuedThisRun,
    });
  } catch (error) {
    console.error("[watcher] エラー:", error);
    return res.status(500).json({ error: "watcher failed", details: error.message });
  }
};

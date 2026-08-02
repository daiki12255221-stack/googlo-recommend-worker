const { kv } = require("./redis");

/**
 * debug-user.js - 特定ユーザーの履歴チェック状況を直接見るための調査用API
 * 使い方: /api/debug-user?username=キック
 *
 * ログが見れなくても、これを開けば
 * ・今の本物の履歴(historyIds/searchTerms)
 * ・前回チェック時点のスナップショット(history_check)
 * ・その差分(新規と判定されるもの)
 * ・現在の状態(idle/queued/computing)
 * を直接確認できる。
 */

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

module.exports = async function handler(req, res) {
  const username = req.query.username;
  if (!username) {
    return res.status(400).json({ error: "username クエリパラメータが必要です" });
  }

  try {
    const status = (await kv.get(`recommend:${username}:status`)) || "idle";

    const rawData = await kv.get(`user:${username}:data`);
    const data = rawData
      ? typeof rawData === "string"
        ? JSON.parse(rawData)
        : rawData
      : null;
    const currentSnapshot = data ? buildSnapshot(data) : null;

    const rawCheck = await kv.get(`recommend:${username}:history_check`);
    const previousSnapshot = rawCheck
      ? typeof rawCheck === "string"
        ? JSON.parse(rawCheck)
        : rawCheck
      : null;

    let diff = null;
    if (currentSnapshot && previousSnapshot) {
      const prevIdSet = new Set(previousSnapshot.historyIds || []);
      const prevTermSet = new Set(previousSnapshot.searchTerms || []);
      diff = {
        newVideoIds: currentSnapshot.historyIds.filter((id) => !prevIdSet.has(id)),
        newTerms: currentSnapshot.searchTerms.filter((t) => !prevTermSet.has(t)),
      };
    }

    return res.status(200).json({
      username,
      status,
      hasCloudData: !!data,
      currentHistoryCount: currentSnapshot?.historyIds.length ?? null,
      currentSearchCount: currentSnapshot?.searchTerms.length ?? null,
      currentSnapshot,
      previousSnapshot,
      diff,
    });
  } catch (error) {
    console.error("[debug-user] エラー:", error);
    return res.status(500).json({ error: "debug failed", details: error.message });
  }
};

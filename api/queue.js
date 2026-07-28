const { kv } = require("./redis");

/**
 * queue.js - タイムパトロールの中身を見るためのAPI
 * public/index.html から呼ばれる想定。
 */
module.exports = async function handler(req, res) {
  try {
    const queue = await kv.lrange("recommend:queue", 0, -1);
    const usernames = (await kv.smembers("all_users")) || [];
    const currentUser = await kv.get("recommend:current_user");

    const users = [];
    for (const username of usernames) {
      const status = (await kv.get(`recommend:${username}:status`)) || "idle";
      let stage = null;
      if (username === currentUser) {
        const rawProgress = await kv.get(`recommend:${username}:progress`);
        const progress = rawProgress
          ? typeof rawProgress === "string"
            ? JSON.parse(rawProgress)
            : rawProgress
          : null;
        stage = progress?.stage || null;
      }
      users.push({ username, status, stage });
    }

    return res.status(200).json({ queue, currentUser, users });
  } catch (error) {
    console.error("[queue] エラー:", error);
    return res.status(500).json({ error: "queue fetch failed", details: error.message });
  }
};

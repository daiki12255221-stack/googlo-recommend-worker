const { kv } = require("./redis");

/**
 * queue.js - タイムパトロールの中身を見るためのAPI
 * public/index.html から呼ばれる想定。
 */
module.exports = async function handler(req, res) {
  try {
    const queue = await kv.lrange("recommend:queue", 0, -1);
    const usernames = (await kv.smembers("all_users")) || [];

    const users = [];
    for (const username of usernames) {
      const status = (await kv.get(`recommend:${username}:status`)) || "idle";
      users.push({ username, status });
    }

    return res.status(200).json({ queue, users });
  } catch (error) {
    console.error("[queue] エラー:", error);
    return res.status(500).json({ error: "queue fetch failed", details: error.message });
  }
};

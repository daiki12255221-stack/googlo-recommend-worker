const { kv } = require("./redis");

/**
 * migrate-users.js - 1回限りの移行スクリプト
 * ------------------------------------------------------------
 * all_users(Set)を作る前から存在していた既存アカウントを、
 * まとめて all_users に登録するための救済措置。
 *
 * 使い方: ブラウザで一度だけ /api/migrate-users を開く。
 * 何度実行しても安全（Setなので重複登録されない）。
 * ------------------------------------------------------------
 */
module.exports = async function handler(req, res) {
  try {
    // user:xxxx というキーを全部洗い出す（1回限りの移行なのでKEYS scanを許容）
    const keys = await kv.keys("user:*");

    // "user:xxxx:data" のような別種のキーは除外し、
    // "user:xxxx"（アカウント本体）だけを対象にする
    const usernames = keys
      .filter((k) => !k.includes(":", 5)) // "user:" の後ろにさらに ":" が無いものだけ
      .map((k) => k.replace(/^user:/, ""));

    if (usernames.length > 0) {
      await kv.sadd("all_users", ...usernames);
    }

    return res.status(200).json({
      success: true,
      registered: usernames,
      count: usernames.length,
    });
  } catch (error) {
    console.error("[migrate-users] エラー:", error);
    return res
      .status(500)
      .json({ error: "migration failed", details: error.message });
  }
};

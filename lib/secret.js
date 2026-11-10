// Encrypts secrets at rest (AES-256-GCM): the Zeabur API key, the client-secret
// values this app issues, and the variable snapshots a rotation can roll back to.
// Key: APP_SECRET env var if set (recommended); otherwise a random key generated
// once and kept in the settings table, so a fresh install works out of the box.
// Changing the key makes everything already stored unreadable — set APP_SECRET
// once, before the first rotation, and never change it.
const crypto = require("crypto");
const appdb = require("./appdb");

const SETTING_KEY = "secret_key";
let keyPromise = null;

function getKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      if (process.env.APP_SECRET) return crypto.createHash("sha256").update(process.env.APP_SECRET).digest();
      let s = await appdb.getSetting(SETTING_KEY, null);
      if (!s || !s.k) {
        s = { k: crypto.randomBytes(32).toString("base64") };
        await appdb.setSetting(SETTING_KEY, s);
        console.warn("APP_SECRET is not set — generated an encryption key in the database. Set APP_SECRET for production.");
      }
      return Buffer.from(s.k, "base64");
    })().catch((e) => { keyPromise = null; throw e; });
  }
  return keyPromise;
}

async function encrypt(text) {
  const key = await getKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

async function decrypt(blob) {
  if (!blob) return "";
  const raw = Buffer.from(String(blob).replace(/^v1:/, ""), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", await getKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch (e) {
    throw new Error("儲存的資料無法解密（APP_SECRET 曾被更改？） · Stored value can't be decrypted — APP_SECRET changed since it was saved.");
  }
}

module.exports = { encrypt, decrypt };

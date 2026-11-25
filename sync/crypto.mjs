import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";

// Magpie seals the usage files it shares through sync as "magpie-data"
// (internal/backup/data.go: SealData/OpenData). Reusing the same format and
// the same passphrase lets this plugin put its snapshot beside Magpie's own
// sealed files without another secret. The envelope is:
//
//   {"format":"magpie-data","version":1,"kdf":"pbkdf2-sha256",
//    "iterations":600000,"salt":"<base64>","nonce":"<base64>","data":"<base64>"}
//
// data is AES-256-GCM ciphertext followed by its 16-byte tag; the AAD is
// "magpie-data/1/pbkdf2-sha256/600000/<salt hex>".
export const DATA_FORMAT = "magpie-data";
export const ITERATIONS = 600_000;

function header(e) {
  return `${DATA_FORMAT}/${e.version}/${e.kdf}/${e.iterations}/${e.salt.toString("hex")}`;
}

function derive(pass, salt, iterations) {
  return new Promise((resolve, reject) => {
    pbkdf2(pass, salt, iterations, 32, "sha256", (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function sealData(value, passphrase) {
  if (!passphrase) throw new Error("sealing needs a passphrase");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const e = { version: 1, iterations: ITERATIONS, kdf: "pbkdf2-sha256", salt };
  const key = await derive(passphrase, salt, ITERATIONS);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(header(e), "utf8"));
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(JSON.stringify({
    format: DATA_FORMAT,
    version: 1,
    kdf: "pbkdf2-sha256",
    iterations: ITERATIONS,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    data: data.toString("base64"),
  }), "utf8");
}

export async function openData(buffer, passphrase) {
  let e;
  try {
    e = JSON.parse(Buffer.from(buffer).toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("not a magpie-data file");
  }
  if (e?.format !== DATA_FORMAT || e.version !== 1 || e.kdf !== "pbkdf2-sha256") {
    throw new Error("not a magpie-data file this version reads");
  }
  if (!Number.isInteger(e.iterations) || e.iterations < 100_000 || e.iterations > 10_000_000) {
    throw new Error("not a magpie-data file this version reads");
  }
  const salt = Buffer.from(String(e.salt || ""), "base64");
  const nonce = Buffer.from(String(e.nonce || ""), "base64");
  const sealed = Buffer.from(String(e.data || ""), "base64");
  if (salt.length < 16 || nonce.length !== 12 || sealed.length < 16) {
    throw new Error("not a magpie-data file this version reads");
  }
  const key = await derive(passphrase, salt, e.iterations);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(header({ ...e, salt }), "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new Error("the WorkBuddy snapshot cannot be opened: wrong sync passphrase, or the file was changed");
  }
  try {
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("the WorkBuddy snapshot is not valid JSON");
  }
}

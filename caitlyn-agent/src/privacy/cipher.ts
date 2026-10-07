/**
 * CAITLYN privacy ciphers.
 *
 * Format-preserving substitution implements the Category I idea from
 * Prεεmpt (Anshumaan et al., NDSS, arXiv:2504.05147): a token keeps its
 * alphabet and length, and the same key reverses it.
 * Metric Laplace noise implements Category II: numeric values that the
 * model only needs approximately are perturbed and are not reversed.
 *
 * KEYPOINT-REVIEW: the format-preserving transform is a keyed Fisher-Yates
 * permutation per character position. It is reversible and format-preserving.
 * It is not NIST FF1, and it must not be described as FF1 in the paper.
 */

import * as crypto from "node:crypto";

const DIGITS = "0123456789";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Draw a uniform number in (0, 1) from the operating-system CSPRNG.
 */
export function cryptoUnitInterval(): number {
  const buf = crypto.randomBytes(4);
  return (buf.readUInt32BE(0) + 1) / 0x100000001;
}

/**
 * Sample Laplace noise with the given scale.
 * `unit` is a uniform draw in (0, 1). The value 0.5 yields zero noise.
 */
export function laplaceNoise(scale: number, unit: number): number {
  const centered = Math.min(Math.max(unit, 1e-12), 1 - 1e-12) - 0.5;
  return -scale * Math.sign(centered) * Math.log(1 - 2 * Math.abs(centered));
}

/**
 * Build a permutation of `size` positions from the key, domain, and index.
 */
function keyedPermutation(size: number, key: Buffer, domain: string, index: number): number[] {
  const perm = Array.from({ length: size }, (_, i) => i);
  let stream = Buffer.alloc(0);
  let counter = 0;
  const nextByte = (): number => {
    if (stream.length === 0) {
      stream = crypto.createHmac("sha256", key).update(`${domain}|${index}|${counter}`).digest();
      counter += 1;
    }
    const value = stream[0];
    stream = stream.subarray(1);
    return value;
  };
  for (let i = size - 1; i > 0; i--) {
    const span = i + 1;
    const limit = 256 - (256 % span);
    let draw = nextByte();
    while (draw >= limit) draw = nextByte();
    const j = draw % span;
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  return perm;
}

/**
 * Map one alphabet character through the position permutation.
 * Characters outside the alphabet, including separators, stay in place.
 */
function mapChar(
  ch: string,
  alphabet: string,
  perm: number[],
  decrypt: boolean,
): string {
  const lower = ch.toLowerCase();
  const idx = alphabet.indexOf(lower);
  if (idx < 0) return ch;
  const mapped = decrypt ? perm.indexOf(idx) : perm[idx];
  const next = alphabet[mapped];
  return ch === lower ? next : next.toUpperCase();
}

/**
 * Apply the format-preserving transform to every in-alphabet character.
 */
export function transformToken(
  value: string,
  key: Buffer,
  alphabet: string,
  domain: string,
  decrypt: boolean,
): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const perm = keyedPermutation(alphabet.length, key, domain, i);
    out += mapChar(value[i], alphabet, perm, decrypt);
  }
  return out;
}

/**
 * Encrypt or decrypt a digit string while keeping dashes and spaces.
 */
export function transformDigits(value: string, key: Buffer, domain: string, decrypt: boolean): string {
  return transformToken(value, key, DIGITS, domain, decrypt);
}

/**
 * Encrypt or decrypt an email while keeping `@`, dots, and the final label.
 * KEYPOINT-REVIEW: the final domain label stays readable so the model can
 * still see that the token is an email. That is a deliberate utility leak.
 */
export function transformEmail(value: string, key: Buffer, decrypt: boolean): string {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) {
    return transformToken(value, key, ALNUM, "email", decrypt);
  }
  const local = transformToken(value.slice(0, at), key, ALNUM, "email-local", decrypt);
  const labels = value.slice(at + 1).split(".");
  if (labels.length < 2) {
    return `${local}@${transformToken(labels[0] ?? "", key, ALNUM, "email-domain", decrypt)}`;
  }
  const tld = labels[labels.length - 1];
  const host = labels.slice(0, -1).map((label, i) =>
    transformToken(label, key, ALNUM, `email-domain-${i}`, decrypt),
  );
  return `${local}@${host.join(".")}.${tld}`;
}

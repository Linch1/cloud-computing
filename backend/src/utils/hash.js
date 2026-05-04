import { ethers } from "ethers";

/**
 * Deterministic hash of any JS value, used to bind an off-chain JSON metadata
 * document to a single bytes32 stored on-chain. The serialization is
 * canonical (sorted keys) to guarantee that the backend and any external
 * verifier compute the same hash.
 *
 * @param {unknown} value
 * @returns {string} 0x-prefixed 32-byte hex string.
 */
export function metadataHash(value) {
  const json = canonicalStringify(value);
  return ethers.keccak256(ethers.toUtf8Bytes(json));
}

/**
 * Per-voter, per-election commitment. Reusing the same (userId, electionId,
 * salt) yields the same hash, which is what the smart contract uses as
 * uniqueness key. The salt is server-secret and must never leak.
 *
 * @param {string} userId
 * @param {string|number|bigint} electionId
 * @param {string} salt
 * @returns {string} 0x-prefixed 32-byte hex string.
 */
export function voterCommitmentHash(userId, electionId, salt) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`${userId}|${String(electionId)}|${salt}`)
  );
}

/**
 * Opaque hash of the cast ballot. The nonce makes the hash unpredictable
 * even when the option set is small.
 *
 * @param {string|number|bigint} electionId
 * @param {number} selectedOption  Index of the chosen option.
 * @param {string} nonce           0x-prefixed hex nonce (32 bytes recommended).
 * @returns {string} 0x-prefixed 32-byte hex string.
 */
export function voteHash(electionId, selectedOption, nonce) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`${String(electionId)}|${selectedOption}|${nonce}`)
  );
}

/**
 * Canonical JSON: object keys are sorted recursively, arrays preserved.
 * @param {unknown} value
 */
export function canonicalStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/**
 * Generates a 32-byte random nonce as 0x-prefixed hex.
 * @returns {string}
 */
export function randomNonce() {
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * Public exports for `@nexus-fleet/fleet-signer`.
 *
 * The fleet daemon imports the client surface to construct sign requests;
 * the binary entrypoint (`bin/fleet-signer`) handles setup + start.
 */

export { startSignerServer, type SignerServerConfig } from "./server.js";
export { encryptAndStore, loadAndDecrypt, envelopeExists, defaultEnvelopePath } from "./storage/encrypted-key.js";
export { AuditLog, defaultAuditPath, type AuditEntry } from "./audit.js";
export {
  evaluateWhitelist,
  BASE_CONTRACTS,
  AAVE_V3_SUPPLY_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  PER_TX_CAPS_USD,
  DAILY_CAP_USD,
  type SignRequest,
  type WhitelistDecision,
} from "./whitelists/index.js";

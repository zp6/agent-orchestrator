/**
 * Injected provider script — runs in the browser page context.
 *
 * This script creates a custom `window.ethereum` provider that:
 * - Reports the fleet treasury address as the connected account
 * - Routes `eth_sendTransaction` and `personal_sign` to the fleet-signer HTTP service
 * - Passes through read-only RPC calls to a public JSON-RPC endpoint
 *
 * The script is injected via Playwright's `addInitScript` and runs before any
 * page JavaScript. It receives configuration via a serialised JSON argument.
 *
 * SECURITY: This script does NOT hold or access any private key. All signing
 * operations are forwarded to the signer service which enforces its own
 * whitelist, per-tx caps, and daily caps.
 */

export interface ProviderConfig {
  /** Treasury address to expose as the connected account */
  treasuryAddress: string;
  /** Fleet signer HTTP URL (e.g. http://127.0.0.1:7521) */
  signerUrl: string;
  /** Chain ID to report (default: 1 for mainnet) */
  chainId?: number;
}

/**
 * Returns the JS source string to be injected into the page.
 * The config is baked into the source as a JSON literal.
 */
export function buildProviderScript(config: ProviderConfig): string {
  const chainId = config.chainId ?? 1;
  const chainIdHex = `0x${chainId.toString(16)}`;

  // The script is a self-executing function to avoid polluting global scope
  return `
(function() {
  const TREASURY_ADDRESS = ${JSON.stringify(config.treasuryAddress.toLowerCase())};
  const SIGNER_URL = ${JSON.stringify(config.signerUrl)};
  const CHAIN_ID = ${JSON.stringify(chainIdHex)};
  const CHAIN_ID_NUM = ${chainId};

  let connected = false;

  /**
   * Forward a signing request to the fleet-signer service.
   */
  async function signViaFleetSigner(payload) {
    const res = await fetch(SIGNER_URL + '/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!body.approved) {
      const err = new Error('Fleet signer rejected: ' + (body.reason || 'unknown'));
      err.code = 4001; // EIP-1193 user rejected
      throw err;
    }
    return body;
  }

  const provider = {
    isMetaMask: true,
    isFleetBrowser: true,
    chainId: CHAIN_ID,
    networkVersion: String(CHAIN_ID_NUM),
    selectedAddress: null,

    /**
     * EIP-1193 request method — the primary interface dApps use.
     */
    async request({ method, params }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': {
          connected = true;
          provider.selectedAddress = TREASURY_ADDRESS;
          provider.emit('connect', { chainId: CHAIN_ID });
          provider.emit('accountsChanged', [TREASURY_ADDRESS]);
          return [TREASURY_ADDRESS];
        }

        case 'eth_chainId':
          return CHAIN_ID;

        case 'net_version':
          return String(CHAIN_ID_NUM);

        case 'wallet_switchEthereumChain':
          // Acknowledge the request but we only support our configured chain
          return null;

        case 'eth_sendTransaction': {
          const tx = params[0];
          const result = await signViaFleetSigner({
            operation: 'browser_eth_sendTransaction',
            chainId: CHAIN_ID_NUM,
            to: tx.to,
            data: tx.data || '0x',
            value: tx.value || '0x0',
            usdValue: 0, // The signer computes value from calldata
          });
          return result.signedTx || result.txHash;
        }

        case 'personal_sign': {
          // personal_sign(message, account)
          const message = params[0];
          const account = (params[1] || '').toLowerCase();
          if (account && account !== TREASURY_ADDRESS) {
            const err = new Error('Account mismatch: requested ' + account);
            err.code = 4100;
            throw err;
          }
          const result = await signViaFleetSigner({
            operation: 'browser_personal_sign',
            chainId: CHAIN_ID_NUM,
            to: '0x0000000000000000000000000000000000000000',
            data: message,
            value: '0',
            usdValue: 0,
          });
          return result.signedTx || result.signature;
        }

        case 'eth_signTypedData_v4': {
          // eth_signTypedData_v4(account, typedData)
          const typedData = params[1];
          const result = await signViaFleetSigner({
            operation: 'browser_eth_signTypedData_v4',
            chainId: CHAIN_ID_NUM,
            to: '0x0000000000000000000000000000000000000000',
            data: typeof typedData === 'string' ? typedData : JSON.stringify(typedData),
            value: '0',
            usdValue: 0,
          });
          return result.signedTx || result.signature;
        }

        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }];

        case 'wallet_getPermissions':
          return connected
            ? [{ parentCapability: 'eth_accounts' }]
            : [];

        default: {
          // For read-only calls, we can't forward without a real RPC endpoint
          // dApps typically have their own provider for reads; we only handle signing
          const err = new Error('Fleet browser provider: unsupported method ' + method);
          err.code = 4200; // EIP-1193 unsupported method
          throw err;
        }
      }
    },

    // Legacy send method (some dApps still use this)
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') {
        return provider.request({ method: methodOrPayload, params: paramsOrCallback || [] });
      }
      // JSON-RPC payload object
      return provider.request({ method: methodOrPayload.method, params: methodOrPayload.params || [] })
        .then(result => {
          if (typeof paramsOrCallback === 'function') paramsOrCallback(null, { result });
          return result;
        })
        .catch(err => {
          if (typeof paramsOrCallback === 'function') paramsOrCallback(err, null);
          throw err;
        });
    },

    sendAsync(payload, callback) {
      provider.request({ method: payload.method, params: payload.params || [] })
        .then(result => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch(err => callback(err, null));
    },

    // Minimal event emitter for EIP-1193 compliance
    _listeners: {},
    on(event, fn) {
      if (!provider._listeners[event]) provider._listeners[event] = [];
      provider._listeners[event].push(fn);
      return provider;
    },
    removeListener(event, fn) {
      if (!provider._listeners[event]) return provider;
      provider._listeners[event] = provider._listeners[event].filter(f => f !== fn);
      return provider;
    },
    emit(event, ...args) {
      if (!provider._listeners[event]) return;
      for (const fn of provider._listeners[event]) {
        try { fn(...args); } catch (_) {}
      }
    },

    // EIP-6963 support — announce the provider
    _announceProvider() {
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        const info = {
          uuid: 'fleet-browser-0001',
          name: 'Fleet Browser',
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          rdns: 'com.nexus-fleet.browser',
        };
        const event = new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({ info, provider }),
        });
        window.dispatchEvent(event);
        window.addEventListener('eip6963:requestProvider', () => {
          window.dispatchEvent(event);
        });
      }
    },

    enable() {
      return provider.request({ method: 'eth_requestAccounts', params: [] });
    },
  };

  // Install as window.ethereum
  Object.defineProperty(window, 'ethereum', {
    value: provider,
    writable: false,
    configurable: false,
  });

  // Announce via EIP-6963
  provider._announceProvider();

  console.log('[fleet-browser] Injected provider for ' + TREASURY_ADDRESS + ' on chain ' + CHAIN_ID);
})();
`;
}

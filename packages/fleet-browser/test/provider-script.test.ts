/**
 * Unit tests for buildProviderScript.
 *
 * These tests verify the generated script string contains the correct
 * configuration values. They do not require a browser or Playwright.
 */

import { describe, it, expect } from "vitest";
import { buildProviderScript } from "../src/provider-script.js";

const TREASURY = "0x468EC325C5E5059032aB62b613FE132e0a97EA05";
const SIGNER_URL = "http://127.0.0.1:7521";

describe("buildProviderScript", () => {
  it("returns a non-empty string", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(100);
  });

  it("injects the treasury address lowercased", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain(TREASURY.toLowerCase());
  });

  it("injects the signer URL", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain(SIGNER_URL);
  });

  it("defaults to chain ID 1 (mainnet)", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain('"0x1"'); // chainIdHex
  });

  it("uses the specified chain ID", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
      chainId: 8453, // Base
    });
    const expectedHex = "0x" + (8453).toString(16); // "0x20f5"
    expect(script).toContain(JSON.stringify(expectedHex));
  });

  it("contains isFleetBrowser flag", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain("isFleetBrowser");
  });

  it("contains isMetaMask flag for dApp compatibility", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain("isMetaMask");
  });

  it("handles EIP-1193 method names", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain("eth_requestAccounts");
    expect(script).toContain("eth_accounts");
    expect(script).toContain("eth_sendTransaction");
    expect(script).toContain("personal_sign");
    expect(script).toContain("eth_signTypedData_v4");
  });

  it("routes signing to the signer endpoint", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    // The provider forwards signing to SIGNER_URL + '/sign'
    expect(script).toContain("/sign");
  });

  it("supports EIP-6963 provider announcement", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain("eip6963:announceProvider");
  });

  it("is a self-executing function (IIFE)", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script.trimStart()).toMatch(/^\(function\(\)/);
  });

  it("installs on window.ethereum", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain("window.ethereum");
  });

  it("writable:false on window.ethereum to prevent overwrite", () => {
    const script = buildProviderScript({
      treasuryAddress: TREASURY,
      signerUrl: SIGNER_URL,
    });
    expect(script).toContain("writable: false");
  });
});

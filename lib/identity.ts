/**
 * Identity management: npub/secondary secret handling
 * All localStorage keys are scoped by npub fingerprint for isolation
 * Note: Player ID is not cached locally - it's always fetched from relay
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearHistory } from "./history";

const STORAGE_PREFIX = "com.audioplayer";

// Top-level keys (not fingerprint-scoped)
const NPUB_KEY = `${STORAGE_PREFIX}.npub`;

export interface IdentityState {
    npub: string;
    pubkeyHex: string;
    playerId: string | null;
    hasSecondarySecret: boolean;
}

// =============================================================================
// Storage Scope (Fingerprint)
// =============================================================================

/**
 * Get storage scope key for AsyncStorage isolation (first 32 hex chars / 128 bits of SHA-256 of pubkey)
 */
export function getStorageScope(pubkeyHex: string): string {
    // Validate input
    if (!pubkeyHex || typeof pubkeyHex !== "string") {
        throw new Error("Invalid pubkeyHex: must be a non-empty string");
    }
    if (!/^[0-9a-fA-F]+$/.test(pubkeyHex)) {
        throw new Error("Invalid pubkeyHex: must contain only hexadecimal characters");
    }
    if (pubkeyHex.length !== 64) {
        throw new Error("Invalid pubkeyHex: expected 64 hex characters (32 bytes)");
    }

    const data = utf8ToBytes(pubkeyHex);
    const hashBytes = sha256(data);
    const hashHex = bytesToHex(hashBytes);
    return hashHex.slice(0, 32);
}

// =============================================================================
// npub Storage (Top-Level)
// =============================================================================

/**
 * Get saved npub from AsyncStorage
 */
export async function getSavedNpub(): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(NPUB_KEY);
    } catch (err) {
        console.warn("Failed to read npub:", err);
        return null;
    }
}

/**
 * Save npub to AsyncStorage
 */
export async function saveNpub(npub: string): Promise<void> {
    try {
        await AsyncStorage.setItem(NPUB_KEY, npub);
    } catch (err) {
        console.warn("Failed to save npub:", err);
        throw err;
    }
}

/**
 * Clear npub from AsyncStorage
 */
export async function clearNpub(): Promise<void> {
    try {
        await AsyncStorage.removeItem(NPUB_KEY);
    } catch (err) {
        console.warn("Failed to clear npub:", err);
    }
}

// =============================================================================
// Secondary Secret Management (Fingerprint-Scoped)
// =============================================================================

function getSecondarySecretKey(fingerprint: string): string {
    return `${STORAGE_PREFIX}.secondary-secret.${fingerprint}`;
}

/**
 * Get secondary secret from AsyncStorage for a given npub fingerprint
 */
export async function getSecondarySecret(fingerprint: string): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(getSecondarySecretKey(fingerprint));
    } catch (err) {
        console.warn("Failed to read secondary secret:", err);
        return null;
    }
}

/**
 * Store secondary secret in AsyncStorage
 */
export async function setSecondarySecret(fingerprint: string, secret: string): Promise<void> {
    try {
        await AsyncStorage.setItem(getSecondarySecretKey(fingerprint), secret);
    } catch (err) {
        console.warn("Failed to save secondary secret:", err);
        throw err;
    }
}

/**
 * Clear secondary secret from AsyncStorage
 */
export async function clearSecondarySecret(fingerprint: string): Promise<void> {
    try {
        await AsyncStorage.removeItem(getSecondarySecretKey(fingerprint));
    } catch (err) {
        console.warn("Failed to clear secondary secret:", err);
    }
}

// =============================================================================
// Clear All Identity Data
// =============================================================================

/**
 * Clear all identity-related data for a given fingerprint
 * Call this on logout
 */
export async function clearAllIdentityData(fingerprint: string): Promise<void> {
    try {
        await clearSecondarySecret(fingerprint);
        await clearNpub();
        await clearHistory();
    } catch (err) {
        console.warn("Failed to clear all identity data:", err);
        throw err;
    }
}

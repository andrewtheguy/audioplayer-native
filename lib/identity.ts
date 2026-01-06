/**
 * Identity management: npub/secondary secret handling
 * Single session app - no multi-user scoping needed
 * Note: Player ID is not cached locally - it's always fetched from relay
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearHistory } from "./history";

const STORAGE_PREFIX = "com.audioplayer";

const NPUB_KEY = `${STORAGE_PREFIX}.npub`;
const SECONDARY_SECRET_KEY = `${STORAGE_PREFIX}.secondary-secret`;

export interface IdentityState {
    npub: string;
    pubkeyHex: string;
    playerId: string | null;
    hasSecondarySecret: boolean;
}

// =============================================================================
// npub Storage
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
 * @throws Error if AsyncStorage operation fails
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
 * @throws Error if AsyncStorage operation fails
 */
export async function clearNpub(): Promise<void> {
    try {
        await AsyncStorage.removeItem(NPUB_KEY);
    } catch (err) {
        console.warn("Failed to clear npub:", err);
        throw err;
    }
}

// =============================================================================
// Secondary Secret Management
// =============================================================================

/**
 * Get secondary secret from AsyncStorage
 */
export async function getSecondarySecret(): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(SECONDARY_SECRET_KEY);
    } catch (err) {
        console.warn("Failed to read secondary secret:", err);
        return null;
    }
}

/**
 * Store secondary secret in AsyncStorage
 * @throws Error if AsyncStorage operation fails
 */
export async function setSecondarySecret(secret: string): Promise<void> {
    try {
        await AsyncStorage.setItem(SECONDARY_SECRET_KEY, secret);
    } catch (err) {
        console.warn("Failed to save secondary secret:", err);
        throw err;
    }
}

/**
 * Clear secondary secret from AsyncStorage
 * @throws Error if AsyncStorage operation fails
 */
export async function clearSecondarySecret(): Promise<void> {
    try {
        await AsyncStorage.removeItem(SECONDARY_SECRET_KEY);
    } catch (err) {
        console.warn("Failed to clear secondary secret:", err);
        throw err;
    }
}

// =============================================================================
// Clear All Identity Data
// =============================================================================

/**
 * Clear all identity-related data
 * Call this on logout
 * @throws Error if any AsyncStorage operation fails
 */
export async function clearAllIdentityData(): Promise<void> {
    try {
        await clearSecondarySecret();
        await clearNpub();
        await clearHistory();
    } catch (err) {
        console.warn("Failed to clear all identity data:", err);
        throw err;
    }
}

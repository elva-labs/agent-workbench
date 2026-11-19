// Runs before any part of the app is loaded, so the window's stored state
// is under Chord's names before a store reads it.
import { migrateStorage } from "$lib/migrate";

migrateStorage(localStorage);

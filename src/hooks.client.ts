// Runs before any part of the app is loaded, so the window's stored state
// is under Chord's names before a store reads it.
import type { ClientInit } from "@sveltejs/kit";
import { core } from "$lib/core";
import { migrateStorage } from "$lib/migrate";

export const init: ClientInit = () => migrateStorage(localStorage, () => core().orchestratorDir());

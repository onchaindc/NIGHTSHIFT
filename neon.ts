import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  preview: {
    realtime: true,
  },
  auth: true,
  // Object storage: private bucket for app/branch-scoped file uploads
  // (branch-scoped, copy-on-write with the database).
  buckets: {
    "nightshift-files": {},
  },
  // aiGateway was removed: the Neon Free plan does not include it, and a
  // non-serving gateway deployment blocks `neon deploy` from finishing all
  // of the other services. Re-add once the org upgrades to a paid plan.
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});

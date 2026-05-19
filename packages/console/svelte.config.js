import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // The console is an internal, LAN-hosted admin panel — a long-running
    // Node server, not a serverless deploy like the public catalog.
    adapter: adapter(),
    alias: {
      // Make the Houdini-generated runtime resolvable by both Vite and the
      // SvelteKit-generated tsconfig.
      $houdini: "./$houdini",
    },
  },
};

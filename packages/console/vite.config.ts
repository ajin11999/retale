import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import houdini from "houdini/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // houdini() must come before sveltekit() — it generates the $houdini
  // runtime that the SvelteKit routes import.
  plugins: [houdini(), tailwindcss(), sveltekit()],
});

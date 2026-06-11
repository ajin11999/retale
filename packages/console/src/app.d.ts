// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}

    interface Locals {
      /** Fresh access token from hooks.server.ts, null when logged out. */
      accessToken: string | null;
    }
  }
}

export {};

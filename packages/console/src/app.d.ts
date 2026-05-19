// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}

    /** Houdini session — carries the JWT to the GraphQL client. */
    interface Session {
      token?: string;
    }
  }
}

export {};

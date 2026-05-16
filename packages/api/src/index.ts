import { Elysia } from "elysia";
import { createYoga } from "graphql-yoga";
import { buildContext } from "./lib/context.ts";
import { env } from "./lib/env.ts";
import { schema } from "./schema/index.ts";

const yoga = createYoga({
  schema,
  context: ({ request }) => buildContext({ request }),
  graphqlEndpoint: "/graphql",
  graphiql: env.isDev,
});

const app = new Elysia()
  .get("/", () => ({ name: "retale-api", status: "ok" }))
  .mount(yoga)
  .listen(env.port);

console.log(`retale-api listening on http://localhost:${env.port} (GraphQL at /graphql)`);

export type App = typeof app;

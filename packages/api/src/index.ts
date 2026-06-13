import { Elysia } from "elysia";
import { createYoga } from "graphql-yoga";
import { businessLogoRoute } from "./http/business-logo-route.ts";
import { invoiceRecognitionRoute } from "./http/invoice-recognition-route.ts";
import { journalCsvRoute } from "./http/journal-csv-route.ts";
import { orderReceiptRoute } from "./http/order-receipt-route.ts";
import { productImagesRoute } from "./http/product-images-route.ts";
import { purchasePdfRoute } from "./http/purchase-pdf-route.ts";
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
  .use(productImagesRoute)
  .use(invoiceRecognitionRoute)
  .use(businessLogoRoute)
  .use(purchasePdfRoute)
  .use(orderReceiptRoute)
  .use(journalCsvRoute)
  .mount(yoga)
  .listen(env.port);

console.log(`retale-api listening on http://localhost:${env.port} (GraphQL at /graphql)`);

export type App = typeof app;

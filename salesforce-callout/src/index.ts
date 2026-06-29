import "dotenv/config";
import { loadConfig } from "./config.js";
import { SalesforceClient } from "./salesforce/client.js";
import { SalesforceError } from "./salesforce/types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SalesforceClient(config);

  const calloutPath =
    process.env.SF_CALLOUT_PATH?.trim() || "/sobjects/Account/describe";

  console.log(`Calling Salesforce: GET ${calloutPath}`);

  const result = await client.callout({
    method: "GET",
    path: calloutPath,
  });

  console.log(`Status: ${result.status}`);
  console.log(JSON.stringify(result.data, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof SalesforceError) {
    console.error(`Salesforce error (${error.status}):`, error.message);
    if (error.body) {
      console.error(JSON.stringify(error.body, null, 2));
    }
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
